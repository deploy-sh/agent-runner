/**
 * Agentic loop — the core of agent-runner.
 *
 * Architecture:
 *   runLoop(prompt) → builds messages[] → runTurn() → save session → emit done
 *   runTurn()       → LLM call → parse tool_calls → execute in parallel → append results → repeat
 *
 * Key behaviours:
 *   - Streaming: in interactive mode (!jsonMode), chunks are written to stdout as they arrive.
 *     In JSON mode, the full response is awaited and emitted as a single text event.
 *   - Parallel tool execution: all tool calls from one LLM response run via Promise.all,
 *     so three read_file calls complete in ~1× latency instead of 3×.
 *   - Tool result cache: read-only tools (read_file, list_dir, grep) are cached 60 s by ToolCache.
 *     Write tools bypass the cache and also invalidate stale entries for the same key.
 *   - MCP tools: if an MCPClient is connected, its tools are merged into allTools and dispatched
 *     via mcpClient.callTool() when the LLM selects an "mcp_*" tool name.
 *   - Fallback mode: for models without native tool_calls, extractFallbackToolCalls() parses
 *     <tool_call>{...}</tool_call> tags from text content and executes them identically.
 *   - Auto-compression: when the context reaches 80 % of config.contextTokens, compressHistory()
 *     summarises old turns and replaces them with a single summary message, keeping the 6 most recent.
 *
 * Session persistence:
 *   Sessions are stored in ~/.agent-runner/sessions/<id>.json (last 40 messages).
 *   loadSession() / saveSession() handle read and write.
 */
import OpenAI from 'openai'
import type { ChatCompletionMessageParam, ChatCompletionChunk } from 'openai/resources/chat/completions'
import { Config, emit } from './types'
import { openAITools, executeTool } from './tools'
import { ToolCache } from './cache'
import { totalTokens, shouldCompress, compressHistory, contextPercent } from './tokens'
import { MCPClient } from './mcp-client'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export const DEFAULT_SYSTEM = `You are a helpful AI assistant with access to tools.
You can execute shell commands, read and write files, search the web, and make HTTP requests.
Work in the project directory unless told otherwise.
Be concise and practical.

Rules:
- For ANY question about system state (disk usage, memory, CPU, processes, network, uptime) — use bash immediately. Never guess.
- For file questions — use read_file or list_dir, not bash ls/cat.
- For code searches — use grep.
- When multiple independent tasks are needed — call several tools in one response.
- To remember something for future sessions — use memory_write.
- Before answering questions about past decisions or work — call memory_search first.`

// Fallback system prompt for models without native tool_calls
const FALLBACK_SYSTEM_SUFFIX = `

When you need to use a tool, output it on its own line in this exact format:
<tool_call>{"name": "tool_name", "args": {"param": "value"}}</tool_call>

Wait for the tool result before continuing. Available tools:
`

const SESSIONS_DIR = path.join(os.homedir(), '.agent-runner', 'sessions')

export function loadSession(sessionId: string): ChatCompletionMessageParam[] {
  const file = path.join(SESSIONS_DIR, `${sessionId}.json`)
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  }
  return []
}

export function saveSession(sessionId: string, messages: ChatCompletionMessageParam[]): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  const trimmed = messages.slice(-40)
  fs.writeFileSync(path.join(SESSIONS_DIR, `${sessionId}.json`), JSON.stringify(trimmed))
}

export function generateSessionId(): string {
  return `ar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function createClient(config: Config): OpenAI {
  return new OpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey })
}

// Extract tool calls from text (fallback mode for models without native tool_calls)
function extractFallbackToolCalls(text: string): Array<{ name: string; args: Record<string, unknown> }> {
  const pattern = /<tool_call>([\s\S]*?)<\/tool_call>/g
  const matches = [...text.matchAll(pattern)]
  if (matches.length === 0) return []

  return matches.flatMap(m => {
    try {
      const parsed = JSON.parse(m[1].trim())
      if (parsed.name) return [{ name: parsed.name, args: parsed.args ?? {} }]
    } catch { /* ignore */ }
    return []
  })
}

interface ToolCall {
  id: string
  function: { name: string; arguments: string }
}

// Execute tool calls in parallel, return results with IDs
async function executeToolCallsParallel(
  toolCalls: ToolCall[],
  config: Config,
  cache: ToolCache,
  mcpClient: MCPClient | null
): Promise<Array<{ id: string; name: string; content: string; error: boolean }>> {
  return Promise.all(toolCalls.map(async (call) => {
    const name = call.function.name
    let args: Record<string, unknown> = {}
    try { args = JSON.parse(call.function.arguments) } catch { /* ignore */ }

    emit({ type: 'tool_call', name, args }, config.jsonMode)

    // Check cache first
    const cached = cache.get(name, args)
    if (cached) {
      emit({ type: 'tool_result', name, content: `[cached] ${cached.content.slice(0, 200)}`, error: cached.error }, config.jsonMode)
      return { id: call.id, name, ...cached }
    }

    // MCP tool?
    let result: { content: string; error: boolean }
    if (name.startsWith('mcp_') && mcpClient) {
      result = await mcpClient.callTool(name, args)
    } else {
      result = executeTool(name, args, config.projectRoot, config.memoryDir)
    }

    cache.set(name, args, result)
    emit({ type: 'tool_result', name, content: result.content.slice(0, 200), error: result.error }, config.jsonMode)

    return { id: call.id, name, ...result }
  }))
}

/**
 * Run one agentic turn: LLM → tools → LLM → ... → final answer.
 * Supports:
 * - Streaming in interactive mode
 * - Parallel tool execution
 * - Tool result caching
 * - MCP tools
 * - Fallback for models without tool_calls
 */
export async function runTurn(
  client: OpenAI,
  messages: ChatCompletionMessageParam[],
  config: Config,
  cache: ToolCache,
  mcpClient: MCPClient | null = null
): Promise<ChatCompletionMessageParam[]> {
  const builtinTools = openAITools()
  const mcpTools = mcpClient ? mcpClient.toOpenAITools() : []
  const allTools = [...builtinTools, ...mcpTools]

  let iterations = 0
  const current = [...messages]

  while (iterations < config.maxIterations) {
    iterations++

    // Auto-compress if context getting full
    if (shouldCompress(current, config) && current.filter(m => m.role !== 'system').length > 8) {
      if (!config.jsonMode) process.stdout.write('\n[Auto-compressing context...]\n')
      const { messages: compressed, savedTokens } = await compressHistory(client, current, config)
      current.length = 0
      current.push(...compressed)
      if (!config.jsonMode) process.stdout.write(`[Saved ~${savedTokens} tokens]\n\n`)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let assistantMsg: any

    if (config.jsonMode) {
      // Non-streaming for JSON mode
      const response = await client.chat.completions.create({
        model: config.model,
        messages: current,
        tools: config.useFallback ? undefined : allTools,
        tool_choice: config.useFallback ? undefined : 'auto'
      })
      assistantMsg = response.choices[0].message
      if (assistantMsg.content) {
        emit({ type: 'text', content: assistantMsg.content }, true)
      }
    } else {
      // Streaming for interactive mode
      const streamParams: Parameters<typeof client.chat.completions.create>[0] = {
        model: config.model,
        messages: current,
        stream: true,
        ...(config.useFallback ? {} : { tools: allTools, tool_choice: 'auto' as const })
      }

      const stream = await client.chat.completions.create(streamParams) as AsyncIterable<ChatCompletionChunk>

      let content = ''
      const toolCallsAcc: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = []

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta
        if (!delta) continue

        if (delta.content) {
          content += delta.content
          process.stdout.write(delta.content)
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            if (!toolCallsAcc[idx]) {
              toolCallsAcc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } }
            }
            if (tc.id) toolCallsAcc[idx].id = tc.id
            if (tc.function?.name) toolCallsAcc[idx].function.name += tc.function.name
            if (tc.function?.arguments) toolCallsAcc[idx].function.arguments += tc.function.arguments
          }
        }
      }

      assistantMsg = {
        role: 'assistant',
        content: content || null,
        tool_calls: toolCallsAcc.length > 0 ? toolCallsAcc : undefined
      }
    }

    current.push(assistantMsg as ChatCompletionMessageParam)

    // Check for tool calls (native OR fallback text-based)
    let toolCalls: ToolCall[] = assistantMsg.tool_calls ?? []

    // Fallback: parse <tool_call> tags from text content
    if (toolCalls.length === 0 && assistantMsg.content && config.useFallback) {
      const parsed = extractFallbackToolCalls(assistantMsg.content as string)
      if (parsed.length > 0) {
        toolCalls = parsed.map((t, i) => ({
          id: `fallback-${i}`,
          function: { name: t.name, arguments: JSON.stringify(t.args) }
        }))
      }
    }

    if (toolCalls.length === 0) break

    // Execute all tool calls in parallel
    if (!config.jsonMode) process.stdout.write('\n')
    const results = await executeToolCallsParallel(toolCalls, config, cache, mcpClient)

    // Add tool results to messages
    for (const result of results) {
      current.push({
        role: 'tool',
        tool_call_id: result.id,
        content: result.content
      })
    }
  }

  return current
}

/**
 * Single-shot mode: one prompt → agentic loop → save session → done event.
 */
export async function runLoop(
  prompt: string,
  config: Config,
  mcpClient: MCPClient | null = null
): Promise<void> {
  const client = createClient(config)
  const sessionId = config.sessionId ?? generateSessionId()
  const history = config.sessionId ? loadSession(config.sessionId) : []
  const cache = new ToolCache()

  const systemContent = buildSystemPrompt(config, mcpClient)

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemContent },
    ...history,
    { role: 'user', content: prompt }
  ]

  const updated = await runTurn(client, messages, config, cache, mcpClient)

  const toSave = updated.filter(m => m.role !== 'system')
  saveSession(sessionId, toSave)

  emit({ type: 'done', session_id: sessionId }, config.jsonMode)
}

export function buildSystemPrompt(config: Config, mcpClient: MCPClient | null = null): string {
  let system = config.systemPrompt ?? DEFAULT_SYSTEM

  if (config.useFallback) {
    const toolNames = openAITools().map(t => `- ${t.function.name}: ${t.function.description}`).join('\n')
    system += FALLBACK_SYSTEM_SUFFIX + toolNames
  }

  return system
}

export function contextStats(messages: ChatCompletionMessageParam[], config: Config): string {
  const tokens = totalTokens(messages)
  const pct = contextPercent(messages, config)
  const limit = config.contextTokens ?? 32_000
  return `~${tokens.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct}%)`
}

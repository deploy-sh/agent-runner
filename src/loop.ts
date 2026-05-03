import OpenAI from 'openai'
import type { ChatCompletionMessageParam, ChatCompletionChunk } from 'openai/resources/chat/completions'
import { Config, emit } from './types'
import { openAITools, executeTool } from './tools'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export const DEFAULT_SYSTEM = `You are a helpful AI assistant with access to tools.
You can execute shell commands, read and write files, search in files, and make HTTP requests.
Work in the project directory unless told otherwise.
Be concise and practical. When using tools, explain briefly what you are doing.`

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

// Accumulated tool call from streaming chunks
interface AccToolCall {
  id: string
  type: string
  function: { name: string; arguments: string }
}

/**
 * Run one agentic turn: LLM → tools → LLM → ... → final answer.
 * Returns updated messages array.
 * Streams text to stdout when not in jsonMode.
 */
export async function runTurn(
  client: OpenAI,
  messages: ChatCompletionMessageParam[],
  config: Config
): Promise<ChatCompletionMessageParam[]> {
  const tools = openAITools()
  let iterations = 0
  const current = [...messages]

  while (iterations < config.maxIterations) {
    iterations++

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let assistantMsg: any

    if (config.jsonMode) {
      // Non-streaming: emit full text event at once (for aiclaw JSON parser)
      const response = await client.chat.completions.create({
        model: config.model,
        messages: current,
        tools,
        tool_choice: 'auto'
      })
      assistantMsg = response.choices[0].message
      if (assistantMsg.content) {
        emit({ type: 'text', content: assistantMsg.content }, true)
      }
    } else {
      // Streaming: write text chunks to stdout as they arrive
      const stream = await client.chat.completions.create({
        model: config.model,
        messages: current,
        tools,
        tool_choice: 'auto',
        stream: true
      }) as AsyncIterable<ChatCompletionChunk>

      let content = ''
      const toolCallsAcc: AccToolCall[] = []

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

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      break
    }

    // Execute tool calls (shared between streaming and non-streaming)
    for (const call of assistantMsg.tool_calls) {
      const name = call.function.name
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.function.arguments)
      } catch { /* ignore */ }

      emit({ type: 'tool_call', name, args }, config.jsonMode)

      const result = executeTool(name, args, config.projectRoot)

      emit({
        type: 'tool_result',
        name,
        content: result.content,
        error: result.error
      }, config.jsonMode)

      current.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result.content
      })
    }
  }

  return current
}

/**
 * Single-shot mode: one prompt → agentic loop → save session → done event.
 */
export async function runLoop(prompt: string, config: Config): Promise<void> {
  const client = createClient(config)
  const sessionId = config.sessionId ?? generateSessionId()
  const history = config.sessionId ? loadSession(config.sessionId) : []

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: config.systemPrompt ?? DEFAULT_SYSTEM },
    ...history,
    { role: 'user', content: prompt }
  ]

  const updated = await runTurn(client, messages, config)

  const toSave = updated.filter(m => m.role !== 'system')
  saveSession(sessionId, toSave)

  emit({ type: 'done', session_id: sessionId }, config.jsonMode)
}

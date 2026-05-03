import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { Config, Event, emit } from './types'
import { openAITools, executeTool } from './tools'

const DEFAULT_SYSTEM = `You are a helpful AI assistant with access to tools.
You can execute shell commands, read and write files, and make HTTP requests.
Work in the project directory unless told otherwise.
Be concise and practical. When using tools, explain briefly what you are doing.`

interface Session {
  id: string
  messages: ChatCompletionMessageParam[]
}

// In-memory session store (for --resume support in same process)
// For persistent sessions across invocations, session is read/written to ~/.agent-runner/sessions/
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const SESSIONS_DIR = path.join(os.homedir(), '.agent-runner', 'sessions')

function loadSession(sessionId: string): ChatCompletionMessageParam[] {
  const file = path.join(SESSIONS_DIR, `${sessionId}.json`)
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  }
  return []
}

function saveSession(sessionId: string, messages: ChatCompletionMessageParam[]): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  // Keep last 40 messages to avoid context overflow
  const trimmed = messages.slice(-40)
  fs.writeFileSync(path.join(SESSIONS_DIR, `${sessionId}.json`), JSON.stringify(trimmed))
}

function generateSessionId(): string {
  return `ar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export async function runLoop(prompt: string, config: Config): Promise<void> {
  const client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey
  })

  const sessionId = config.sessionId ?? generateSessionId()
  const history = config.sessionId ? loadSession(config.sessionId) : []

  const systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: prompt }
  ]

  const tools = openAITools()
  let iterations = 0

  while (iterations < config.maxIterations) {
    iterations++

    const response = await client.chat.completions.create({
      model: config.model,
      messages,
      tools,
      tool_choice: 'auto'
    })

    const msg = response.choices[0].message
    messages.push(msg as ChatCompletionMessageParam)

    if (msg.content) {
      emitEv({ type: 'text', content: msg.content }, config.jsonMode)
    }

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // Model is done
      break
    }

    // Execute tool calls
    for (const call of msg.tool_calls) {
      const name = call.function.name
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.function.arguments)
      } catch {
        // ignore parse error
      }

      emitEv({ type: 'tool_call', name, args }, config.jsonMode)

      const result = executeTool(name, args, config.projectRoot)

      emitEv({
        type: 'tool_result',
        name,
        content: result.content,
        error: result.error
      }, config.jsonMode)

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result.content
      })
    }
  }

  // Save session (without system prompt)
  const toSave = messages.filter(m => m.role !== 'system')
  saveSession(sessionId, toSave)

  emitEv({ type: 'done', session_id: sessionId }, config.jsonMode)
}

function emitEv(event: Event, jsonMode: boolean): void {
  emit(event, jsonMode)
}

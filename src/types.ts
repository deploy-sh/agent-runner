export interface Config {
  baseUrl: string
  apiKey: string
  model: string
  sessionId?: string
  jsonMode: boolean
  maxIterations: number
  projectRoot: string
  systemPrompt?: string
  forceWizard?: boolean
}

// JSON event types (stdout stream — compatible with aiclaw parser)
export type Event =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; content: string; error?: boolean }
  | { type: 'done'; session_id: string }
  | { type: 'error'; message: string }

export function emit(event: Event, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(event) + '\n')
  } else {
    if (event.type === 'text') process.stdout.write(event.content)
    if (event.type === 'tool_call') process.stderr.write(`[${event.name}] ${JSON.stringify(event.args)}\n`)
    if (event.type === 'tool_result') process.stderr.write(`→ ${event.content.slice(0, 200)}\n`)
    if (event.type === 'error') process.stderr.write(`ERROR: ${event.message}\n`)
    if (event.type === 'done') process.stdout.write('\n')
  }
}

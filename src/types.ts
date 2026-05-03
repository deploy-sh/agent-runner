/**
 * Core types and event emitter for agent-runner.
 *
 * Config is passed through the entire call chain (main → loop → tools).
 * Event is the JSON wire format emitted to stdout in --json mode,
 * and parsed by aiclaw / spawn_agent consumers.
 */

/** Runtime configuration for an agent session. */
export interface Config {
  /** OpenAI-compatible API base URL (e.g. https://openrouter.ai/api/v1). */
  baseUrl: string

  /** API key for the LLM provider. */
  apiKey: string

  /** Model name as understood by the provider (e.g. qwen/qwen3-235b-a22b). */
  model: string

  /**
   * Session ID for history continuity.
   * If provided, prior messages are loaded from ~/.agent-runner/sessions/<id>.json.
   */
  sessionId?: string

  /**
   * JSON event stream mode.
   * true  → emit newline-delimited JSON to stdout (for programmatic consumers).
   * false → stream text directly, tool calls to stderr (for interactive use).
   */
  jsonMode: boolean

  /** Maximum number of LLM + tool-call iterations per turn. Prevents runaway loops. */
  maxIterations: number

  /** Working directory passed to tool executors (bash, read_file, python_exec, etc.). */
  projectRoot: string

  /**
   * System prompt override.
   * If omitted, DEFAULT_SYSTEM from loop.ts is used.
   * Priority: --system-file > --system > AGENT_SYSTEM_FILE env > AGENT_SYSTEM env > default.
   */
  systemPrompt?: string

  /** If true, force the setup wizard on next launch (--setup flag). */
  forceWizard?: boolean

  /**
   * Context window size in tokens. Used to trigger auto-compression.
   * Auto-compress fires at 80% of this limit.
   * Default: 32000 (conservative; use --context for large-context models like Qwen 128k).
   */
  contextTokens?: number

  /**
   * Fallback mode for models without native tool_calls support.
   * true  → tools are described in the system prompt; the model outputs
   *          <tool_call>{...}</tool_call> tags parsed from text responses.
   * false → native function calling via the tools[] API parameter (default).
   */
  useFallback?: boolean

  /**
   * MCP (Model Context Protocol) server SSE URL.
   * If set, agent-runner connects at startup and adds the server's tools
   * to the tool list prefixed with "mcp_" (e.g. mcp_search_issues).
   * Example: http://localhost:3000/sse or https://mcp.example.com/sse
   */
  mcpUrl?: string
}

/**
 * JSON event union — the wire format for --json mode.
 *
 * Events are emitted as newline-delimited JSON to stdout.
 * aiclaw and spawn_agent parse this stream to display progress and collect results.
 *
 * @example
 * {"type":"text","content":"Checking disk usage..."}
 * {"type":"tool_call","name":"bash","args":{"command":"df -h"}}
 * {"type":"tool_result","name":"bash","content":"Filesystem...","error":false}
 * {"type":"done","session_id":"ar-1714900000-abc123"}
 */
export type Event =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; content: string; error?: boolean }
  | { type: 'done'; session_id: string }
  | { type: 'error'; message: string }

/**
 * Emit an event to the appropriate output stream.
 *
 * In JSON mode: writes a JSON line to stdout (pipe-friendly, parseable by consumers).
 * In interactive mode: text → stdout directly (for streaming display),
 *   tool calls/results → stderr so they don't pollute redirected stdout.
 */
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

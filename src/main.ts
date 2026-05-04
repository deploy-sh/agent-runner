#!/usr/bin/env node
/**
 * agent-runner — standalone agentic loop CLI
 *
 * Entry point: parses CLI args → loads .env → optionally runs setup wizard →
 * optionally connects MCP server → routes to runRepl() or runLoop().
 *
 * Usage:
 *   agent-runner                        interactive REPL (no prompt given)
 *   agent-runner "do something"         single-shot mode
 *   agent-runner --resume SESSION_ID    resume session in REPL or single-shot
 *   agent-runner --help
 *
 * Options:
 *   --model MODEL        LLM model name (overrides AGENT_MODEL)
 *   --baseurl URL        API base URL (overrides AGENT_BASEURL)
 *   --json               Output newline-delimited JSON events to stdout (disables REPL/streaming)
 *   --resume SESSION     Resume a previous session by ID (loads ~/.agent-runner/sessions/<id>.json)
 *   --max-iter N         Max tool iterations per turn (default: 15)
 *   --cwd DIR            Working directory for tools (default: process.cwd())
 *   --system PROMPT      Override system prompt (inline text)
 *   --system-file FILE   Load system prompt from a file (e.g. CLAUDE.md)
 *   --mcp URL            Connect to an MCP server via SSE URL before starting
 *   --fallback           Use prompt-based tool calls (for models without native tool_calls)
 *   --context N          Context window token limit for auto-compression (default: 32000)
 *   --setup              Force the setup wizard (reconfigure provider/key/model)
 *   --version            Print version and exit
 *
 * System prompt priority (highest to lowest):
 *   1. --system-file FILE  (file content)
 *   2. --system PROMPT     (inline text)
 *   3. AGENT_SYSTEM_FILE   (env var pointing to file)
 *   4. AGENT_SYSTEM        (env var inline text)
 *   5. DEFAULT_SYSTEM      (built-in default in loop.ts)
 *
 * Env vars (from local .env or ~/.agent-runner/.env):
 *   AGENT_BASEURL          API base URL (e.g. https://openrouter.ai/api/v1)
 *   AGENT_API_KEY          API key for the LLM provider
 *   AGENT_MODEL            Default model (e.g. qwen/qwen3-235b-a22b)
 *   AGENT_MAX_ITER         Default max iterations per turn
 *   AGENT_SYSTEM           Default system prompt (inline)
 *   AGENT_SYSTEM_FILE      Default system prompt (path to file)
 *   AGENT_MCP_URL          Default MCP server SSE URL
 *   AGENT_FALLBACK         "true" to enable fallback mode by default
 *   AGENT_CONTEXT_TOKENS   Context window size for compression trigger
 */

import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { runLoop } from './loop'
import { runRepl } from './repl'
import { Config } from './types'
import { runWizard } from './wizard'
import { MCPClient } from './mcp-client'

// Load .env from cwd or home
function loadDotEnv(dir: string): void {
  const file = path.join(dir, '.env')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  }
}

loadDotEnv(process.cwd())
loadDotEnv(path.join(os.homedir(), '.agent-runner'))

function parseArgs(argv: string[]): { prompt: string; config: Partial<Config> } {
  const args = argv.slice(2)
  const config: Partial<Config> = {}
  let prompt = ''

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--version':
      case '-v':
        console.log('0.4.4')
        process.exit(0)
        break
      case '--setup':
        config.forceWizard = true
        break
      case '--help':
      case '-h':
        console.log(`Usage:
  agent-runner                    interactive REPL mode
  agent-runner "prompt"           single-shot mode
  agent-runner --resume SESSION   resume session (REPL or single-shot)

Options:
  --model MODEL       LLM model (overrides AGENT_MODEL)
  --baseurl URL       API base URL (overrides AGENT_BASEURL)
  --json              JSON event stream mode (single-shot only)
  --resume SESSION    Resume previous session
  --max-iter N        Max tool iterations per turn (default: 15)
  --cwd DIR           Working directory for tools
  --system PROMPT     System prompt override (inline text)
  --system-file FILE  Load system prompt from file (e.g. CLAUDE.md)
  --mcp URL           Connect to MCP server SSE URL (adds extra tools)
  --fallback          Use prompt-based tool calls (for models without native tool_calls)
  --context N         Context window token limit for compression (default: 32000)
  --setup             Run setup wizard
  --version           Show version

REPL commands: /exit  /context  /session  /clear  /model  /source  /help

Env vars: AGENT_API_KEY, AGENT_BASEURL, AGENT_MODEL, AGENT_MCP_URL, AGENT_SYSTEM_FILE`)
        process.exit(0)
        break
      case '--model':
        config.model = args[++i]
        break
      case '--baseurl':
        config.baseUrl = args[++i]
        break
      case '--json':
        config.jsonMode = true
        break
      case '--resume':
        config.sessionId = args[++i]
        break
      case '--max-iter':
        config.maxIterations = parseInt(args[++i], 10)
        break
      case '--cwd':
        config.projectRoot = args[++i]
        break
      case '--system':
        config.systemPrompt = args[++i]
        break
      case '--system-file': {
        const filePath = args[++i]
        const absPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath)
        config.systemPrompt = fs.readFileSync(absPath, 'utf-8')
        break
      }
      case '--mcp':
        config.mcpUrl = args[++i]
        break
      case '--fallback':
        config.useFallback = true
        break
      case '--context':
        config.contextTokens = parseInt(args[++i], 10)
        break
      default:
        if (!args[i].startsWith('--')) {
          prompt = args[i]
        }
    }
  }

  return { prompt, config }
}

async function main() {
  const { prompt, config: argConfig } = parseArgs(process.argv)

  // First-run wizard: triggered if no API key, forced --setup, or not in json mode (interactive only)
  const hasKey = !!(argConfig.apiKey ?? process.env.AGENT_API_KEY)
  const isJsonMode = argConfig.jsonMode ?? false
  const forceWizard = argConfig.forceWizard ?? false

  if (forceWizard || (!hasKey && !isJsonMode)) {
    const ok = await runWizard()
    if (!ok) process.exit(1)
    // Reload config after wizard
    loadDotEnv(path.join(os.homedir(), '.agent-runner'))
  }

  // System prompt priority: --system-file > --system > AGENT_SYSTEM_FILE > AGENT_SYSTEM > built-in default.
  // Note: if --system-file was passed, argConfig.systemPrompt already contains the file content
  // (loaded by the parseArgs switch). We only need to check env fallbacks here.
  let resolvedSystemPrompt = argConfig.systemPrompt
  if (!resolvedSystemPrompt && process.env.AGENT_SYSTEM_FILE) {
    try { resolvedSystemPrompt = fs.readFileSync(process.env.AGENT_SYSTEM_FILE, 'utf-8') } catch { /* ignore */ }
  }
  if (!resolvedSystemPrompt) {
    resolvedSystemPrompt = process.env.AGENT_SYSTEM
  }
  // If still undefined, loop.ts will use DEFAULT_SYSTEM.

  const config: Config = {
    baseUrl: argConfig.baseUrl ?? process.env.AGENT_BASEURL ?? 'https://openrouter.ai/api/v1',
    apiKey: argConfig.apiKey ?? process.env.AGENT_API_KEY ?? '',
    model: argConfig.model ?? process.env.AGENT_MODEL ?? 'openai/gpt-4o-mini',
    sessionId: argConfig.sessionId,
    jsonMode: argConfig.jsonMode ?? false,
    maxIterations: argConfig.maxIterations ?? parseInt(process.env.AGENT_MAX_ITER ?? '15', 10),
    projectRoot: argConfig.projectRoot ?? process.cwd(),
    systemPrompt: resolvedSystemPrompt,
    contextTokens: argConfig.contextTokens ?? parseInt(process.env.AGENT_CONTEXT_TOKENS ?? '32000', 10),
    useFallback: argConfig.useFallback ?? (process.env.AGENT_FALLBACK === 'true'),
    mcpUrl: argConfig.mcpUrl ?? process.env.AGENT_MCP_URL
  }

  if (!config.apiKey) {
    process.stderr.write('Error: AGENT_API_KEY not set\n')
    process.exit(1)
  }

  // Connect to MCP server if specified
  let mcpClient: MCPClient | null = null
  if (config.mcpUrl) {
    if (!config.jsonMode) process.stderr.write(`Connecting to MCP: ${config.mcpUrl}\n`)
    try {
      mcpClient = new MCPClient(config.mcpUrl)
      const tools = await mcpClient.connect()
      if (!config.jsonMode) process.stderr.write(`MCP: ${tools.length} tools loaded\n`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`MCP connection failed: ${msg}\n`)
      if (config.jsonMode) process.exit(1)
      // In interactive mode, continue without MCP
      mcpClient = null
    }
  }

  // No prompt + interactive → REPL mode
  if (!prompt && !isJsonMode) {
    await runRepl(config, mcpClient)
    mcpClient?.disconnect()
    return
  }

  if (!prompt) {
    process.stderr.write('Usage: agent-runner "your prompt" [--model MODEL] [--json]\n')
    process.exit(1)
  }

  try {
    await runLoop(prompt, config, mcpClient)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (config.jsonMode) {
      process.stdout.write(JSON.stringify({ type: 'error', message: msg }) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    process.exit(1)
  } finally {
    mcpClient?.disconnect()
  }
}

main()

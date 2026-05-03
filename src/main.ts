#!/usr/bin/env node
/**
 * agent-runner — standalone agentic loop CLI
 *
 * Usage:
 *   agent-runner "do something" [options]
 *   agent-runner --resume SESSION_ID "next message" [options]
 *   agent-runner --help
 *
 * Options:
 *   --model MODEL       LLM model name (overrides AGENT_MODEL)
 *   --baseurl URL       API base URL (overrides AGENT_BASEURL)
 *   --json              Output JSON events to stdout
 *   --resume SESSION    Resume a previous session by ID
 *   --max-iter N        Max tool-use iterations (default: 15)
 *   --cwd DIR           Working directory for tools (default: cwd)
 *   --system PROMPT     Override system prompt
 *
 * Env vars (from .env or environment):
 *   AGENT_BASEURL       API base URL (e.g. https://openrouter.ai/api/v1)
 *   AGENT_API_KEY       API key
 *   AGENT_MODEL         Default model (e.g. qwen/qwen3-235b-a22b)
 *   AGENT_MAX_ITER      Default max iterations
 *   AGENT_SYSTEM        Default system prompt
 */

import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { runLoop } from './loop'
import { runRepl } from './repl'
import { Config } from './types'
import { runWizard } from './wizard'

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
        console.log('0.1.0')
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
  --system PROMPT     System prompt override
  --setup             Run setup wizard
  --version           Show version

REPL commands: /exit  /session  /clear  /help

Env vars: AGENT_API_KEY, AGENT_BASEURL, AGENT_MODEL`)
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

  const config: Config = {
    baseUrl: argConfig.baseUrl ?? process.env.AGENT_BASEURL ?? 'https://openrouter.ai/api/v1',
    apiKey: argConfig.apiKey ?? process.env.AGENT_API_KEY ?? '',
    model: argConfig.model ?? process.env.AGENT_MODEL ?? 'openai/gpt-4o-mini',
    sessionId: argConfig.sessionId,
    jsonMode: argConfig.jsonMode ?? false,
    maxIterations: argConfig.maxIterations ?? parseInt(process.env.AGENT_MAX_ITER ?? '15', 10),
    projectRoot: argConfig.projectRoot ?? process.cwd(),
    systemPrompt: argConfig.systemPrompt ?? process.env.AGENT_SYSTEM
  }

  if (!config.apiKey) {
    process.stderr.write('Error: AGENT_API_KEY not set\n')
    process.exit(1)
  }

  // No prompt + interactive → REPL mode
  if (!prompt && !isJsonMode) {
    await runRepl(config)
    return
  }

  if (!prompt) {
    process.stderr.write('Usage: agent-runner "your prompt" [--model MODEL] [--json]\n')
    process.exit(1)
  }

  try {
    await runLoop(prompt, config)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (config.jsonMode) {
      process.stdout.write(JSON.stringify({ type: 'error', message: msg }) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    process.exit(1)
  }
}

main()

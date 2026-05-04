/**
 * agent-runner interactive REPL mode.
 *
 * Features: streaming, tool cache, /context, auto-compression, MCP tools,
 * /model — interactive model switcher, /source — provider/API switcher.
 */

import * as readline from 'readline'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import OpenAI from 'openai'
import { Config } from './types'
import {
  createClient,
  runTurn,
  generateSessionId,
  loadSession,
  saveSession,
  buildSystemPrompt,
  contextStats
} from './loop'
import { ToolCache } from './cache'
import { MCPClient } from './mcp-client'

// ─── Version ──────────────────────────────────────────────────────────────────

const VERSION = '0.4.4'

// ─── ANSI colors (only when stdout is a real TTY, not piped) ─────────────────
const tty = process.stdout.isTTY ?? false
const C = {
  model:  tty ? '\x1b[36m'  : '',  // cyan   — model output
  prompt: tty ? '\x1b[33m'  : '',  // yellow — user prompt >
  dim:    tty ? '\x1b[2m'   : '',  // dim    — tool calls / secondary info
  reset:  tty ? '\x1b[0m'   : '',  // reset
}

// ─── Banner ──────────────────────────────────────────────────────────────────
//
// Uses only box-drawing chars (╔ ═ ║ ┌ ─ ┐ │ └ ┘) and ASCII printable chars.
// Block elements (▄ █ ▀) are intentionally avoided: they render as double-width
// in some terminals and CJK fonts, causing misalignment.

const BANNER = `
╔══════════════════════════════════╗
║                                  ║
║    ┌──────────────────────┐      ║
║    │   A G R U N  v${VERSION}  │      ║
║    └──────────────────────┘      ║
║                                  ║
║  (c) korfix.info  by l_a_n_d     ║
╚══════════════════════════════════╝`

// ─── Provider presets ─────────────────────────────────────────────────────────

interface Provider {
  name: string
  url: string
  /** Env var name for API key. null = no key needed (e.g. local Ollama). */
  envKey: string | null
}

const PROVIDERS: Provider[] = [
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1',   envKey: 'OPENROUTER_API_KEY' },
  { name: 'Groq',       url: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY' },
  { name: 'Mistral',    url: 'https://api.mistral.ai/v1',       envKey: 'MISTRAL_API_KEY' },
  { name: 'OpenAI',     url: 'https://api.openai.com/v1',       envKey: 'OPENAI_API_KEY' },
  { name: 'Ollama',     url: 'http://localhost:11434/v1',        envKey: null },
]

// ─── Model picker ─────────────────────────────────────────────────────────────

interface ModelEntry {
  id: string
  price: string
}

/**
 * Fetch available models from the provider's /models endpoint.
 * Sorts free models first, then by price ascending.
 * Filters out embeddings, guard, whisper, and audio-only models.
 */
async function fetchModels(config: Config): Promise<ModelEntry[]> {
  try {
    const res = await fetch(`${config.baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${config.apiKey}` }
    })
    if (!res.ok) return []
    const data = await res.json() as {
      data?: Array<{ id: string; pricing?: { completion?: string | number } }>
    }
    const models = (data.data ?? [])
      .filter(m =>
        m.id &&
        !m.id.includes('guard') &&
        !m.id.includes('embed') &&
        !m.id.includes('lyria') &&
        !m.id.includes('whisper') &&
        !m.id.includes('tts')
      )
      .sort((a, b) => {
        const pa = parseFloat(String(a.pricing?.completion ?? '999'))
        const pb = parseFloat(String(b.pricing?.completion ?? '999'))
        return pa - pb
      })
      .slice(0, 40)
    return models.map(m => {
      const price = parseFloat(String(m.pricing?.completion ?? '0'))
      return {
        id: m.id,
        price: price <= 0 ? 'free' : `$${price.toFixed(4)}/1M`
      }
    })
  } catch {
    return []
  }
}

// ─── Error decoder ────────────────────────────────────────────────────────────

/**
 * Print a human-readable error with actionable hints.
 * Common API errors (429, 404, 401) get specific guidance instead of
 * raw "Error: 429 Provider returned error" messages.
 */
function handleTurnError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)

  if (msg.includes('429')) {
    console.error('\nRate limited (429). Provider is throttling requests.')
    console.error('  /model  -- switch to a different model')
    console.error('  /source -- switch to a different provider')
    console.error('  or wait ~60s and retry\n')
  } else if (msg.includes('404') && (msg.includes('model') || msg.includes('not found'))) {
    console.error('\nModel not found (404). Name may be wrong or model unavailable.')
    console.error('  /model  -- pick a valid model from the provider list\n')
  } else if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('invalid_api_key')) {
    console.error('\nAuth failed (401). API key may be invalid or expired.')
    console.error('  /source -- switch provider or re-enter API key\n')
  } else if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
    console.error('\nCannot connect to provider. Check network or base URL.')
    console.error('  /source -- switch to a different endpoint\n')
  } else {
    console.error(`\nError: ${msg}\n`)
  }
}

// ─── REPL ─────────────────────────────────────────────────────────────────────

export async function runRepl(config: Config, mcpClient: MCPClient | null = null): Promise<void> {
  // client is mutable: /source recreates it with a new baseUrl/apiKey
  let client: OpenAI = createClient(config)
  const sessionId = config.sessionId ?? generateSessionId()
  const history = config.sessionId ? loadSession(config.sessionId) : []
  const cache = new ToolCache()

  const systemContent = buildSystemPrompt(config, mcpClient)

  let messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemContent },
    ...history
  ]

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  })

  // Banner + session info
  console.log(BANNER)
  console.log(`  Model  : ${config.model}`)
  console.log(`  Session: ${sessionId}`)
  console.log(`  Dir    : ${config.projectRoot}`)
  if (mcpClient) console.log(`  MCP    : ${config.mcpUrl}`)
  if (config.useFallback) console.log(`  Mode   : fallback (prompt-based tools)`)
  if (history.length > 0) console.log(`  Loaded : ${history.length} messages`)
  console.log(`  Help   : /help\n`)

  // Prompt helper — waits for one line of input
  const ask = (prompt = `${C.prompt}>${C.reset} `) =>
    new Promise<string>((resolve) => {
      process.stdout.write(prompt)
      rl.once('line', resolve)
    })

  rl.on('close', () => {
    const toSave = messages.filter(m => m.role !== 'system')
    saveSession(sessionId, toSave)
    console.log(`\n\nSession saved: ${sessionId}`)
    console.log(`Resume: agent-runner --resume ${sessionId}`)
    process.exit(0)
  })

  // ── Main loop ──────────────────────────────────────────────────────────────

  while (true) {
    let input: string
    try {
      input = (await ask()).trim()
    } catch {
      break
    }

    if (!input) continue

    // ── Commands ──────────────────────────────────────────────────────────────

    if (input === '/exit' || input === '/quit' || input === 'exit' || input === 'quit') {
      rl.close()
      break
    }

    if (input === '/context') {
      console.log(`Context: ${contextStats(messages, config)}`)
      continue
    }

    if (input === '/session') {
      console.log(`Session: ${sessionId}`)
      console.log(`Resume:  agent-runner --resume ${sessionId}`)
      continue
    }

    if (input === '/clear') {
      messages = [{ role: 'system', content: systemContent }]
      cache.invalidate()
      console.log('History cleared, cache invalidated')
      continue
    }

    // /model [name] — list models from provider or switch directly
    if (input.startsWith('/model')) {
      const arg = input.slice('/model'.length).trim()

      if (arg) {
        // Direct: /model qwen/qwen3-coder:free
        config.model = arg
        console.log(`Model: ${config.model}`)
      } else {
        // Interactive: fetch list, show numbered menu
        process.stdout.write('Fetching models...')
        const models = await fetchModels(config)
        if (models.length === 0) {
          console.log('\nCould not fetch models. Try: /model <model-id>')
        } else {
          console.log('\n')
          models.forEach((m, i) => {
            const num = String(i + 1).padStart(2)
            const id = m.id.padEnd(52)
            const active = m.id === config.model ? ' <' : ''
            console.log(`  ${num}) ${id} ${m.price}${active}`)
          })
          const choice = (await ask('\nNumber or model ID (Enter to cancel): ')).trim()
          const choiceNum = parseInt(choice, 10)
          if (!isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= models.length) {
            config.model = models[choiceNum - 1].id
            console.log(`Switched to: ${config.model}`)
          } else if (choice && isNaN(choiceNum)) {
            config.model = choice
            console.log(`Switched to: ${config.model}`)
          }
        }
      }
      continue
    }

    // /source — switch API provider / base URL
    if (input.startsWith('/source')) {
      const arg = input.slice('/source'.length).trim()

      if (arg.startsWith('http')) {
        // Direct URL: /source http://localhost:11434/v1
        config.baseUrl = arg
        client = createClient(config)
        console.log(`Source: ${config.baseUrl}`)
      } else if (arg && !isNaN(parseInt(arg, 10))) {
        // Shorthand: /source 2
        const idx = parseInt(arg, 10) - 1
        if (idx >= 0 && idx < PROVIDERS.length) {
          const p = PROVIDERS[idx]
          config.baseUrl = p.url
          if (p.envKey && process.env[p.envKey]) {
            config.apiKey = process.env[p.envKey]!
            console.log(`Switched to ${p.name} (key from ${p.envKey})`)
          } else if (p.envKey) {
            const key = (await ask(`${p.name} API key: `)).trim()
            if (key) config.apiKey = key
          } else {
            config.apiKey = 'ollama'
            console.log(`Switched to ${p.name} (no key needed)`)
          }
          client = createClient(config)
          console.log(`Use /model to pick a model for ${p.name}`)
        }
      } else {
        // Interactive menu
        const currentProvider = PROVIDERS.find(p => p.url === config.baseUrl)?.name ?? 'Custom'
        console.log(`\nCurrent: ${currentProvider} (${config.baseUrl})\n`)
        PROVIDERS.forEach((p, i) => {
          const active = p.url === config.baseUrl ? ' <' : ''
          const isCurrent = p.url === config.baseUrl
          const keyStatus = isCurrent
            ? '(current)'
            : p.envKey
              ? (process.env[p.envKey] ? '(key found)' : '(no key in env)')
              : '(no key needed)'
          console.log(`  ${i + 1}) ${p.name.padEnd(12)} ${keyStatus}${active}`)
        })
        console.log(`  ${PROVIDERS.length + 1}) Custom URL...`)

        const choice = (await ask('\nNumber or URL (Enter to cancel): ')).trim()
        const choiceNum = parseInt(choice, 10)

        if (!isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= PROVIDERS.length) {
          const p = PROVIDERS[choiceNum - 1]
          if (p.url === config.baseUrl) {
            // Already on this provider — keep current key
            console.log(`Already on ${p.name}.`)
          } else {
            config.baseUrl = p.url
            if (p.envKey && process.env[p.envKey]) {
              config.apiKey = process.env[p.envKey]!
              console.log(`Using ${p.envKey} from environment.`)
            } else if (p.envKey) {
              const key = (await ask(`${p.name} API key: `)).trim()
              if (key) config.apiKey = key
            } else {
              config.apiKey = 'ollama'
            }
            client = createClient(config)
            console.log(`Switched to ${p.name}. Use /model to pick a model.`)
          }
        } else if (choiceNum === PROVIDERS.length + 1 || (choice && choice.startsWith('http'))) {
          const url = choice.startsWith('http') ? choice : (await ask('Base URL: ')).trim()
          if (url) {
            config.baseUrl = url
            const key = (await ask('API key (Enter to keep current): ')).trim()
            if (key) config.apiKey = key
            client = createClient(config)
            console.log(`Switched to: ${url}`)
          }
        }
      }
      continue
    }

    if (input === '/help') {
      console.log('/exit              quit and save session')
      console.log('/context           show token usage')
      console.log('/session           show session ID and resume command')
      console.log('/clear             clear conversation history and cache')
      console.log('/model             list available models and switch')
      console.log('/model <id>        switch to a specific model immediately')
      console.log('/source            switch API provider interactively')
      console.log('/source <N>        switch to preset provider by number (1-5)')
      console.log('/source <url>      switch to custom base URL directly')
      console.log('/help              this message')
      continue
    }

    // ── LLM turn ─────────────────────────────────────────────────────────────

    messages.push({ role: 'user', content: input })

    try {
      process.stdout.write('\n' + C.model)
      messages = await runTurn(client, messages, config, cache, mcpClient)
      process.stdout.write(C.reset + '\n')

      // Save session after every turn so Ctrl+C doesn't lose history
      const toSave = messages.filter(m => m.role !== 'system')
      saveSession(sessionId, toSave)
    } catch (err) {
      process.stdout.write(C.reset)  // ensure color is reset even on error
      handleTurnError(err)
    }
  }
}

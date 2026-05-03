/**
 * agent-runner interactive REPL mode.
 *
 * Features: streaming, tool cache, /context, auto-compression, MCP tools,
 * /model — interactive model switcher with live provider model list.
 */

import * as readline from 'readline'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
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

// ─── Banner ──────────────────────────────────────────────────────────────────

const BANNER = `
╔═════════════════════════════════════╗
║  ▄▄  ▄▀▀ ████ █  █ █▄  █          ║
║ █  █ █▄▄ █  █ █  █ █ █ █  v0.4.2 ║
║ ▀▄▄▀ ▀▄▄ █▄▄█ ▀▄▄▀ █  ▀█          ║
╠═════════════════════════════════════╣
║  © korfix.info        by l_a_n_d   ║
╚═════════════════════════════════════╝`

// ─── Model picker ─────────────────────────────────────────────────────────────

interface ModelEntry {
  id: string
  price: string
}

/**
 * Fetch available models from the provider's /models endpoint.
 * Sorts free models first, then by price ascending.
 * Filters out embeddings, guard, and audio-only models.
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

// ─── REPL ─────────────────────────────────────────────────────────────────────

export async function runRepl(config: Config, mcpClient: MCPClient | null = null): Promise<void> {
  // config.model may be mutated by /model command during the session
  // eslint-disable-next-line prefer-const
  let currentModel = config.model
  const client = createClient(config)
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
  console.log(`  Model  : ${currentModel}`)
  console.log(`  Session: ${sessionId}`)
  if (mcpClient) console.log(`  MCP    : ${config.mcpUrl}`)
  if (config.useFallback) console.log(`  Mode   : fallback (prompt-based tools)`)
  if (history.length > 0) console.log(`  Loaded : ${history.length} messages`)
  console.log(`  Help   : /help\n`)

  // Ask for one line of input
  const ask = (prompt = '> ') =>
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

    // /model [name] — list models or switch directly
    if (input.startsWith('/model')) {
      const arg = input.slice('/model'.length).trim()

      if (arg) {
        // Direct switch: /model qwen/qwen3-coder:free
        config.model = arg
        currentModel = arg
        console.log(`Model: ${config.model}`)
      } else {
        // Interactive picker: fetch from provider and show numbered list
        process.stdout.write('Fetching models...')
        const models = await fetchModels(config)
        if (models.length === 0) {
          console.log('\nCould not fetch models. Try: /model <model-id>')
        } else {
          console.log('\n')
          models.forEach((m, i) => {
            const num = String(i + 1).padStart(2)
            const id = m.id.padEnd(52)
            const active = m.id === config.model ? ' ◀' : ''
            console.log(`  ${num}) ${id} ${m.price}${active}`)
          })
          const choice = (await ask('\nNumber or model ID (Enter to cancel): ')).trim()
          const choiceNum = parseInt(choice, 10)
          if (!isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= models.length) {
            config.model = models[choiceNum - 1].id
            currentModel = config.model
            console.log(`Switched to: ${config.model}`)
          } else if (choice && isNaN(choiceNum)) {
            // Typed a model ID directly
            config.model = choice
            currentModel = config.model
            console.log(`Switched to: ${config.model}`)
          } else if (choice) {
            console.log('Invalid selection')
          }
        }
      }
      continue
    }

    if (input === '/help') {
      console.log('/exit          quit and save session')
      console.log('/context       show token usage')
      console.log('/session       show session ID and resume command')
      console.log('/clear         clear conversation history and cache')
      console.log('/model         list available models and switch interactively')
      console.log('/model <id>    switch to a specific model immediately')
      console.log('/help          this message')
      continue
    }

    // ── LLM turn ─────────────────────────────────────────────────────────────

    messages.push({ role: 'user', content: input })

    try {
      process.stdout.write('\n')
      messages = await runTurn(client, messages, config, cache, mcpClient)
      process.stdout.write('\n')

      // Save after each turn
      const toSave = messages.filter(m => m.role !== 'system')
      saveSession(sessionId, toSave)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: ${msg}\n`)
    }
  }
}

/**
 * agent-runner interactive REPL mode.
 * Features: streaming, tool cache, /context, auto-compression, MCP tools.
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

export async function runRepl(config: Config, mcpClient: MCPClient | null = null): Promise<void> {
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

  console.log('\nagent-runner')
  console.log(`Model  : ${config.model}`)
  console.log(`Session: ${sessionId}`)
  if (mcpClient) console.log(`MCP    : ${config.mcpUrl}`)
  if (config.useFallback) console.log(`Mode   : prompt-based tool calls (fallback)`)
  if (history.length > 0) console.log(`Loaded : ${history.length} messages from previous session`)
  console.log('Type a message. Commands: /exit /context /clear /help\n')

  const ask = () =>
    new Promise<string>((resolve) => {
      process.stdout.write('> ')
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

    if (input === '/help') {
      console.log('/exit          quit and save session')
      console.log('/context       show token usage')
      console.log('/session       show session ID and resume command')
      console.log('/clear         clear conversation history and cache')
      console.log('/help          this message')
      continue
    }

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

/**
 * agent-runner interactive REPL mode.
 * Launched when no prompt is provided (and not --json mode).
 *
 * Features:
 * - Multi-turn conversation in one process (history in memory)
 * - Tool calls shown inline
 * - Session saved after each turn (resume with --resume SESSION_ID)
 * - /exit or Ctrl+D to quit
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
  DEFAULT_SYSTEM
} from './loop'

export async function runRepl(config: Config): Promise<void> {
  const client = createClient(config)
  const sessionId = config.sessionId ?? generateSessionId()
  const history = config.sessionId ? loadSession(config.sessionId) : []

  let messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: config.systemPrompt ?? DEFAULT_SYSTEM },
    ...history
  ]

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  })

  console.log('\nagent-runner')
  console.log(`Model : ${config.model}`)
  console.log(`Session: ${sessionId}`)
  if (history.length > 0) {
    console.log(`Loaded : ${history.length} messages from previous session`)
  }
  console.log('Type a message, /exit to quit\n')

  const prompt = () => process.stdout.write('> ')

  const ask = () =>
    new Promise<string>((resolve) => {
      prompt()
      rl.once('line', resolve)
    })

  // Handle Ctrl+D / close
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

    if (input === '/session') {
      console.log(`Session: ${sessionId}`)
      console.log(`Resume:  agent-runner --resume ${sessionId}`)
      continue
    }

    if (input === '/clear') {
      messages = [{ role: 'system', content: config.systemPrompt ?? DEFAULT_SYSTEM }]
      console.log('History cleared')
      continue
    }

    if (input === '/help') {
      console.log('/exit    quit and save session')
      console.log('/session show session ID and resume command')
      console.log('/clear   clear conversation history')
      console.log('/help    this message')
      continue
    }

    messages.push({ role: 'user', content: input })

    try {
      process.stdout.write('\n')
      messages = await runTurn(client, messages, config)
      process.stdout.write('\n')

      // Save after each turn so Ctrl+C doesn't lose history
      const toSave = messages.filter(m => m.role !== 'system')
      saveSession(sessionId, toSave)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: ${msg}\n`)
    }
  }
}

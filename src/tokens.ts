/**
 * Token estimation and context compression.
 * Uses 4 chars ≈ 1 token approximation — good enough to trigger compression safely.
 *
 * Context limits by model (rough):
 *   Qwen2.5-72B, Qwen3-235B: 32K tokens
 *   GPT-4o: 128K
 *   Gemini Flash: 1M
 *   Llama-3.3-70B: 128K
 *   Mistral Large: 128K
 *   Ollama local: varies
 *
 * We compress at 80% of the configured limit.
 */

import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { Config } from './types'

const DEFAULT_CONTEXT_TOKENS = 32_000  // conservative default

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function messageTokens(msg: ChatCompletionMessageParam): number {
  if (typeof msg.content === 'string') return estimateTokens(msg.content) + 4
  if (Array.isArray(msg.content)) {
    return msg.content.reduce((sum, c) => {
      return sum + (c.type === 'text' ? estimateTokens(c.text) : 100)
    }, 4)
  }
  // tool call messages etc
  return estimateTokens(JSON.stringify(msg)) + 4
}

export function totalTokens(messages: ChatCompletionMessageParam[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0)
}

export function contextPercent(messages: ChatCompletionMessageParam[], config: Config): number {
  const limit = (config.contextTokens ?? DEFAULT_CONTEXT_TOKENS)
  return Math.round((totalTokens(messages) / limit) * 100)
}

export function shouldCompress(messages: ChatCompletionMessageParam[], config: Config): boolean {
  return contextPercent(messages, config) >= 80
}

/**
 * Compress conversation history: summarize old turns, keep recent 6 messages intact.
 * Returns new message array with ~90% context reduction on old turns.
 */
export async function compressHistory(
  client: OpenAI,
  messages: ChatCompletionMessageParam[],
  config: Config
): Promise<{ messages: ChatCompletionMessageParam[]; savedTokens: number }> {
  const systemMsgs = messages.filter(m => m.role === 'system')
  const convo = messages.filter(m => m.role !== 'system')

  const KEEP_RECENT = 6
  if (convo.length <= KEEP_RECENT) return { messages, savedTokens: 0 }

  const toCompress = convo.slice(0, -KEEP_RECENT)
  const recent = convo.slice(-KEEP_RECENT)

  const tokensBefore = totalTokens(toCompress)

  // Build compression request
  const convoText = toCompress
    .map(m => {
      const role = m.role
      const content = typeof m.content === 'string'
        ? m.content.slice(0, 1000)
        : JSON.stringify(m.content).slice(0, 500)
      return `${role}: ${content}`
    })
    .join('\n')

  const summaryResponse = await client.chat.completions.create({
    model: config.model,
    messages: [
      {
        role: 'system',
        content: 'You summarize conversation history concisely, preserving key decisions, findings, file paths, and code snippets. Be brief.'
      },
      {
        role: 'user',
        content: `Summarize this conversation history in under 400 words. Keep: file paths, commands run, decisions made, key results.\n\n${convoText}`
      }
    ]
  })

  const summary = summaryResponse.choices[0].message.content ?? '(previous conversation summarized)'

  const summaryMsg: ChatCompletionMessageParam = {
    role: 'assistant',
    content: `[Compressed context — earlier conversation summary]\n${summary}`
  }

  const tokensAfter = messageTokens(summaryMsg)
  const savedTokens = tokensBefore - tokensAfter

  return {
    messages: [...systemMsgs, summaryMsg, ...recent],
    savedTokens: Math.max(0, savedTokens)
  }
}

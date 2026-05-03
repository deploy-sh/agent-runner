/**
 * Tool result cache — avoids re-running the same read-only tool calls within a session.
 * Only caches safe, deterministic tools: read_file, list_dir, grep.
 * Write tools (bash, write_file, edit_file) are never cached.
 */

import { ExecuteResult } from './tools'

const CACHEABLE = new Set(['read_file', 'list_dir', 'grep'])
const TTL_MS = 60_000 // 60 seconds

interface CacheEntry {
  result: ExecuteResult
  expires: number
}

export class ToolCache {
  private cache = new Map<string, CacheEntry>()

  private key(name: string, args: Record<string, unknown>): string {
    return `${name}:${JSON.stringify(args, Object.keys(args).sort())}`
  }

  get(name: string, args: Record<string, unknown>): ExecuteResult | null {
    if (!CACHEABLE.has(name)) return null
    const entry = this.cache.get(this.key(name, args))
    if (!entry) return null
    if (Date.now() > entry.expires) {
      this.cache.delete(this.key(name, args))
      return null
    }
    return entry.result
  }

  set(name: string, args: Record<string, unknown>, result: ExecuteResult): void {
    if (!CACHEABLE.has(name)) return
    this.cache.set(this.key(name, args), {
      result,
      expires: Date.now() + TTL_MS
    })
  }

  invalidate(): void {
    this.cache.clear()
  }

  size(): number {
    return this.cache.size
  }
}

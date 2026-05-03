/**
 * MCP (Model Context Protocol) client — SSE + HTTP transport.
 * Connects to an MCP server, discovers tools, proxies calls.
 *
 * Usage: agent-runner "do something" --mcp http://localhost:3000/sse
 *
 * Protocol:
 *   1. GET {sseUrl} → SSE stream, server sends 'endpoint' event with POST path
 *   2. POST {endpoint} → send JSON-RPC messages, receive responses via SSE
 *
 * MCP tools are exposed to the LLM as mcp_{name} to avoid collisions.
 */

import { EventSource } from 'eventsource'
import { ExecuteResult } from './tools'

interface MCPTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface JSONRPCResponse {
  id: number | string
  result?: unknown
  error?: { code: number; message: string }
}

export class MCPClient {
  private endpoint: string | null = null
  private tools: MCPTool[] = []
  private pendingRequests = new Map<number, (r: JSONRPCResponse) => void>()
  private nextId = 1
  private es: InstanceType<typeof EventSource> | null = null

  constructor(private sseUrl: string) {}

  async connect(): Promise<MCPTool[]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('MCP connect timeout')), 15_000)

      this.es = new EventSource(this.sseUrl)

      this.es.addEventListener('endpoint', async (e: MessageEvent) => {
        const endpointPath = e.data as string
        // Build full endpoint URL from SSE URL base
        const base = new URL(this.sseUrl)
        this.endpoint = endpointPath.startsWith('http')
          ? endpointPath
          : `${base.protocol}//${base.host}${endpointPath}`

        try {
          // Initialize
          await this.rpc('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'agent-runner', version: '0.3.0' }
          })

          // List tools
          const toolsResult = await this.rpc('tools/list', {}) as { tools: MCPTool[] }
          this.tools = toolsResult.tools ?? []

          clearTimeout(timeout)
          resolve(this.tools)
        } catch (err) {
          clearTimeout(timeout)
          reject(err)
        }
      })

      this.es.addEventListener('message', (e: MessageEvent) => {
        try {
          const msg = JSON.parse(e.data) as JSONRPCResponse
          const handler = this.pendingRequests.get(msg.id as number)
          if (handler) {
            this.pendingRequests.delete(msg.id as number)
            handler(msg)
          }
        } catch { /* ignore non-JSON */ }
      })

      this.es.addEventListener('error', (e: Event) => {
        clearTimeout(timeout)
        const msg = (e as { message?: string }).message ?? 'connection failed'
        reject(new Error(`MCP SSE error: ${msg}`))
      })
    })
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    if (!this.endpoint) throw new Error('MCP not connected')

    const id = this.nextId++

    const responsePromise = new Promise<JSONRPCResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`MCP timeout for method ${method}`))
      }, 30_000)

      this.pendingRequests.set(id, (r) => {
        clearTimeout(timeout)
        resolve(r)
      })
    })

    await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    })

    const response = await responsePromise
    if (response.error) throw new Error(`MCP error: ${response.error.message}`)
    return response.result
  }

  async callTool(mcpName: string, args: Record<string, unknown>): Promise<ExecuteResult> {
    // Strip mcp_ prefix
    const toolName = mcpName.startsWith('mcp_') ? mcpName.slice(4) : mcpName
    try {
      const result = await this.rpc('tools/call', { name: toolName, arguments: args }) as {
        content: Array<{ type: string; text?: string }>
        isError?: boolean
      }

      const text = (result.content ?? [])
        .filter((c: { type: string }) => c.type === 'text')
        .map((c: { text?: string }) => c.text ?? '')
        .join('\n')

      return { content: text.slice(0, 8192) || '(empty)', error: result.isError ?? false }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), error: true }
    }
  }

  toOpenAITools() {
    return this.tools.map(t => ({
      type: 'function' as const,
      function: {
        name: `mcp_${t.name}`,
        description: `[MCP] ${t.description}`,
        parameters: t.inputSchema
      }
    }))
  }

  disconnect(): void {
    this.es?.close()
    this.es = null
  }
}

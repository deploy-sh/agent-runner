import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export const TOOLS: Tool[] = [
  {
    name: 'bash',
    description: 'Execute a shell command. Use for reading files, running scripts, checking status, installing packages, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' }
      },
      required: ['command']
    }
  },
  {
    name: 'read_file',
    description: 'Read a file and return its contents.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path' },
        offset: { type: 'number', description: 'Line number to start from (1-indexed)' },
        limit: { type: 'number', description: 'Max number of lines to read' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write content to a file, creating parent directories if needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write to' },
        content: { type: 'string', description: 'Content to write' },
        append: { type: 'boolean', description: 'If true, append instead of overwrite' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'http_request',
    description: 'Make an HTTP request and return the response.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to request' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method' },
        headers: { type: 'object', description: 'Request headers as key-value pairs' },
        body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' }
      },
      required: ['url']
    }
  }
]

// Convert to OpenAI tool format
export function openAITools() {
  return TOOLS.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }))
}

export interface ExecuteResult {
  content: string
  error: boolean
}

export function executeTool(
  name: string,
  args: Record<string, unknown>,
  projectRoot: string
): ExecuteResult {
  try {
    switch (name) {
      case 'bash': {
        const cmd = args.command as string
        const timeout = (args.timeout_ms as number) ?? 30000
        const result = execSync(cmd, {
          cwd: projectRoot,
          timeout,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024 * 4 // 4MB
        })
        return { content: result || '(empty output)', error: false }
      }

      case 'read_file': {
        const filePath = path.isAbsolute(args.path as string)
          ? (args.path as string)
          : path.join(projectRoot, args.path as string)
        const raw = fs.readFileSync(filePath, 'utf-8')
        const lines = raw.split('\n')
        const offset = ((args.offset as number) ?? 1) - 1
        const limit = (args.limit as number) ?? lines.length
        return {
          content: lines.slice(offset, offset + limit)
            .map((l, i) => `${offset + i + 1}: ${l}`)
            .join('\n'),
          error: false
        }
      }

      case 'write_file': {
        const filePath = path.isAbsolute(args.path as string)
          ? (args.path as string)
          : path.join(projectRoot, args.path as string)
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        if (args.append) {
          fs.appendFileSync(filePath, args.content as string)
        } else {
          fs.writeFileSync(filePath, args.content as string)
        }
        return { content: `Written ${(args.content as string).length} bytes to ${filePath}`, error: false }
      }

      case 'http_request': {
        const { url, method = 'GET', headers = {}, body } = args as {
          url: string; method?: string; headers?: Record<string, string>; body?: string
        }
        const headerArgs = Object.entries(headers).map(([k, v]) => `-H "${k}: ${v}"`).join(' ')
        const bodyArg = body ? `-d '${body.replace(/'/g, "\\'")}'` : ''
        const curlCmd = `curl -s -X ${method} ${headerArgs} ${bodyArg} "${url}" 2>&1`
        const result = execSync(curlCmd, { encoding: 'utf-8', timeout: 30000 })
        return { content: result.slice(0, 8192), error: false }
      }

      default:
        return { content: `Unknown tool: ${name}`, error: true }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: msg, error: true }
  }
}

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
    description: 'Execute a shell command. Use for running scripts, installing packages, git operations, etc.',
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
    description: 'Read a file and return its contents with line numbers.',
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
    description: 'Write content to a file (full overwrite or append). Prefer edit_file for targeted changes.',
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
    name: 'edit_file',
    description: 'Replace a specific string in a file. More efficient than read+write for targeted edits. The old_string must match exactly (including whitespace and newlines) and must be unique in the file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to edit' },
        old_string: { type: 'string', description: 'Exact string to find and replace (must be unique in the file)' },
        new_string: { type: 'string', description: 'Replacement string' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'list_dir',
    description: 'List directory contents with file types and sizes. Faster than bash ls for navigation.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list' },
        show_hidden: { type: 'boolean', description: 'Include hidden files (default: false)' }
      },
      required: ['path']
    }
  },
  {
    name: 'grep',
    description: 'Search for a regex pattern in files. Returns matching lines with file paths and line numbers. Faster than bash grep for exploration.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'File or directory to search in (default: project root)' },
        glob: { type: 'string', description: 'Glob to filter files, e.g. "*.ts" or "**/*.md"' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
        context: { type: 'number', description: 'Lines of context around each match (default: 0)' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'http_request',
    description: 'Make an HTTP request and return the response body.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to request' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method (default: GET)' },
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
          maxBuffer: 1024 * 1024 * 4
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

      case 'edit_file': {
        const filePath = path.isAbsolute(args.path as string)
          ? (args.path as string)
          : path.join(projectRoot, args.path as string)
        const oldStr = args.old_string as string
        const newStr = args.new_string as string
        const content = fs.readFileSync(filePath, 'utf-8')
        const count = content.split(oldStr).length - 1
        if (count === 0) {
          return { content: `Error: old_string not found in ${filePath}`, error: true }
        }
        if (count > 1) {
          return { content: `Error: old_string found ${count} times in ${filePath} — must be unique`, error: true }
        }
        fs.writeFileSync(filePath, content.replace(oldStr, newStr))
        return { content: `Replaced 1 occurrence in ${filePath}`, error: false }
      }

      case 'list_dir': {
        const dirPath = path.isAbsolute(args.path as string)
          ? (args.path as string)
          : path.join(projectRoot, args.path as string)
        const showHidden = (args.show_hidden as boolean) ?? false
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        const lines = entries
          .filter(e => showHidden || !e.name.startsWith('.'))
          .map(e => {
            if (e.isDirectory()) return `d ${e.name}/`
            const stat = fs.statSync(path.join(dirPath, e.name))
            const size = stat.size < 1024
              ? `${stat.size}B`
              : stat.size < 1024 * 1024
                ? `${(stat.size / 1024).toFixed(1)}K`
                : `${(stat.size / 1024 / 1024).toFixed(1)}M`
            return `- ${e.name} (${size})`
          })
        return { content: lines.join('\n') || '(empty)', error: false }
      }

      case 'grep': {
        const pattern = args.pattern as string
        const searchPath = (args.path as string | undefined)
          ? path.isAbsolute(args.path as string)
            ? (args.path as string)
            : path.join(projectRoot, args.path as string)
          : projectRoot
        const glob = args.glob as string | undefined
        const ignoreCase = (args.ignore_case as boolean) ?? false
        const context = (args.context as number) ?? 0

        // Build rg command (fallback to grep if rg not available)
        const rgParts = ['rg', '--no-heading', '-n']
        if (ignoreCase) rgParts.push('-i')
        if (context > 0) rgParts.push(`-C`, String(context))
        if (glob) rgParts.push(`--glob`, glob)
        rgParts.push(pattern, searchPath)

        const safe = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
        const rgCmd = rgParts.map(safe).join(' ')

        const grepParts = ['grep', '-rn']
        if (ignoreCase) grepParts.push('-i')
        if (context > 0) grepParts.push(`-${context}`)
        grepParts.push(pattern, searchPath)
        const grepCmd = grepParts.map(safe).join(' ')

        const result = execSync(
          `${rgCmd} 2>/dev/null || ${grepCmd} 2>/dev/null || echo "(no matches)"`,
          { encoding: 'utf-8', cwd: projectRoot, timeout: 15000, maxBuffer: 2 * 1024 * 1024 }
        )
        return { content: result.slice(0, 8192) || '(no matches)', error: false }
      }

      case 'http_request': {
        const { url, method = 'GET', headers = {}, body } = args as {
          url: string; method?: string; headers?: Record<string, string>; body?: string
        }
        const headerArgs = Object.entries(headers).map(([k, v]) => `-H '${k}: ${v}'`).join(' ')
        const bodyArg = body ? `-d '${body.replace(/'/g, "'\\''")}'` : ''
        const result = execSync(
          `curl -s -X ${method} ${headerArgs} ${bodyArg} '${url}' 2>&1`,
          { encoding: 'utf-8', timeout: 30000 }
        )
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

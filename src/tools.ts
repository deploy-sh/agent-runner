/**
 * Tool registry and executor for agent-runner.
 *
 * Each tool is declared twice:
 *   1. In TOOLS[] — the schema exposed to the LLM (OpenAI function-calling format).
 *      The description and parameter docs are what the model reads to decide how to call the tool.
 *   2. In executeTool() switch — the actual Node.js implementation.
 *
 * Adding a new tool:
 *   1. Add an entry to TOOLS[] with name, description, and parameters schema.
 *   2. Add a matching case in the executeTool() switch that returns ExecuteResult.
 *   3. If the tool is read-only and deterministic, it will be automatically cached
 *      by ToolCache in loop.ts (add its name to the CACHEABLE set in cache.ts).
 *
 * Tool execution notes:
 *   - All tools run synchronously in the main process (execSync for shell tools).
 *     Parallelism is handled externally by Promise.all in executeToolCallsParallel().
 *   - Output is capped: most tools slice content at 8 KB–16 KB to avoid flooding the context.
 *   - Errors thrown inside a case bubble up to the outer try/catch and become error: true results.
 *     The LLM sees the error message and can retry or adjust its approach.
 *
 * Available tools (12 built-in):
 *   bash            — shell command execution
 *   python_exec     — inline Python code execution via temp file
 *   read_file       — file read with line numbers (offset/limit supported)
 *   write_file      — full overwrite or append
 *   edit_file       — targeted unique-string replacement (efficient for code edits)
 *   list_dir        — structured directory listing with sizes
 *   grep            — regex search using ripgrep (fallback: grep)
 *   http_request    — HTTP GET/POST/PUT/PATCH/DELETE via curl
 *   pdf_to_text     — PDF text extraction via pdftotext (poppler-utils)
 *   youtube_transcript — subtitle download via yt-dlp, VTT stripped and deduplicated
 *   web_search      — DuckDuckGo instant API + HTML scrape fallback
 *   spawn_agent     — sub-agent via agent-runner --json subprocess (parallelisable)
 */
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
    description: 'Execute a shell command. Use for ANY system task: disk usage (df -h), memory (free -h), CPU (top -bn1), processes (ps aux), network, git, packages, scripts. When in doubt, use bash.',
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
  },
  {
    name: 'pdf_to_text',
    description: 'Extract text from a PDF file. Requires pdftotext (poppler-utils) installed on the system.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the PDF file' },
        pages: { type: 'string', description: 'Page range, e.g. "1-5" or "3" (default: all)' }
      },
      required: ['path']
    }
  },
  {
    name: 'youtube_transcript',
    description: 'Download transcript/subtitles from a YouTube video. Requires yt-dlp installed (pip install yt-dlp).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'YouTube video URL or video ID' },
        lang: { type: 'string', description: 'Subtitle language code (default: ru,en)' }
      },
      required: ['url']
    }
  },
  {
    name: 'web_search',
    description: 'Search the web using DuckDuckGo and return results with titles, URLs, and snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Number of results to return (default: 5, max: 10)' }
      },
      required: ['query']
    }
  },
  {
    name: 'python_exec',
    description: 'Execute Python code inline and return stdout + stderr. Ideal for data processing, calculations, JSON manipulation, and scripting tasks. Code runs in a temporary file to handle multi-line scripts cleanly.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python code to execute' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' }
      },
      required: ['code']
    }
  },
  {
    name: 'spawn_agent',
    description: 'Spawn a sub-agent to handle a focused subtask. The sub-agent runs with full tool access and returns its result. Call multiple spawn_agent in one response to run sub-agents in parallel.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task for the sub-agent' },
        model: { type: 'string', description: 'Model for the sub-agent (default: same as current)' },
        cwd: { type: 'string', description: 'Working directory for sub-agent (default: current)' },
        system: { type: 'string', description: 'System prompt for sub-agent (default: standard)' },
        max_iterations: { type: 'number', description: 'Max tool iterations for sub-agent (default: 10)' }
      },
      required: ['prompt']
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

      case 'pdf_to_text': {
        const filePath = path.isAbsolute(args.path as string)
          ? (args.path as string)
          : path.join(projectRoot, args.path as string)
        const pages = args.pages as string | undefined
        const pageArgs = pages ? `-f ${pages.split('-')[0]} -l ${pages.split('-')[1] ?? pages}` : ''
        const result = execSync(
          `pdftotext ${pageArgs} '${filePath.replace(/'/g, "\\'")}' - 2>&1`,
          { encoding: 'utf-8', timeout: 30000 }
        )
        return { content: result.slice(0, 16384) || '(empty PDF)', error: false }
      }

      case 'youtube_transcript': {
        const videoUrl = args.url as string
        const lang = (args.lang as string) ?? 'ru,en'
        // yt-dlp: download auto-generated subtitles as vtt, then strip markup
        const tmpFile = `/tmp/ytdlp_${Date.now()}`
        try {
          execSync(
            `yt-dlp --skip-download --write-auto-sub --sub-lang '${lang}' --sub-format vtt -o '${tmpFile}' '${videoUrl}' 2>&1`,
            { encoding: 'utf-8', timeout: 120_000 }
          )
          // Find the downloaded subtitle file
          const vtts = execSync(`ls ${tmpFile}*.vtt 2>/dev/null`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean)
          if (vtts.length === 0) throw new Error('No subtitle file found')
          // Strip VTT markup and deduplicate lines
          const raw = fs.readFileSync(vtts[0], 'utf-8')
          const lines = raw.split('\n')
            .filter(l => !l.startsWith('WEBVTT') && !l.match(/^\d{2}:\d{2}/) && !l.match(/^NOTE/) && l.trim())
            .map(l => l.replace(/<[^>]+>/g, '').trim())
            .filter(Boolean)
          // Deduplicate consecutive identical lines
          const deduped = lines.filter((l, i) => i === 0 || l !== lines[i - 1])
          // Cleanup temp files
          execSync(`rm -f ${tmpFile}*`, { encoding: 'utf-8' })
          return { content: deduped.join('\n').slice(0, 16384), error: false }
        } catch (e) {
          execSync(`rm -f ${tmpFile}* 2>/dev/null`, { encoding: 'utf-8' })
          throw e
        }
      }

      case 'spawn_agent': {
        const agentPrompt = args.prompt as string
        const agentModel = (args.model as string) ?? process.env.AGENT_MODEL ?? ''
        const agentCwd = (args.cwd as string) ?? projectRoot
        const agentSystem = args.system as string | undefined
        const maxIter = (args.max_iterations as number) ?? 10

        // Build command
        const parts: string[] = ['agent-runner', '--json', `--max-iter ${maxIter}`]
        if (agentModel) parts.push(`--model '${agentModel}'`)
        if (agentCwd) parts.push(`--cwd '${agentCwd.replace(/'/g, "\\'")}'`)
        if (agentSystem) parts.push(`--system '${agentSystem.replace(/'/g, "\\'")}'`)
        parts.push(`'${agentPrompt.replace(/'/g, "\\'")}'`)

        const output = execSync(parts.join(' '), {
          encoding: 'utf-8',
          timeout: 300_000,
          env: { ...process.env },
          cwd: agentCwd
        })

        // Parse JSON event stream, extract text + tool summary
        const events = output.split('\n').filter(Boolean).flatMap(line => {
          try { return [JSON.parse(line)] } catch { return [] }
        })

        const text = events
          .filter((e: Record<string, unknown>) => e.type === 'text')
          .map((e: Record<string, unknown>) => e.content as string)
          .join('')

        const toolsUsed = events
          .filter((e: Record<string, unknown>) => e.type === 'tool_call')
          .map((e: Record<string, unknown>) => `[${e.name}]`)
          .join(' ')

        return {
          content: [text, toolsUsed ? `\nTools: ${toolsUsed}` : ''].join('').trim() || '(no output)',
          error: false
        }
      }

      case 'python_exec': {
        const code = args.code as string
        const timeout = (args.timeout_ms as number) ?? 30000
        const tmpFile = `/tmp/agent_py_${Date.now()}_${Math.random().toString(36).slice(2)}.py`
        try {
          fs.writeFileSync(tmpFile, code, 'utf-8')
          const result = execSync(`python3 '${tmpFile}' 2>&1`, {
            encoding: 'utf-8',
            timeout,
            maxBuffer: 1024 * 1024 * 4,
            cwd: projectRoot
          })
          return { content: result || '(no output)', error: false }
        } finally {
          try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
        }
      }

      case 'web_search': {
        const query = args.query as string
        const count = Math.min((args.count as number) ?? 5, 10)

        // Use Python urllib for reliable HTML parsing — avoids grep -P portability issues
        const pythonCode = `
import urllib.request, urllib.parse, html as htmllib, re, json, sys

query = ${JSON.stringify(query)}
count = ${count}
encoded = urllib.parse.quote_plus(query)

# Try HTML search results first
try:
    req = urllib.request.Request(
        f'https://html.duckduckgo.com/html/?q={encoded}',
        headers={'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120'}
    )
    raw = urllib.request.urlopen(req, timeout=10).read().decode('utf-8', errors='replace')
    clean = lambda s: htmllib.unescape(re.sub(r'<[^>]+>', '', s)).strip()
    titles   = [clean(m) for m in re.findall(r'class="result__a"[^>]*>(.*?)</a>', raw, re.DOTALL)]
    snippets = [clean(m) for m in re.findall(r'class="result__snippet">(.*?)</a>', raw, re.DOTALL)]
    urls     = [clean(m) for m in re.findall(r'class="result__url"[^>]*>(.*?)</(?:a|span)>', raw, re.DOTALL)]
    out = []
    for i in range(min(count, len(titles))):
        t = titles[i]; u = urls[i] if i < len(urls) else ''; s = snippets[i] if i < len(snippets) else ''
        if t: out.append(f'{i+1}. {t}\\n   {u}\\n   {s}')
    if out:
        print(f'Results for: {query}\\n\\n' + '\\n\\n'.join(out))
        sys.exit(0)
except Exception:
    pass

# Fallback: DDG instant answer API
try:
    req2 = urllib.request.Request(
        f'https://api.duckduckgo.com/?q={encoded}&format=json&no_redirect=1&no_html=1&skip_disambig=1',
        headers={'User-Agent': 'Mozilla/5.0'}
    )
    ddg = json.loads(urllib.request.urlopen(req2, timeout=10).read().decode('utf-8'))
    out2 = []
    if ddg.get('Abstract'): out2.append(f'Summary: {ddg["Abstract"]}\\nSource: {ddg.get("AbstractURL","")}')
    for t in ddg.get('RelatedTopics', [])[:count]:
        if t.get('Text'): out2.append(f'- {t["Text"]}\\n  {t.get("FirstURL","")}')
    print('\\n\\n'.join(out2) if out2 else '(no results)')
except Exception as e:
    print(f'(search error: {e})')
`
        const tmpFile = `/tmp/agent_ws_${Date.now()}.py`
        try {
          fs.writeFileSync(tmpFile, pythonCode)
          const result = execSync(`python3 '${tmpFile}'`, { encoding: 'utf-8', timeout: 15000 })
          return { content: result.slice(0, 8192) || '(no results)', error: false }
        } finally {
          try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
        }
      }

      default:
        return { content: `Unknown tool: ${name}`, error: true }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: msg, error: true }
  }
}

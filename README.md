# agent-runner

Standalone agentic loop CLI — use any OpenAI-compatible LLM as an autonomous agent with tool access.

**Part of the [aiclaw](https://github.com/deploy-sh/claudeclaw) ecosystem.** Can also run standalone without aiclaw.

---

## What it does

agent-runner gives any LLM an interactive agentic loop with tools:

```
user prompt → LLM thinks → calls tool → sees result → thinks again → final answer
```

Two modes:
- **Interactive REPL** — multi-turn conversation, streaming output (like Claude Code)
- **Single-shot** — one prompt, exits with result (good for scripts and automation)

Works with any LLM that supports function/tool calling:
- OpenRouter (Qwen3, Gemini, Llama, Mistral, Claude, ...)
- Mistral AI, Groq, OpenAI
- Ollama (local models, no API key)
- Any OpenAI-compatible endpoint

---

## Install

### One-liner (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/deploy-sh/agent-runner/main/install.sh | bash
```

Downloads the binary to `/usr/local/bin` (root) or `~/.local/bin` (user), adds to PATH.

```bash
agent-runner --setup   # first-run wizard
agent-runner           # start interactive REPL
```

### Manual binary download

```bash
curl -fsSL https://github.com/deploy-sh/agent-runner/releases/latest/download/agent-runner-linux-x64 \
  -o /usr/local/bin/agent-runner
chmod +x /usr/local/bin/agent-runner
agent-runner --setup
```

### From source

```bash
git clone https://github.com/deploy-sh/agent-runner
cd agent-runner
npm install && npm run build
node dist/main.js
```

---

## First-run setup wizard

Run `agent-runner --setup` (or just `agent-runner` without AGENT_API_KEY) to configure:

```
╔══════════════════════════════════════╗
║       agent-runner — First Setup      ║
╚══════════════════════════════════════╝

Choose LLM provider:
  1) OpenRouter — access to 200+ models, free tier available
  2) Mistral AI — EU-based, strong at code
  3) Groq — very fast inference, free tier
  4) Ollama — local models, no API key needed
  5) OpenAI
  6) Custom (enter manually)

Enter number [1]: 1
API Key: sk-or-...
Default model [qwen/qwen3-235b-a22b]:
Max tool iterations per turn [15]:

✓ Config saved to ~/.agent-runner/.env
```

Config is saved to `~/.agent-runner/.env` (chmod 600).

---

## Interactive REPL mode

Run without a prompt to start a Claude Code-style interactive session:

```bash
agent-runner
```

```
agent-runner
Model : qwen/qwen3-235b-a22b
Session: ar-1746283800-abc123
Type a message, /exit to quit

> analyze the files in this directory
→ [list_dir] .
→ [read_file] src/main.ts
Here's what I found: ...   ← streams as it generates

> now fix the bug on line 42
→ [edit_file] src/main.ts
Done. The issue was...

> /exit
Session saved: ar-1746283800-abc123
Resume: agent-runner --resume ar-1746283800-abc123
```

Session is saved after every turn — Ctrl+C won't lose history.

### REPL commands

| Command | Action |
|---------|--------|
| `/exit` | Quit and save session |
| `/session` | Show session ID and resume command |
| `/clear` | Clear conversation history |
| `/help` | Show command list |

---

## Single-shot mode

```bash
# Basic
agent-runner "list all .ts files in current directory"

# With specific model
agent-runner "fix the bug in src/main.ts" --model qwen/qwen3-235b-a22b

# Resume a previous session
agent-runner --resume ar-1234567890-abc123 "and now sort by size"

# Set working directory
agent-runner "read package.json and bump the version" --cwd /path/to/project

# Custom system prompt
agent-runner "help me" --system "You are a linux sysadmin expert"

# JSON output (for programmatic use / aiclaw integration)
agent-runner "check disk usage" --json
```

---

## Options

| Flag | Description |
|------|-------------|
| `--model MODEL` | LLM model name (overrides AGENT_MODEL) |
| `--baseurl URL` | API base URL (overrides AGENT_BASEURL) |
| `--json` | JSON event stream (single-shot only, disables REPL and streaming) |
| `--resume ID` | Resume previous session (works in both REPL and single-shot) |
| `--max-iter N` | Max tool iterations per turn (default: 15) |
| `--cwd DIR` | Working directory for tools (default: cwd) |
| `--system PROMPT` | Override system prompt |
| `--setup` | Re-run setup wizard |
| `--version` | Show version |

---

## Tools

7 built-in tools available to the LLM:

| Tool | Description |
|------|-------------|
| `bash` | Execute shell commands (scripts, git, packages, etc.) |
| `read_file` | Read file contents with line numbers, supports offset/limit |
| `write_file` | Write or append to a file |
| `edit_file` | Targeted string replacement — more efficient than full rewrite |
| `list_dir` | Structured directory listing with file sizes |
| `grep` | Regex search in files, uses ripgrep or grep, returns file:line matches |
| `http_request` | HTTP requests via curl |

### Tool highlights

**`edit_file`** — for code edits, the LLM replaces specific strings instead of rewriting whole files. Saves tokens and avoids accidental overwrites.

**`grep`** — search across a codebase without spending a bash iteration on formatting:
```
grep pattern="class.*Handler" path="src/" glob="*.ts"
→ src/handlers/auth.ts:12: class AuthHandler {
  src/handlers/api.ts:8: class ApiHandler {
```

**`list_dir`** — clean structured view:
```
d handlers/
d utils/
- main.ts (4.2K)
- package.json (1.1K)
```

---

## Configuration

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_BASEURL` | API base URL | `https://openrouter.ai/api/v1` |
| `AGENT_API_KEY` | API key | *(required)* |
| `AGENT_MODEL` | Default model | `openai/gpt-4o-mini` |
| `AGENT_MAX_ITER` | Max iterations per turn | `15` |
| `AGENT_SYSTEM` | System prompt override | *(built-in)* |

### Config file

`~/.agent-runner/.env` — global defaults (set by wizard or manually):

```env
AGENT_BASEURL=https://openrouter.ai/api/v1
AGENT_API_KEY=sk-or-...
AGENT_MODEL=qwen/qwen3-235b-a22b
AGENT_MAX_ITER=15
```

Local `.env` in working directory takes priority over `~/.agent-runner/.env`.

---

## JSON output format (--json)

Used by aiclaw and other tools that spawn agent-runner as a subprocess:

```jsonl
{"type":"text","content":"I'll check the disk usage for you."}
{"type":"tool_call","name":"bash","args":{"command":"df -h"}}
{"type":"tool_result","name":"bash","content":"Filesystem  Size  Used...","error":false}
{"type":"text","content":"Current disk usage: /dev/sda1 is 45% full."}
{"type":"done","session_id":"ar-1714900000-abc123"}
```

In `--json` mode, streaming is disabled — text is emitted as complete chunks.

---

## Session continuity

Sessions are stored in `~/.agent-runner/sessions/` as JSON (last 40 messages). Session ID comes from the `done` event or the REPL exit message.

```bash
# First session
agent-runner "analyze src/main.ts" --json
# → {"type":"done","session_id":"ar-1714900000-abc123"}

# Continue — model remembers context
agent-runner --resume ar-1714900000-abc123 "now refactor the parse function" --json

# Or resume in REPL
agent-runner --resume ar-1714900000-abc123
```

---

## Integration with aiclaw

aiclaw spawns agent-runner as a subprocess and parses the JSON event stream:

```typescript
// src/agents/agent-runner.ts (in aiclaw)
const proc = spawn('agent-runner', [prompt, '--json', '--cwd', projectRoot], {
  env: { ...process.env, AGENT_MODEL: userSelectedModel }
})
// Parses: text → accumulate, tool_call → notify UI, done → save sessionId
```

aiclaw's `install.sh` downloads agent-runner automatically from GitHub releases.

---

## Recommended models (via OpenRouter)

| Model | Good for |
|-------|----------|
| `qwen/qwen3-235b-a22b` | General purpose, tool use, code |
| `google/gemini-2.0-flash-001` | Fast, cheap, strong context |
| `mistralai/mistral-large-latest` | Code, reasoning |
| `meta-llama/llama-3.3-70b-instruct` | Open source, fast |
| `anthropic/claude-3-5-sonnet` | Complex multi-step reasoning |

---

## Security

- `bash` tool runs in `--cwd` directory (default: cwd of agent-runner process)
- No sandbox by default — runs as the current user
- For untrusted use: run in a container or restricted user account
- Config file is chmod 600 (owner read only)

# agent-runner

Standalone agentic loop CLI — use any OpenAI-compatible LLM as an autonomous agent with tool access.

**Part of the [aiclaw](https://github.com/deploy-sh/claudeclaw) ecosystem.** Can also run standalone without aiclaw.

---

## What it does

agent-runner gives any LLM a tool-use loop:

```
user prompt → LLM thinks → calls tool → sees result → thinks again → final answer
```

Available tools: **bash**, **read_file**, **write_file**, **http_request**

Works with any LLM that supports function/tool calling:
- OpenRouter (Qwen3, Gemini, Llama, Mistral, Claude, ...)
- Mistral AI
- Groq
- Ollama (local)
- OpenAI
- Any OpenAI-compatible endpoint

---

## Install

### One-liner (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/deploy-sh/agent-runner/main/install.sh | bash
```

Downloads the binary, places it in `/usr/local/bin` (root) or `~/.local/bin` (user), adds to PATH.

After install:
```bash
agent-runner --setup   # first-run wizard
agent-runner "do something"
```

### Option B: Download binary manually

```bash
curl -fsSL https://github.com/deploy-sh/agent-runner/releases/latest/download/agent-runner-linux-x64 \
  -o /usr/local/bin/agent-runner
chmod +x /usr/local/bin/agent-runner
agent-runner --setup
```

### Option C: from source

```bash
git clone https://github.com/deploy-sh/agent-runner
cd agent-runner
npm install && npm run build
node dist/main.js "hello"
```

---

## First-run setup wizard

Run `agent-runner` without arguments (or without AGENT_API_KEY configured) to launch the interactive setup:

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

## Usage

```bash
# Basic
agent-runner "list all .ts files in current directory"

# With specific model
agent-runner "fix the bug in src/main.ts" --model qwen/qwen3-235b-a22b

# JSON output (for programmatic use / aiclaw integration)
agent-runner "check disk usage" --json

# Continue a previous session
agent-runner --resume ar-1234567890-abc123 "and now sort by size"

# Set working directory
agent-runner "read package.json and bump the version" --cwd /path/to/project

# Custom system prompt
agent-runner "help me" --system "You are a linux sysadmin expert"
```

---

## Options

| Flag | Description |
|------|-------------|
| `--model MODEL` | LLM model name (overrides AGENT_MODEL) |
| `--baseurl URL` | API base URL (overrides AGENT_BASEURL) |
| `--json` | Output JSON events to stdout |
| `--resume ID` | Resume previous session by ID |
| `--max-iter N` | Max tool iterations per turn (default: 15) |
| `--cwd DIR` | Working directory for tools (default: cwd) |
| `--system PROMPT` | Override system prompt |

---

## Configuration

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_BASEURL` | API base URL | `https://openrouter.ai/api/v1` |
| `AGENT_API_KEY` | API key | *(required)* |
| `AGENT_MODEL` | Default model | `openai/gpt-4o-mini` |
| `AGENT_MAX_ITER` | Max iterations | `15` |
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

Used by aiclaw and other tools that spawn agent-runner:

```jsonl
{"type":"text","content":"I'll check the disk usage for you."}
{"type":"tool_call","name":"bash","args":{"command":"df -h"}}
{"type":"tool_result","name":"bash","content":"Filesystem  Size  Used...","error":false}
{"type":"text","content":"Current disk usage: /dev/sda1 is 45% full."}
{"type":"done","session_id":"ar-1714900000-abc123"}
```

---

## Session continuity

Sessions are stored in `~/.agent-runner/sessions/` as JSON. The session ID is returned in the `done` event.

```bash
# First turn
agent-runner "analyze src/main.ts" --json
# → {"type":"done","session_id":"ar-1714900000-abc123"}

# Next turn — model remembers context
agent-runner --resume ar-1714900000-abc123 "now refactor the parse function" --json
```

---

## Integration with aiclaw

aiclaw spawns agent-runner as a subprocess and parses JSON events:

```typescript
// src/agents/agent-runner.ts (in aiclaw)
const proc = spawn('agent-runner', [prompt, '--json', '--cwd', projectRoot], {
  env: { ...process.env, AGENT_MODEL: userSelectedModel }
})
```

Install agent-runner binary alongside aiclaw:
```bash
# In aiclaw install.sh
curl -L .../agent-runner-linux-x64 -o /usr/local/bin/agent-runner
chmod +x /usr/local/bin/agent-runner
```

---

## Recommended models (OpenRouter)

| Model | Good for |
|-------|----------|
| `qwen/qwen3-235b-a22b` | General purpose, tool use, code |
| `google/gemini-2.0-flash-001` | Fast, cheap, web knowledge |
| `mistralai/mistral-large-latest` | Code, reasoning |
| `meta-llama/llama-3.3-70b-instruct` | Open, fast |
| `anthropic/claude-3-5-sonnet` | Complex reasoning |

---

## Security

- bash tool runs in `--cwd` directory (default: cwd of agent-runner process)
- No sandbox by default — runs as the current user
- For untrusted use: run in a container or restricted user account
- Config file is saved chmod 600 (owner read only)

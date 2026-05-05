# Branding Forks — How to Create a Custom CLI

agent-runner is designed to be white-labeled. You can create a named fork
(e.g. `giga-cli`, `acme-ai`, `mybot`) by changing **two files only**.

---

## What a fork changes

| What | Where |
|------|-------|
| Banner name & label | `src/brand.ts` → `BRAND.banner` |
| Config directory (`~/.giga-cli/`) | `src/brand.ts` → `BRAND.slug` |
| First-run wizard providers | `src/brand.ts` → `BRAND.extraWizardPresets` |
| `/source` provider list | `src/brand.ts` → `BRAND.extraProviders` |
| Default provider / model | `src/brand.ts` → `BRAND.defaultBaseUrl`, `BRAND.defaultModel` |
| Copyright line | `src/brand.ts` → `BRAND.copyright` |
| npm package name | `package.json` → `name` |
| CLI binary names | `package.json` → `bin` |

Everything else (tools, agentic loop, MCP, sessions, memory) is inherited
from the base without modification.

---

## Step-by-step: create a new fork

```bash
# 1. Start from main (base logic, no brand overrides)
git checkout main
git checkout -b my_fork

# 2. Edit brand identity
$EDITOR src/brand.ts

# 3. Edit package identity
$EDITOR package.json

# 4. Build and test
npm run build
node dist/main.js --version
node dist/main.js --setup    # verify wizard shows your brand + providers

# 5. Commit
git add src/brand.ts package.json
git commit -m "feat(my_fork): brand identity + provider preset"
```

---

## src/brand.ts reference

```typescript
export const BRAND = {
  /** Display name shown in banner and wizard header */
  name: 'GIGA CLI',

  /**
   * Slug used for:
   *   - config dir:  ~/.{slug}/  (stores .env and sessions)
   *   - test hint:   "{slug} \"what is 2+2\""
   * Keep lowercase, hyphenated, no spaces.
   */
  slug: 'giga-cli',

  /**
   * Version — keep in sync with package.json.
   * Used in banner and --version output.
   */
  version: '0.4.5',

  /**
   * Banner box label — shown in the ASCII box on startup.
   * Keep ≤ 20 chars so the box stays aligned.
   * Example: 'G I G A C L I' or 'MY  AGENT  CLI'
   */
  banner: 'G I G A C L I',

  /** Copyright / attribution line in the banner. Max ~32 chars. */
  copyright: '(c) korfix.info  by l_a_n_d',

  /**
   * Default base URL pre-filled in wizard when user picks provider #1.
   * Should match extraWizardPresets[0].baseUrl.
   */
  defaultBaseUrl: 'https://gigachat.devices.sberbank.ru/api/v1',

  /**
   * Default model pre-filled in wizard.
   * Should match extraWizardPresets[0].models[0].
   */
  defaultModel: 'GigaChat-Pro',

  /**
   * Extra providers shown at the TOP of /source list.
   * Generic providers (OpenRouter, Groq, Mistral, OpenAI, Ollama) follow automatically.
   *
   * Fields:
   *   name    — shown in /source menu
   *   url     — OpenAI-compatible base URL
   *   envKey  — env var name for API key; null = no key (Ollama-style)
   */
  extraProviders: [
    {
      name: 'GigaChat',
      url: 'https://gigachat.devices.sberbank.ru/api/v1',
      envKey: 'GIGACHAT_API_KEY',
    },
  ],

  /**
   * Extra presets shown at the TOP of the first-run wizard.
   * Generic presets (OpenRouter, Mistral, Groq, Ollama, OpenAI) follow automatically.
   * Set to [] to use only generic presets (pure rebrand, no extra providers).
   *
   * Fields:
   *   baseUrl  — API base URL
   *   note     — one-line description shown next to the number
   *   models   — suggested models; user can pick by number or type manually
   */
  extraWizardPresets: [
    {
      baseUrl: 'https://gigachat.devices.sberbank.ru/api/v1',
      note: 'GigaChat (Sber) — Russian LLM with function calling',
      models: ['GigaChat-Max', 'GigaChat-Pro', 'GigaChat'],
    },
  ],
}
```

---

## package.json reference

```json
{
  "name": "giga-cli",
  "version": "0.4.5",
  "description": "GigaChat CLI — agentic loop for GigaChat and OpenAI-compatible LLMs",
  "bin": {
    "giga-cli": "dist/main.js",
    "giga": "dist/main.js"
  }
}
```

- `name` — npm package name (lowercase, hyphenated)
- `bin` keys — shell commands installed on `npm install -g`; can have multiple aliases
- Keep `version` in sync with `BRAND.version` in `brand.ts`

---

## Existing forks

| Branch | Binary | Primary provider | Config dir |
|--------|--------|-----------------|------------|
| `main` | `agent-runner` | OpenRouter | `~/.agent-runner/` |
| `giga_cli` | `giga`, `giga-cli` | GigaChat (Sber) | `~/.giga-cli/` |

---

## Merging upstream changes from main

Generic tool improvements, bug fixes, and new features land on `main`.
To pull them into a fork branch:

```bash
git checkout giga_cli
git merge main
# resolve conflicts if any (brand.ts is fork-only, rarely conflicts)
npm run build
```

`src/brand.ts` is a new file that `main` doesn't touch, so merge conflicts
are rare. The only risky file is `package.json` if main bumps the version.

---

## What you do NOT need to change

- `src/loop.ts` — agentic loop, tool execution
- `src/tools.ts` — bash, read_file, write_file, memory tools
- `src/repl.ts` — REPL logic, `/model`, `/source`, `/context` commands
- `src/mcp-client.ts` — MCP server integration
- `src/cache.ts`, `src/tokens.ts`, `src/types.ts` — internals

These files all import from `brand.ts` where needed (banner, config dir,
providers). You only touch `brand.ts`.

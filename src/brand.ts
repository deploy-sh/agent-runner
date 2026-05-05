/**
 * brand.ts — fork identity file
 *
 * This is the ONLY file that changes between forks.
 * Everything else (wizard, repl, main) imports from here.
 *
 * To create a new fork:
 *   1. git checkout -b my_fork
 *   2. Edit this file
 *   3. Edit package.json (name, bin, version)
 *   4. Done.
 */

export interface ProviderPreset {
  /** Display name in /source list */
  name: string
  /** OpenAI-compatible base URL */
  url: string
  /** Env var name for API key. null = no key needed (e.g. Ollama). */
  envKey: string | null
}

export interface WizardPreset {
  baseUrl: string
  note: string
  models: string[]
}

export const BRAND = {
  /** Short display name — shown in banner box */
  name: 'GIGA CLI',

  /** Used for config dir (~/.${slug}/) and env var prefix recommendation */
  slug: 'giga-cli',

  /** Shown in banner and --version */
  version: '0.4.5',

  /** Banner box label — keep ≤20 chars for alignment */
  banner: 'G I G A C L I',

  /** Copyright line in banner */
  copyright: '(c) korfix.info  by l_a_n_d',

  /** Default base URL for first-run wizard */
  defaultBaseUrl: 'https://gigachat.devices.sberbank.ru/api/v1',

  /** Default model for first-run wizard */
  defaultModel: 'GigaChat-Pro',

  /**
   * Extra providers prepended to /source list.
   * Fork-specific providers go here. Generic ones (OpenRouter, Groq, etc.)
   * are defined in repl.ts as BASE_PROVIDERS.
   */
  extraProviders: [
    {
      name: 'GigaChat',
      url: 'https://gigachat.devices.sberbank.ru/api/v1',
      envKey: 'GIGACHAT_API_KEY',
    },
  ] as ProviderPreset[],

  /**
   * Extra presets injected at the TOP of the first-run wizard.
   * Numbered starting from 1; generic presets follow after.
   * Set to [] to use only generic presets.
   */
  extraWizardPresets: [
    {
      baseUrl: 'https://gigachat.devices.sberbank.ru/api/v1',
      note: 'GigaChat (Sber) — Russian LLM with function calling',
      models: ['GigaChat-Max', 'GigaChat-Pro', 'GigaChat'],
    },
  ] as WizardPreset[],
}

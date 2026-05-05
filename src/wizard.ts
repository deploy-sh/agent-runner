/**
 * First-run setup wizard
 * Triggered when AGENT_API_KEY is not configured
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import { BRAND } from './brand'

const CONFIG_DIR = path.join(os.homedir(), '.' + BRAND.slug)
const CONFIG_FILE = path.join(CONFIG_DIR, '.env')

// Generic provider presets (always shown, after brand-specific ones)
const GENERIC_PRESETS: { baseUrl: string; note: string; models: string[] }[] = [
  {
    baseUrl: 'https://openrouter.ai/api/v1',
    note: 'OpenRouter — access to 200+ models, free tier available',
    models: ['qwen/qwen3-235b-a22b', 'google/gemini-2.0-flash-001', 'mistralai/mistral-large-latest', 'anthropic/claude-3-5-sonnet']
  },
  {
    baseUrl: 'https://api.mistral.ai/v1',
    note: 'Mistral AI — EU-based, strong at code',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'codestral-latest']
  },
  {
    baseUrl: 'https://api.groq.com/openai/v1',
    note: 'Groq — very fast inference, free tier',
    models: ['llama-3.3-70b-versatile', 'qwen-qwq-32b', 'llama3-70b-8192']
  },
  {
    baseUrl: 'http://localhost:11434/v1',
    note: 'Ollama — local models, no API key needed',
    models: ['qwen3:32b', 'llama3.3:70b', 'qwq:32b', 'mistral:latest']
  },
  {
    baseUrl: 'https://api.openai.com/v1',
    note: 'OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini']
  }
]

// Combined list: brand extras first, then generics
const ALL_PRESETS = [...BRAND.extraWizardPresets, ...GENERIC_PRESETS]

// Ollama entry index (0-based) for key-skipping logic
const OLLAMA_IDX = ALL_PRESETS.findIndex(p => p.baseUrl.includes('localhost:11434'))

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve))
}

export async function runWizard(): Promise<boolean> {
  console.log(`\n╔══════════════════════════════════════╗`)
  console.log(`║     ${BRAND.name} — First Setup`.padEnd(43) + '║')
  console.log(`╚══════════════════════════════════════╝\n`)
  console.log(`No AGENT_API_KEY found. Let's configure ${BRAND.name}.\n`)
  console.log('Config will be saved to: ' + CONFIG_FILE + '\n')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  try {
    // Step 1: Choose provider
    console.log('Choose LLM provider:')
    ALL_PRESETS.forEach((p, i) => console.log(`  ${i + 1}) ${p.note}`))
    console.log(`  ${ALL_PRESETS.length + 1}) Custom (enter manually)\n`)

    const defaultChoice = '1'
    const providerChoice = (await ask(rl, `Enter number [${defaultChoice}]: `)).trim() || defaultChoice
    const choiceIdx = parseInt(providerChoice, 10) - 1

    let baseUrl: string
    let suggestedModels: string[] = []

    if (choiceIdx >= 0 && choiceIdx < ALL_PRESETS.length) {
      baseUrl = ALL_PRESETS[choiceIdx].baseUrl
      suggestedModels = ALL_PRESETS[choiceIdx].models
      console.log(`✓ Using ${baseUrl}\n`)
    } else {
      baseUrl = (await ask(rl, 'Base URL: ')).trim()
    }

    // Step 2: API key (skip for Ollama)
    let apiKey = ''
    if (choiceIdx === OLLAMA_IDX) {
      console.log('Ollama: no API key needed, using placeholder.\n')
      apiKey = 'ollama'
    } else {
      apiKey = (await ask(rl, 'API Key: ')).trim()
      if (!apiKey) {
        console.log('✗ API key is required.\n')
        rl.close()
        return false
      }
    }

    // Step 3: Default model
    if (suggestedModels.length > 0) {
      console.log('\nSuggested models:')
      suggestedModels.forEach((m, i) => console.log(`  ${i + 1}) ${m}`))
      console.log()
    }

    const defaultModel = suggestedModels[0] ?? BRAND.defaultModel
    const modelInput = (await ask(rl, `Default model [${defaultModel}]: `)).trim()

    let model = defaultModel
    if (modelInput) {
      const idx = parseInt(modelInput, 10)
      if (!isNaN(idx) && idx >= 1 && idx <= suggestedModels.length) {
        model = suggestedModels[idx - 1]
      } else {
        model = modelInput
      }
    }

    console.log(`✓ Model: ${model}\n`)

    // Step 4: Max iterations
    const maxIterStr = (await ask(rl, 'Max tool iterations per turn [15]: ')).trim()
    const maxIter = parseInt(maxIterStr, 10) || 15

    rl.close()

    // Save config
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    const config = [
      `AGENT_BASEURL=${baseUrl}`,
      `AGENT_API_KEY=${apiKey}`,
      `AGENT_MODEL=${model}`,
      `AGENT_MAX_ITER=${maxIter}`,
    ].join('\n') + '\n'

    fs.writeFileSync(CONFIG_FILE, config, { mode: 0o600 })

    const binName = BRAND.slug
    console.log('\n✓ Config saved to ' + CONFIG_FILE)
    console.log('\nTest it:')
    console.log(`  ${binName} "what is 2+2"`)
    console.log(`  ${binName} "list files in current dir" --json\n`)
    return true

  } catch (err) {
    rl.close()
    throw err
  }
}

/**
 * First-run setup wizard
 * Triggered when AGENT_API_KEY is not configured
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'

const CONFIG_DIR = path.join(os.homedir(), '.agent-runner')
const CONFIG_FILE = path.join(CONFIG_DIR, '.env')

const PRESETS: Record<string, { baseUrl: string; note: string; models: string[] }> = {
  '1': {
    baseUrl: 'https://openrouter.ai/api/v1',
    note: 'OpenRouter — access to 200+ models, free tier available',
    models: ['qwen/qwen3-235b-a22b', 'google/gemini-2.0-flash-001', 'mistralai/mistral-large-latest', 'anthropic/claude-3-5-sonnet']
  },
  '2': {
    baseUrl: 'https://api.mistral.ai/v1',
    note: 'Mistral AI — EU-based, strong at code',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'codestral-latest']
  },
  '3': {
    baseUrl: 'https://api.groq.com/openai/v1',
    note: 'Groq — very fast inference, free tier',
    models: ['llama-3.3-70b-versatile', 'qwen-qwq-32b', 'llama3-70b-8192']
  },
  '4': {
    baseUrl: 'http://localhost:11434/v1',
    note: 'Ollama — local models, no API key needed',
    models: ['qwen3:32b', 'llama3.3:70b', 'qwq:32b', 'mistral:latest']
  },
  '5': {
    baseUrl: 'https://api.openai.com/v1',
    note: 'OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini']
  }
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve))
}

export async function runWizard(): Promise<boolean> {
  console.log('\n╔══════════════════════════════════════╗')
  console.log('║       agent-runner — First Setup      ║')
  console.log('╚══════════════════════════════════════╝\n')
  console.log('No AGENT_API_KEY found. Let\'s configure agent-runner.\n')
  console.log('Config will be saved to: ' + CONFIG_FILE + '\n')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  try {
    // Step 1: Choose provider
    console.log('Choose LLM provider:')
    for (const [key, preset] of Object.entries(PRESETS)) {
      console.log(`  ${key}) ${preset.note}`)
    }
    console.log('  6) Custom (enter manually)\n')

    const providerChoice = (await ask(rl, 'Enter number [1]: ')).trim() || '1'

    let baseUrl: string
    let suggestedModels: string[] = []

    if (providerChoice in PRESETS) {
      baseUrl = PRESETS[providerChoice].baseUrl
      suggestedModels = PRESETS[providerChoice].models
      console.log(`✓ Using ${baseUrl}\n`)
    } else {
      baseUrl = (await ask(rl, 'Base URL: ')).trim()
    }

    // Step 2: API key
    let apiKey = ''
    if (providerChoice === '4') {
      // Ollama - no key needed
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

    const defaultModel = suggestedModels[0] ?? 'gpt-4o-mini'
    const modelInput = (await ask(rl, `Default model [${defaultModel}]: `)).trim()

    let model = defaultModel
    if (modelInput) {
      // Check if user entered a number for suggested model
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

    console.log('\n✓ Config saved to ' + CONFIG_FILE)
    console.log('\nTest it:')
    console.log('  agent-runner "what is 2+2"')
    console.log('  agent-runner "list files in current dir" --json\n')
    return true

  } catch (err) {
    rl.close()
    throw err
  }
}

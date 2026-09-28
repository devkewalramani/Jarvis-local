/**
 * One command to run JARVIS: the bridge (brain) and the Vite dev server (face)
 * together, so a student types `npm start` and nothing else.
 *
 * Two long-running processes normally mean two terminals. This launcher spawns
 * both as children, tags their output so you can tell them apart, and shuts
 * them down together on Ctrl-C — no extra dependency, just Node.
 *
 * Pass --writes to allow JARVIS to take real actions (drive the phone, the
 * browser, send things): `npm start -- --writes`.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'
import { cpSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Put MediaPipe's WebAssembly where the page can actually load it.
 *
 * Hand tracking needs a WASM runtime, and the usual recipe fetches it from a
 * CDN. That fails here twice over. The page's CSP names no CDN in `script-src`,
 * and the runtime arrives as a script — so it is blocked, and the failure
 * surfaces as gesture control simply never starting. And a CDN import is a live
 * supply-chain dependency: executable code, re-resolved on every load, that we
 * do not control and cannot pin against being changed under us.
 *
 * Copying it out of node_modules solves both. It is served from our own origin,
 * so `'self'` covers it; and it is the exact bytes of the version in the
 * lockfile. It stays out of git — 34 MB of build output does not belong in a
 * repository — and is re-copied whenever it is missing, which costs nothing
 * after the first run.
 */
function vendorWasm() {
  const from = 'node_modules/@mediapipe/tasks-vision/wasm'
  const to = 'public/mediapipe'
  if (!existsSync(from)) return // gesture control is optional; carry on without it
  if (existsSync(`${to}/vision_wasm_internal.wasm`)) return
  try {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    console.log('  vendored the hand-tracking runtime into public/mediapipe.')
  } catch (err) {
    console.warn(`  could not vendor the hand-tracking runtime: ${err.message}`)
  }
}

// Personal settings live in .env (gitignored; see .env.example). Loaded here so
// every process this launcher starts inherits them.
try {
  process.loadEnvFile('.env')
} catch {
  /* no .env: defaults everywhere */
}

const writes = process.argv.includes('--writes')

// A dim label per process, so the interleaved logs stay readable.
const paint = (tag, colour) => (line) =>
  line
    .toString()
    .split('\n')
    .filter((l) => l.length)
    .map((l) => `\x1b[${colour}m${tag}\x1b[0m ${l}`)
    .join('\n')

const children = []

/**
 * Jarvis must never bill the Anthropic API key in your shell. It is removed
 * from the environment of everything this launcher starts — your shell and
 * other tools keep it. The bridge also refuses to start if it can see one.
 */
const CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']
function jarvisEnv(extra) {
  const env = { ...process.env, ...extra }
  for (const k of CREDENTIALS) delete env[k]
  return env
}

function run(name, command, args, colour, env, { essential = true } = {}) {
  const label = paint(name, colour)
  const child = spawn(command, args, {
    env: jarvisEnv(env),
    shell: false,
  })
  child.stdout.on('data', (d) => process.stdout.write(label(d) + '\n'))
  child.stderr.on('data', (d) => process.stderr.write(label(d) + '\n'))
  child.on('exit', (code) => {
    // The voice service is not essential: without it the page falls back to
    // the browser's own speech, so say so and keep going.
    if (!essential) {
      if (!stopping) console.log(`\x1b[${colour}m${name}\x1b[0m exited (${code}); carrying on without it.`)
      return
    }
    // If either half dies the other is useless, so take the whole thing down
    // rather than leave a half-running app that looks alive but cannot answer.
    console.log(`\x1b[${colour}m${name}\x1b[0m exited (${code}); stopping the rest.`)
    shutdown(code ?? 0)
  })
  children.push(child)
  return child
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/**
 * Tell the bridge which port the face will actually be on.
 *
 * The bridge only trusts WebSocket origins on localhost:5173-5199 and
 * 4173-4199, which is the right default — a socket that any local page can open
 * is a socket that drives every MCP server on the machine. But a launcher that
 * assigns a port outside that range produces the single most confusing failure
 * this project has: the interface loads, the reactor spins, the microphone
 * hears you, and the brain answers nothing, because the handshake is being 403'd
 * somewhere neither half reports. Passing the port through closes that gap
 * without widening what the bridge trusts by default.
 */
const port = process.env.PORT
const bridgeEnv = {
  // Brains. Claude: Sonnet 5 at medium effort, on the subscription. Local: the
  // Jarvis Ollama's instruct model. Override any of these from your shell.
  JARVIS_MODEL: process.env.JARVIS_MODEL ?? 'claude-sonnet-5',
  JARVIS_EFFORT: process.env.JARVIS_EFFORT ?? 'medium',
  JARVIS_LOCAL_MODEL: process.env.JARVIS_LOCAL_MODEL ?? 'qwen3:30b-a3b-instruct-2507-q4_K_M',
  ...(writes ? { JARVIS_ALLOW_WRITES: '1' } : {}),
}
if (port) {
  bridgeEnv.JARVIS_ALLOWED_ORIGINS = `http://localhost:${port},http://127.0.0.1:${port}`
  console.log(`  serving the face on port ${port}; the bridge will accept it.\n`)
}

vendorWasm()

// Never start with writes, whatever was passed: Jarvis stays read-only except
// for Thunderbird's saveDraft, which the bridge allows on its own.
if (writes) {
  console.log('  --writes is disabled in this setup; starting read-only.\n')
  delete bridgeEnv.JARVIS_ALLOW_WRITES
}

/**
 * The Jarvis-only Ollama: 127.0.0.1:11435, models in ./ollama-models on the
 * internal drive. Your own Ollama on 11434 is never touched — and neither is
 * the external drive: ~/.ollama is a link to it, so this instance also gets its
 * own HOME (./ollama-home) for the key and history Ollama keeps in ~/.ollama.
 * Reused if it is already running; otherwise started here and
 * stopped with Jarvis. Its log goes to logs/ollama-jarvis.log.
 */
const OLLAMA_PORT = 11435
const OLLAMA_MODELS_DIR = resolve('ollama-models')
const OLLAMA_HOME_DIR = resolve('ollama-home')
const OLLAMA_MODEL = process.env.JARVIS_LOCAL_MODEL ?? 'qwen3:30b-a3b-instruct-2507-q4_K_M'
const up = async (url) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}
async function waitFor(url, seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await up(url)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

mkdirSync('logs', { recursive: true })

if (await up(`http://127.0.0.1:${OLLAMA_PORT}/api/version`)) {
  console.log(`  Jarvis Ollama already running on ${OLLAMA_PORT}.`)
} else {
  const ollamaBin = ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama']
    .find((p) => existsSync(p)) ?? 'ollama'
  mkdirSync(OLLAMA_HOME_DIR, { recursive: true })
  const log = openSync('logs/ollama-jarvis.log', 'a')
  const child = spawn(ollamaBin, ['serve'], {
    env: {
      ...jarvisEnv(),
      OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}`,
      OLLAMA_MODELS: OLLAMA_MODELS_DIR,
      HOME: OLLAMA_HOME_DIR,
      OLLAMA_CONTEXT_LENGTH: '32768',
      OLLAMA_KEEP_ALIVE: '30m',
    },
    stdio: ['ignore', log, log],
  })
  children.push(child)
  console.log(`  starting Jarvis Ollama on ${OLLAMA_PORT} (models in ${OLLAMA_MODELS_DIR})...`)
  if (!(await waitFor(`http://127.0.0.1:${OLLAMA_PORT}/api/version`, 20))) {
    console.log('  Jarvis Ollama did not come up; local lookups will fail. See logs/ollama-jarvis.log.')
  }
}
try {
  // A timeout, because an Ollama that is listening but stuck never answers.
  const tags = await (await fetch(`http://127.0.0.1:${OLLAMA_PORT}/api/tags`, { signal: AbortSignal.timeout(5000) })).json()
  if (!tags.models?.some((m) => m.name === OLLAMA_MODEL)) {
    console.log(`  ${OLLAMA_MODEL} is missing from the Jarvis Ollama. Pull it with:`)
    console.log(`    OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT} ollama pull ${OLLAMA_MODEL}`)
  } else {
    // Load it now so the first calendar question does not wait on 18 GB.
    void fetch(`http://127.0.0.1:${OLLAMA_PORT}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model: OLLAMA_MODEL, keep_alive: '30m' }),
    }).catch(() => {})
  }
} catch {
  /* reported above */
}

// The local voice service: faster-whisper, Kokoro/Piper, openWakeWord.
const VOICE_PY = 'voice/.venv/bin/python'
if (await up('http://127.0.0.1:8790/health')) {
  console.log('  local voice service already running on 8790.')
} else if (existsSync(VOICE_PY)) {
  run('voice', VOICE_PY, ['-u', 'voice/server.py'], '33', {}, { essential: false })
  console.log('  starting the local voice service (first start loads the models)...')
  if (!(await waitFor('http://127.0.0.1:8790/health', 60))) {
    console.log('  voice service not ready yet; the page will use the browser voice until it is.')
  }
} else {
  console.log('  voice/.venv not found — using the browser voice. See voice/README.md.')
}

console.log('\nJ.A.R.V.I.S. starting — the brain and the face.\n')
run('bridge', 'node', ['bridge/server.mjs'], '36', bridgeEnv)
// npm is a shell script on most systems; call the vite binary directly so we do
// not need shell:true (which would break the argument handling above).
run('face', process.execPath, ['node_modules/vite/bin/vite.js'], '35', {})

console.log(
  '\nWhen it says the dev server is ready, open the URL it prints in Chrome,\n' +
    'click INITIALISE, and say "Hey Jarvis". Ctrl-C stops everything.\n',
)

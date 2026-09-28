/**
 * JARVIS desktop wrapper.
 *
 * A frameless, see-through window over the desktop that shows the existing web
 * UI (the Vite "face" on http://localhost:5173). It changes nothing about the
 * bridge, routing or permissions: it runs the same launcher as `npm start`
 * (scripts/start.mjs) when Jarvis isn't already running, and stops it on quit.
 *
 * Security: only localhost:5173 is ever loaded; navigation elsewhere, pop-ups,
 * webviews and every non-local request are blocked; contextIsolation on,
 * nodeIntegration off, sandboxed renderer. The only permission granted is the
 * microphone, to localhost:5173.
 */

const {
  app, BrowserWindow, Tray, Menu, globalShortcut, session, shell, screen,
  ipcMain, nativeImage, systemPreferences, dialog,
} = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const FACE_ORIGIN = 'http://localhost:5173'
const FACE_URL = `${FACE_ORIGIN}/`
const BRIDGE_HEALTH = 'http://127.0.0.1:8787/health'
const JARVIS_HOME = process.env.JARVIS_HOME || path.join(os.homedir(), 'jarvis-home')
const NODE = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => fs.existsSync(p)) || 'node'
const ASSETS = path.join(__dirname, 'assets')

/** Hosts and ports the page may talk to. Everything else is cancelled. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const LOCAL_PORTS = new Set(['5173', '8787'])

let win = null
let tray = null
let launcher = null // the scripts/start.mjs process, when we started it
let quitting = false

/** To the console and to logs/desktop-app.log (there is no console when opened from Finder). */
function log(...a) {
  const line = `${new Date().toISOString()} [jarvis-desktop] ${a.join(' ')}`
  console.log(line)
  try {
    fs.appendFileSync(path.join(JARVIS_HOME, 'logs', 'desktop-app.log'), line + '\n')
  } catch {
    /* logs/ not there yet */
  }
}

// ---------------------------------------------------------------------------
// Window state
// ---------------------------------------------------------------------------

const STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json')

// ---------------------------------------------------------------------------
// Services: bridge + face + voice + Jarvis Ollama, via scripts/start.mjs
// ---------------------------------------------------------------------------

/**
 * Report a fatal problem and quit. Deliberately not dialog.showErrorBox: that
 * blocks the main process until dismissed, so nothing — not Quit, not a
 * SIGTERM — could shut Jarvis down while it was on screen. This version keeps
 * the app responsive and quits when the alert is dismissed (or on any signal).
 */
let failed = false
function fail(title, message) {
  log(`${title}: ${message.replace(/\n+/g, ' ')}`)
  if (failed || quitting) return
  failed = true
  dialog
    .showMessageBox({ type: 'error', title, message: title, detail: message, buttons: ['Quit Jarvis'] })
    .finally(() => app.quit())
}

async function up(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return res.status < 500
  } catch {
    return false
  }
}

async function ensureServices() {
  const [bridge, face] = await Promise.all([up(BRIDGE_HEALTH), up(FACE_URL)])
  if (bridge && face) {
    log('Jarvis is already running; attaching to it (it will keep running after quit).')
    return true
  }
  if (bridge || face) {
    fail(
      'Jarvis is half running',
      `The ${bridge ? 'bridge (8787)' : 'web UI (5173)'} is up but the ${bridge ? 'web UI (5173)' : 'bridge (8787)'} is not.\n\n` +
        'Stop the other copy of Jarvis (Ctrl-C in its terminal) and open the app again.',
    )
    return false
  }

  // The same launcher as `npm start`. It removes ANTHROPIC_API_KEY for
  // everything it starts, and the bridge still refuses to run if it sees one;
  // it is removed here as well so it never reaches the launcher at all.
  const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin'}` }
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ELECTRON_RUN_AS_NODE']) delete env[k]

  fs.mkdirSync(path.join(JARVIS_HOME, 'logs'), { recursive: true })
  const out = fs.openSync(path.join(JARVIS_HOME, 'logs', 'desktop-run.log'), 'a')
  launcher = spawn(NODE, ['scripts/start.mjs'], {
    cwd: JARVIS_HOME,
    env,
    stdio: ['ignore', out, out],
    detached: true, // its own process group, so quit can stop all of it
  })
  launcher.on('exit', (code) => {
    log(`launcher exited (${code})`)
    launcher = null
    if (!quitting) {
      fail('Jarvis stopped', `The Jarvis services exited (${code}). See ${JARVIS_HOME}/logs/desktop-run.log.`)
    }
  })
  log(`started scripts/start.mjs (pid ${launcher.pid}); log: logs/desktop-run.log`)

  // Ollama, the voice models and Vite take a few seconds between them.
  for (let i = 0; i < 180; i++) {
    if ((await up(BRIDGE_HEALTH)) && (await up(FACE_URL))) return true
    if (!launcher) return false
    await new Promise((r) => setTimeout(r, 500))
  }
  fail('Jarvis did not start', `See ${JARVIS_HOME}/logs/desktop-run.log.`)
  return false
}

function stopServices() {
  return new Promise((resolve) => {
    if (!launcher) return resolve()
    const child = launcher
    child.once('exit', () => resolve())
    try {
      // SIGINT to the whole group: the launcher, bridge, Vite, voice service
      // and (if it started it) the Jarvis Ollama all shut down cleanly.
      process.kill(-child.pid, 'SIGINT')
    } catch {
      resolve()
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
      resolve()
    }, 8000)
  })
}

// ---------------------------------------------------------------------------
// Security: permissions, navigation, requests
// ---------------------------------------------------------------------------

const originOf = (url) => {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function isAllowedRequest(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (['data:', 'blob:', 'devtools:'].includes(u.protocol)) return true
  if (!['http:', 'ws:'].includes(u.protocol)) return false
  return LOCAL_HOSTS.has(u.hostname) && LOCAL_PORTS.has(u.port)
}

function lockDownSession(ses) {
  // Microphone, for localhost:5173, audio only. Nothing else: no camera,
  // location, notifications, clipboard, MIDI, and so on.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = originOf(details.requestingUrl || wc.getURL())
    const types = details.mediaTypes ?? []
    const ok = permission === 'media' && origin === FACE_ORIGIN && types.length > 0 && types.every((t) => t === 'audio')
    log(`permission ${permission}${types.length ? ` [${types}]` : ''} from ${origin || '?'} -> ${ok ? 'granted' : 'denied'}`)
    callback(ok)
  })
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    return permission === 'media' && originOf(requestingOrigin) === FACE_ORIGIN && details?.mediaType === 'audio'
  })
  ses.setDevicePermissionHandler(() => false)

  // No remote content: only the face (5173) and the bridge (8787) on this machine.
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const ok = isAllowedRequest(details.url)
    if (!ok) log(`blocked request ${details.url.slice(0, 120)}`)
    callback({ cancel: !ok })
  })
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e, url) => {
    if (originOf(url) !== FACE_ORIGIN) {
      e.preventDefault()
      log(`blocked navigation to ${url}`)
    }
  })
  contents.on('will-redirect', (e, url) => {
    if (originOf(url) !== FACE_ORIGIN) e.preventDefault()
  })
  contents.on('will-attach-webview', (e) => e.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    log(`blocked pop-up ${url}`)
    return { action: 'deny' }
  })
})

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/**
 * Clicks pass through fully transparent pixels.
 *
 * The page can't know which of its pixels are see-through — the reactor is a
 * WebGL canvas covering the whole window — so this asks the compositor: twenty
 * times a second, while the cursor is over the window, sample the few pixels
 * under it. Anything visible there (the reactor, text, a panel) takes the
 * click; pure transparency lets it fall through to whatever is behind.
 */
let ignoring = null
let dragging = null

function setIgnore(ignore) {
  if (ignore === ignoring || !win || win.isDestroyed()) return
  ignoring = ignore
  win.setIgnoreMouseEvents(ignore, { forward: true })
}

/** Drag by the reactor: the preload reports a press-and-move on the canvas. */
ipcMain.on('jarvis:drag-start', () => {
  if (!win) return
  const cursor = screen.getCursorScreenPoint()
  const [wx, wy] = win.getPosition()
  dragging = { cursor, wx, wy }
  setIgnore(false)
  const tick = setInterval(() => {
    if (!dragging || !win || win.isDestroyed()) return clearInterval(tick)
    const p = screen.getCursorScreenPoint()
    win.setPosition(dragging.wx + p.x - dragging.cursor.x, dragging.wy + p.y - dragging.cursor.y)
  }, 16)
  dragging.tick = tick
})
ipcMain.on('jarvis:drag-end', () => {
  if (dragging) clearInterval(dragging.tick)
  dragging = null
  saveState()
})

// ---------------------------------------------------------------------------
// Menu bar icon and shortcut
// ---------------------------------------------------------------------------

function toggleWindow() {
  if (!win) return
  if (win.isVisible()) win.hide()
  else {
    win.show()
    win.focus()
  }
  rebuildTrayMenu()
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Jarvis')
  rebuildTrayMenu()
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
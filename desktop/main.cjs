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

/**
 * The backdrop behind the page, from the menu bar icon, remembered between
 * launches. Clear: see-through, clicks pass through empty areas. Frosted
 * (default): native macOS vibrancy, like Control Center. Dark: an 85% opaque
 * panel. The page styles itself from <html data-backdrop> (see preload.cjs).
 */
const BACKDROPS = { clear: 'Clear', frosted: 'Frosted', dark: 'Dark' }
let backdrop = 'frosted'

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

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'))
    // Only reuse a position that is still on a connected display.
    const onScreen = screen.getAllDisplays().some((d) => {
      const b = d.workArea
      return s.x + 80 > b.x && s.x < b.x + b.width - 80 && s.y + 80 > b.y && s.y < b.y + b.height - 80
    })
    return onScreen ? s : { width: s.width, height: s.height, alwaysOnTop: s.alwaysOnTop, backdrop: s.backdrop }
  } catch {
    return {}
  }
}

let saveTimer = null
function saveState() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return
    const state = { ...win.getBounds(), alwaysOnTop: win.isAlwaysOnTop(), backdrop }
    try {
      fs.writeFileSync(STATE_FILE(), JSON.stringify(state))
    } catch (err) {
      log('could not save window state:', err.message)
    }
  }, 300)
}

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

function createWindow() {
  const s = loadState()
  if (BACKDROPS[s.backdrop]) backdrop = s.backdrop
  win = new BrowserWindow({
    x: s.x,
    y: s.y,
    width: s.width || 900,
    height: s.height || 900,
    minWidth: 320,
    minHeight: 320,
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    // Frosted is native vibrancy; 'active' keeps it frosted when unfocused.
    vibrancy: backdrop === 'frosted' ? 'hud' : undefined,
    visualEffectState: 'active',
    roundedCorners: true,
    alwaysOnTop: Boolean(s.alwaysOnTop),
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    title: 'Jarvis',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webgl: true,
      spellcheck: false,
      // Keep listening for "hey jarvis" while hidden or behind other windows.
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      devTools: !app.isPackaged,
    },
  })

  win.on('moved', saveState)
  win.on('resized', saveState)
  win.on('close', (e) => {
    // The window only hides; Quit is in the menu bar icon.
    if (!quitting) {
      e.preventDefault()
      win.hide()
      rebuildTrayMenu()
    }
  })

  win.loadURL(FACE_URL)
  win.once('ready-to-show', () => {
    win.show()
    log(`window shown at ${JSON.stringify(win.getBounds())}, always on top: ${win.isAlwaysOnTop()}`)
    rebuildTrayMenu()
    startClickThrough()
    // Test aids only: click INITIALISE automatically, and save what the
    // compositor receives (with its alpha channel) to prove it is see-through.
    if (process.env.JARVIS_DESKTOP_AUTOINIT === '1') {
      setTimeout(() => win.webContents.executeJavaScript("document.querySelector('.ignition')?.click()", true), 1500)
    }
    if (process.env.JARVIS_DESKTOP_SNAPSHOT) {
      setTimeout(async () => {
        const img = await win.webContents.capturePage()
        fs.writeFileSync(process.env.JARVIS_DESKTOP_SNAPSHOT, img.toPNG())
        const bmp = img.toBitmap()
        let clear = 0
        for (let i = 3; i < bmp.length; i += 4) if (bmp[i] === 0) clear++
        log(`snapshot ${img.getSize().width}x${img.getSize().height}: ${((100 * clear) / (bmp.length / 4)).toFixed(1)}% of pixels fully transparent`)
      }, 12000)
    }
  })
}

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

function setBackdrop(mode) {
  if (!BACKDROPS[mode] || !win) return
  backdrop = mode
  win.setVibrancy(mode === 'frosted' ? 'hud' : null)
  win.webContents.send('jarvis:backdrop', mode)
  // A panel (Frosted, Dark) takes every click; only Clear passes them through.
  if (mode !== 'clear') setIgnore(false)
  log(`backdrop ${mode}`)
  saveState()
  rebuildTrayMenu()
}

ipcMain.on('jarvis:get-backdrop', (e) => {
  e.returnValue = backdrop
})

function startClickThrough() {
  setIgnore(backdrop === 'clear')
  let busy = false
  setInterval(async () => {
    if (busy || !win || win.isDestroyed() || !win.isVisible() || dragging) return
    if (backdrop !== 'clear') return setIgnore(false)
    const p = screen.getCursorScreenPoint()
    const b = win.getBounds()
    const x = p.x - b.x
    const y = p.y - b.y
    if (x < 0 || y < 0 || x >= b.width || y >= b.height) return setIgnore(true)
    busy = true
    try {
      const r = 4
      const img = await win.webContents.capturePage({
        x: Math.max(0, x - r), y: Math.max(0, y - r), width: 2 * r + 1, height: 2 * r + 1,
      })
      const bmp = img.toBitmap() // BGRA
      let alpha = 0
      for (let i = 3; i < bmp.length; i += 4) alpha = Math.max(alpha, bmp[i])
      // 48, not 1: the reactor's particle cloud leaves faint specks (alpha
      // under 40) across the window, and those should not catch clicks.
      setIgnore(alpha < 48)
    } catch {
      /* window mid-resize; try again next tick */
    } finally {
      busy = false
    }
  }, 50)
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

function rebuildTrayMenu() {
  if (!tray || !win) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: win.isVisible() ? 'Hide Jarvis' : 'Show Jarvis', accelerator: 'Cmd+Shift+J', click: toggleWindow },
      {
        label: 'Always on Top',
        type: 'checkbox',
        checked: win.isAlwaysOnTop(),
        click: (item) => {
          win.setAlwaysOnTop(item.checked, 'floating')
          saveState()
        },
      },
      {
        label: 'Backdrop',
        submenu: Object.entries(BACKDROPS).map(([mode, label]) => ({
          label,
          type: 'radio',
          checked: backdrop === mode,
          click: () => setBackdrop(mode),
        })),
      },
      { label: 'Open in Browser', click: () => shell.openExternal(FACE_URL) },
      { type: 'separator' },
      { label: 'Quit Jarvis', accelerator: 'Cmd+Q', click: () => app.quit() },
    ]),
  )
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

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    win?.show()
    win?.focus()
  })

  app.whenReady().then(async () => {
    app.dock?.hide() // a menu bar app: no Dock icon
    createTray()
    lockDownSession(session.defaultSession)

    // Ask for the microphone up front, so the macOS prompt appears now rather
    // than the first time the wake word listens. Not awaited: the prompt
    // waits on the user, and the services should not.
    log(`microphone status: ${systemPreferences.getMediaAccessStatus('microphone')}`)
    systemPreferences
      .askForMediaAccess('microphone')
      .then((mic) => log(`microphone access: ${mic ? 'granted' : 'denied'}`))
      .catch((err) => log('microphone prompt failed:', err.message))

    // On failure, fail() has already put up the alert that quits.
    if (!(await ensureServices())) return

    createWindow()
    if (!globalShortcut.register('CommandOrControl+Shift+J', toggleWindow)) {
      log('Cmd+Shift+J is taken by another app')
    }
  })

  app.on('before-quit', async (e) => {
    if (quitting) return
    quitting = true
    e.preventDefault()
    saveState()
    globalShortcut.unregisterAll()
    await stopServices()
    app.exit(0)
  })

  // Stay alive in the menu bar with no windows open.
  app.on('window-all-closed', () => {})

  // `kill`, logout and shutdown: stop the services on the way out, too.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => app.quit())

  // Debug aid: `kill -USR2 <pid>` steps to the next backdrop (for screenshots).
  process.on('SIGUSR2', () => {
    const modes = Object.keys(BACKDROPS)
    setBackdrop(modes[(modes.indexOf(backdrop) + 1) % modes.length])
  })
}

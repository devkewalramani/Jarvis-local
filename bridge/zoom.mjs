/**
 * Jarvis in a Zoom call: a dedicated Chrome window running Zoom's web client
 * under the name "J.A.R.V.I.S.", with OBS's virtual camera (the meeting tile)
 * as its camera.
 *
 *   POST /zoom/join   -> join the meeting on the calendar now (voice or shortcut only)
 *   POST /zoom/leave  -> close that window and stop the camera
 *   GET  /zoom/status -> { state, detail, since }
 *
 * The window is its own Chrome instance with its own data folder (the Jarvis
 * profile), so it shares nothing with the user's own Chrome profiles. It is
 * driven over Chrome's DevTools pipe (file descriptors 3 and 4, never a network
 * port), so only this process can control it.
 *
 * Audio, by construction:
 *  - Chrome runs with --mute-audio: the call is never played out loud.
 *  - The page can see one camera, the OBS Virtual Camera, and no microphone at
 *    all: device lists are filtered and any request for audio is refused, and
 *    the microphone permission is denied for Zoom. Jarvis never listens to or
 *    records a call.
 */

import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const PROFILE_DIR = join(homedir(), 'Library', 'Application Support', 'Jarvis', 'zoom-chrome')
export const DISPLAY_NAME = 'J.A.R.V.I.S.'
const ZOOM_ORIGINS = ['https://app.zoom.us', 'https://zoom.us']
const OBS_ARGS = ['--profile', 'Jarvis', '--collection', 'Jarvis', '--scene', 'Jarvis', '--startvirtualcam', '--disable-updater']

/** Create the Jarvis Chrome profile on first use, named so it is recognisable. */
export function ensureProfile() {
  const prefs = join(PROFILE_DIR, 'Default', 'Preferences')
  if (existsSync(prefs)) return
  mkdirSync(join(PROFILE_DIR, 'Default'), { recursive: true })
  writeFileSync(prefs, JSON.stringify({ profile: { name: 'Jarvis' } }))
}

/** Zoom's web client for a meeting link: /j/<id>?pwd=... -> app.zoom.us/wc/<id>/join?pwd=... */
export function webClientUrl(link) {
  const url = new URL(link)
  const id = /\/(?:j|w|s|wc)\/(\d{9,12})/.exec(url.pathname)?.[1]
  if (!id) return link // a personal link: open it and take "join from your browser"
  const pwd = url.searchParams.get('pwd')
  return `https://app.zoom.us/wc/${id}/join${pwd ? `?pwd=${encodeURIComponent(pwd)}` : ''}`
}

/**
 * Runs in every Zoom page before its own scripts: the only camera is OBS's
 * virtual camera and there is no microphone.
 */
const MEDIA_GUARD = `(() => {
  const md = navigator.mediaDevices
  if (!md || md.__jarvis) return
  const CAMERA = /OBS Virtual Camera/i
  const list = md.enumerateDevices.bind(md)
  const gum = md.getUserMedia.bind(md)
  let camera = null
  const find = async () => {
    const all = await list()
    camera = all.find((d) => d.kind === 'videoinput' && CAMERA.test(d.label))?.deviceId ?? camera
    return all
  }
  md.enumerateDevices = async () =>
    (await find()).filter((d) => (d.kind === 'videoinput' ? CAMERA.test(d.label) : d.kind !== 'audioinput'))
  md.getUserMedia = async (c = {}) => {
    if (c.audio) throw new DOMException('Jarvis joins without a microphone', 'NotAllowedError')
    if (c.video) {
      if (!camera) await find()
      if (!camera) throw new DOMException('OBS Virtual Camera not found', 'NotFoundError')
      c = { ...c, video: { ...(typeof c.video === 'object' ? c.video : {}), deviceId: { exact: camera } } }
    }
    return gum(c)
  }
  Object.defineProperty(md, '__jarvis', { value: true })
})()`

/**
 * One step of the join flow, run in the page every second. Fills the name,
 * presses Join, starts the video, closes prompts, and reports where it is.
 */
const JOIN_STEP = (name) => `(() => {
  const text = (el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim()
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
  const buttons = () => [...document.querySelectorAll('button, [role=button], a')].filter(visible)
  const button = (re) => buttons().find((b) => re.test(text(b)))
  const page = document.body ? document.body.innerText : ''
  if (/sign in to join|only authenticated users|sign in to zoom/i.test(page) && !document.querySelector('#input-for-name'))
    return 'signin'
  if (/meeting passcode|enter.*passcode/i.test(page) && document.querySelector('#input-for-pwd'))
    return 'passcode'
  if (/meeting has been ended|meeting has ended|this meeting link is invalid|invalid meeting id/i.test(page)) return 'ended'
  if (/waiting room|host will let you in|please wait.*host/i.test(page)) return 'waiting'
  const browserLink = button(/join from (your )?browser/i)
  if (browserLink) { browserLink.click(); return 'landing' }
  const input = document.querySelector('#input-for-name') || document.querySelector('input[placeholder*="name" i]')
  if (input) {
    if (input.value !== ${JSON.stringify(name)}) {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(input, ${JSON.stringify(name)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return 'preview'
    }
    const join = button(/^\\s*join\\s*$/i)
    if (join && !join.disabled) { join.click(); return 'joining' }
    return 'preview'
  }
  const leave = button(/^\\s*leave\\b|leave meeting/i)
  if (leave) {
    const start = button(/start (my )?video/i)
    if (start) { start.click(); return 'starting-video' }
    const close = button(/^\\s*(close|got it|ok|not now|dismiss)\\s*$/i)
    if (close) close.click()
    return button(/stop (my )?video/i) ? 'in-call' : 'in-call-no-video'
  }
  return 'loading'
})()`

const PROGRESS = {
  launching: 'Opening Zoom.',
  landing: 'Opening Zoom.',
  loading: 'Opening Zoom.',
  preview: 'On the join screen.',
  joining: 'Joining.',
  waiting: 'In the waiting room. Admit J.A.R.V.I.S. when you are ready.',
  'starting-video': 'In the call, starting the camera.',
  'in-call-no-video': 'In the call, but the camera is not on yet.',
  'in-call': 'In the call, muted, camera on.',
  signin: 'Zoom wants a sign in for this meeting. Sign in once in the Jarvis Chrome window.',
  passcode: 'Zoom is asking for the meeting passcode.',
  ended: 'Zoom says that meeting has ended or the link is invalid.',
  left: 'Left the meeting.',
  idle: 'Not in a meeting.',
  error: 'Something went wrong joining.',
}

/** A Chrome DevTools Protocol connection over the --remote-debugging-pipe file descriptors. */
class Pipe {
  constructor(child) {
    this.out = child.stdio[3]
    this.waiting = new Map()
    this.next = 1
    let buf = ''
    child.stdio[4].on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\0')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        const w = msg.id && this.waiting.get(msg.id)
        if (w) {
          this.waiting.delete(msg.id)
          msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result)
        }
      }
    })
    child.on('exit', () => {
      for (const w of this.waiting.values()) w.reject(new Error('Chrome closed'))
      this.waiting.clear()
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.next++
    this.out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      setTimeout(() => this.waiting.delete(id) && reject(new Error(`${method} timed out`)), 15000)
    })
  }
}

const obsRunning = async () => {
  try {
    await run('/usr/bin/pgrep', ['-f', 'OBS.app/Contents/MacOS/OBS'])
    return true
  } catch {
    return false
  }
}

/** Start OBS on the Jarvis scene with the virtual camera, in the background. */
export async function startCamera() {
  if (await obsRunning()) return
  await run('/usr/bin/open', ['-g', '-a', 'OBS', '--args', ...OBS_ARGS])
}

/** Stop the camera by quitting OBS cleanly (SIGTERM; the exit confirmation is off). */
export async function stopCamera() {
  try {
    await run('/usr/bin/pkill', ['-TERM', '-f', 'OBS.app/Contents/MacOS/OBS --'])
  } catch {
    /* not running */
  }
}

/** What the Zoom page can see: every media device it is offered, by kind and label. */
const PROBE = `navigator.mediaDevices.enumerateDevices().then((l) => l.map((d) => d.kind + ': ' + (d.label || '(no label)')))`

export async function probeDevices() {
  if (!session?.sessionId) return null
  const { result } = await session.pipe.send(
    'Runtime.evaluate',
    { expression: PROBE, awaitPromise: true, returnByValue: true },
    session.sessionId,
  )
  return result?.value ?? null
}

let session = null
let status = { state: 'idle', detail: PROGRESS.idle, since: Date.now() }

const setStatus = (state, extra = '') => {
  if (status.state !== state) console.log(`[zoom] ${state}${extra ? ` ${extra}` : ''}`)
  status = {
    state,
    detail: PROGRESS[state] ?? extra,
    since: status.state === state ? status.since : Date.now(),
    ...(status.devices && state !== 'left' ? { devices: status.devices } : {}),
  }
}

export const zoomStatus = () => status

/**
 * Join: open the Jarvis Chrome window on Zoom's web client, then keep stepping
 * through the join flow in the background (the waiting room can take a while).
 * Resolves once the window is open; progress is in zoomStatus().
 */
export async function joinZoom(link) {
  if (session) return { ok: true, already: true, status }
  ensureProfile()
  await startCamera()
  setStatus('launching')
  const child = spawn(
    CHROME,
    [
      `--user-data-dir=${PROFILE_DIR}`,
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--window-size=1280,860',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  )
  const pipe = new Pipe(child)
  session = { child, pipe, stop: false }
  child.on('exit', () => {
    if (session?.child === child) session = null
    setStatus('left')
  })

  try {
    for (const origin of ZOOM_ORIGINS) {
      await pipe.send('Browser.setPermission', { permission: { name: 'camera' }, setting: 'granted', origin })
      await pipe.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'denied', origin })
    }
    const { targetInfos } = await pipe.send('Target.getTargets')
    const page = targetInfos.find((t) => t.type === 'page')
    const { sessionId } = await pipe.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    await pipe.send('Page.enable', {}, sessionId)
    await pipe.send('Page.addScriptToEvaluateOnNewDocument', { source: MEDIA_GUARD }, sessionId)
    await pipe.send('Page.navigate', { url: webClientUrl(link) }, sessionId)
    session.sessionId = sessionId
  } catch (err) {
    setStatus('error', err.message)
    await leaveZoom()
    return { ok: false, status }
  }

  void stepUntilJoined(session)
  return { ok: true, status }
}

async function stepUntilJoined(s) {
  const deadline = Date.now() + 15 * 60_000
  let inCallFor = 0
  while (!s.stop && session === s && Date.now() < deadline) {
    try {
      const { result } = await s.pipe.send('Runtime.evaluate', { expression: JOIN_STEP(DISPLAY_NAME), returnByValue: true }, s.sessionId)
      const state = result?.value ?? 'loading'
      setStatus(state)
      if (state !== 'loading' && !s.devicesLogged) {
        s.devicesLogged = true
        status.devices = await probeDevices().catch(() => null)
        console.log(`[zoom] the page sees: ${JSON.stringify(status.devices)}`)
      }
      if (state === 'ended') return
      if (state === 'in-call' && ++inCallFor >= 5) return // settled: stop touching the page
    } catch {
      /* navigating; try again */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/** Leave: close the Jarvis Chrome window and stop the camera. */
export async function leaveZoom() {
  const s = session
  session = null
  if (s) {
    s.stop = true
    try {
      await s.pipe.send('Browser.close')
    } catch {
      /* already gone */
    }
    setTimeout(() => s.child.exitCode === null && s.child.kill('SIGTERM'), 3000)
  }
  await stopCamera()
  setStatus('left')
  return { ok: true, status }
}

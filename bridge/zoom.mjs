/**
 * Jarvis in a Zoom call: a dedicated Chrome window running Zoom's web client
 * under the name "J.A.R.V.I.S.", with OBS's virtual camera (the meeting tile)
 * as its camera.
 *
 *   POST /zoom/join   -> join the meeting on the calendar now (voice or shortcut only)
 *   POST /zoom/leave  -> close that window and stop the camera
 *   GET  /zoom/status -> { state, detail, since, muted }
 *   POST /zoom/intro  -> the spoken introduction (Cmd+Shift+I only; see playIntro)
 *
 * The window is its own Chrome instance with its own data folder (the Jarvis
 * profile), so it shares nothing with the user's own Chrome profiles. It is
 * driven over Chrome's DevTools pipe (file descriptors 3 and 4, never a network
 * port), so only this process can control it.
 *
 * Audio, by construction:
 *  - Chrome runs with --mute-audio: the call is never played out loud, and
 *    nothing reads what the call says. Jarvis never listens to or records a call.
 *  - The page can see one camera, the OBS Virtual Camera, and one microphone,
 *    BlackHole 2ch: device lists are filtered, every audio request is pinned to
 *    BlackHole, and without BlackHole audio is refused rather than falling back
 *    to a real microphone. Chrome's default capture device for this profile is
 *    BlackHole too. Nothing feeds BlackHole except play-to-device, and only for
 *    the introduction, so the room and your microphone can never reach the call
 *    through Jarvis.
 *  - Speakers: the page sees only the default output and cannot switch output
 *    devices (setSinkId), so the call's sound can never go into BlackHole.
 *  - Zoom audio is joined muted and kept muted: the watcher mutes it again
 *    within two seconds if it is ever found unmuted outside the introduction.
 */

import { spawn, execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const PROFILE_DIR = join(homedir(), 'Library', 'Application Support', 'Jarvis', 'zoom-chrome')
export const DISPLAY_NAME = 'J.A.R.V.I.S.'
const ZOOM_ORIGINS = ['https://app.zoom.us', 'https://zoom.us']
const OBS_ARGS = ['--profile', 'Jarvis', '--collection', 'Jarvis', '--scene', 'Jarvis', '--startvirtualcam', '--disable-updater']
/**
 * OBS leaves a run marker here while it runs. One left by an instance that
 * did not exit cleanly makes the next launch stop at a "run in safe mode?"
 * dialog (OBS 32 has no flag to skip it), and while that is up OBS ignores
 * SIGTERM. Cleared before launch, and only when no OBS is running at all.
 */
const OBS_SENTINELS = join(homedir(), 'Library', 'Application Support', 'obs-studio', '.sentinel')
/** Jarvis's OBS: the instance started on the Jarvis profile, whoever launched it. Your own OBS use is untouched. */
const JARVIS_OBS = '^/Applications/OBS.app/Contents/MacOS/OBS --profile Jarvis'

/** The microphone Jarvis's Zoom window may use, and nothing else. */
export const VOICE_DEVICE = 'BlackHole 2ch'
const VOICE_DEVICE_UID = 'BlackHole2ch_UID'

/**
 * The Jarvis Chrome profile, named so it is recognisable, with BlackHole as
 * its default microphone. Written before each launch (Chrome is not running).
 */
export function ensureProfile() {
  const prefs = join(PROFILE_DIR, 'Default', 'Preferences')
  mkdirSync(join(PROFILE_DIR, 'Default'), { recursive: true })
  let p = {}
  try {
    p = JSON.parse(readFileSync(prefs, 'utf8'))
  } catch {
    /* first run */
  }
  p.profile = { ...(p.profile ?? {}), name: 'Jarvis' }
  p.media = { ...(p.media ?? {}), default_audio_capture_device: VOICE_DEVICE_UID }
  writeFileSync(prefs, JSON.stringify(p))
}

/** The helper that plays a file to one named device (play-to-device.swift), built on first use. */
const HERE = dirname(fileURLToPath(import.meta.url))
const HELPER_SRC = join(HERE, 'play-to-device.swift')
const HELPER = join(HERE, '.bin', 'play-to-device')

export async function ensureHelper() {
  const fresh = existsSync(HELPER) && statSync(HELPER).mtimeMs >= statSync(HELPER_SRC).mtimeMs
  if (fresh) return HELPER
  mkdirSync(dirname(HELPER), { recursive: true })
  await run('/usr/bin/swiftc', ['-O', HELPER_SRC, '-o', HELPER], { timeout: 180_000 })
  return HELPER
}

/** The default output and system-sound devices, so nothing else can be playing into BlackHole. */
async function defaultOutputs() {
  const { stdout } = await run(await ensureHelper(), ['--defaults'], { timeout: 5000 })
  return stdout.trim().split('\n')
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
 * virtual camera and the only microphone is BlackHole. No BlackHole, no audio.
 */
const MEDIA_GUARD = `(() => {
  const md = navigator.mediaDevices
  if (!md || md.__jarvis) return
  const CAMERA = /OBS Virtual Camera/i
  const MIC = /^BlackHole 2ch\\b/
  const list = md.enumerateDevices.bind(md)
  const gum = md.getUserMedia.bind(md)
  let camera = null
  let mic = null
  const find = async () => {
    const all = await list()
    camera = all.find((d) => d.kind === 'videoinput' && CAMERA.test(d.label))?.deviceId ?? camera
    mic = all.find((d) => d.kind === 'audioinput' && MIC.test(d.label))?.deviceId ?? mic
    return all
  }
  // Speakers: only the system default, never BlackHole, so the call's own
  // sound can never be written into Jarvis's microphone.
  md.enumerateDevices = async () =>
    (await find()).filter((d) =>
      d.kind === 'videoinput' ? CAMERA.test(d.label)
        : d.kind === 'audioinput' ? MIC.test(d.label)
        : d.deviceId === 'default')
  const onlyDefault = (proto) => {
    if (!proto || !proto.setSinkId) return
    const set = proto.setSinkId
    proto.setSinkId = function (id) {
      if (id && id !== 'default' && typeof id !== 'object')
        return Promise.reject(new DOMException('Jarvis plays only to the default output', 'NotAllowedError'))
      return set.call(this, id)
    }
  }
  onlyDefault(window.HTMLMediaElement && HTMLMediaElement.prototype)
  onlyDefault(window.AudioContext && AudioContext.prototype)
  md.getUserMedia = async (c = {}) => {
    if (c.audio) {
      if (!mic) await find()
      if (!mic) throw new DOMException('BlackHole 2ch not found; Jarvis has no other microphone', 'NotFoundError')
      c = {
        ...c,
        audio: {
          ...(typeof c.audio === 'object' ? c.audio : {}),
          deviceId: { exact: mic },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      }
    }
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
  if (/this meeting link is invalid|invalid meeting id|meeting id is not valid/i.test(page)) return 'invalid'
  if (/meeting has been ended|meeting has ended|ended by (the )?host/i.test(page)) return 'ended'
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
    // Muted on the join screen, so audio starts muted.
    const previewMute = button(/^\\s*mute\\s*$/i)
    if (previewMute) { previewMute.click(); return 'preview' }
    const join = button(/^\\s*join\\s*$/i)
    if (join && !join.disabled) { join.click(); return 'joining' }
    return 'preview'
  }
  const leave = button(/^\\s*leave\\b|leave meeting/i)
  if (leave) {
    const start = button(/start (my )?video/i)
    if (start) { start.click(); return 'starting-video' }
    const audio = button(/join (with )?(computer )?audio|join audio by computer/i)
    if (audio) { audio.click(); return 'joining-audio' }
    const unmuted = button(/^\\s*mute( my microphone)?\\b/i)
    if (unmuted) { unmuted.click(); return 'muting' }
    const close = button(/^\\s*(close|got it|ok|not now|dismiss)\\s*$/i)
    if (close) close.click()
    if (!button(/stop (my )?video/i)) return 'in-call-no-video'
    return button(/unmute( my microphone)?\\b/i) ? 'in-call' : 'in-call-no-audio'
  }
  return 'loading'
})()`

/**
 * Once in the call, a read-only look at the page every two seconds: still in
 * the call, or ended (the host ended it, Jarvis was removed, or the meeting
 * controls are gone). Clicks nothing.
 */
const CALL_STATE = `(() => {
  const page = document.body ? document.body.innerText : ''
  if (/meeting has been ended|meeting has ended|ended by (the )?host|you have been removed|removed you from the meeting|you left the meeting/i.test(page)) return { state: 'ended' }
  const labels = [...document.querySelectorAll('button, [role=button]')].map((b) =>
    ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim())
  const leave = labels.some((t) => /^\\s*leave\\b|leave meeting/i.test(t))
  const mic = labels.some((t) => /^\\s*unmute( my microphone)?\\b/i.test(t)) ? 'muted'
    : labels.some((t) => /^\\s*mute( my microphone)?\\b/i.test(t)) ? 'unmuted' : 'none'
  return { state: leave ? 'in-call' : 'gone', mic }
})()`

/** Click the microphone button towards 'muted' or 'unmuted'; true if a button was there to click. */
const MIC_CLICK = (to) => {
  const re = to === 'muted' ? String.raw`/^\s*mute( my microphone)?\b/i` : String.raw`/^\s*unmute( my microphone)?\b/i`
  return `(() => {
  const re = ${re}
  const b = [...document.querySelectorAll('button, [role=button]')].find((b) =>
    re.test(((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim()))
  if (b) b.click()
  return !!b
})()`
}

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
  ended: 'The call has ended.',
  invalid: 'Zoom says that meeting link is invalid.',
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

/**
 * The OBS process Jarvis launched. Tracked by PID because macOS does not
 * always put the launch arguments on the process's command line (seen when a
 * previous OBS was still exiting), so matching by arguments alone can miss it.
 */
let obsPid = null
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const obsRunning = async () => {
  if (obsPid && alive(obsPid)) return true
  try {
    await run('/usr/bin/pgrep', ['-f', JARVIS_OBS])
    return true
  } catch {
    return false
  }
}

/** Start OBS on the Jarvis scene with the virtual camera, in the background. */
export async function startCamera() {
  if (await obsRunning()) return
  const anyObs = await run('/usr/bin/pgrep', ['-f', '^/Applications/OBS.app/Contents/MacOS/OBS']).then(() => true, () => false)
  if (!anyObs) {
    for (const f of await readdir(OBS_SENTINELS).catch(() => [])) {
      if (f.startsWith('run_')) await rm(join(OBS_SENTINELS, f), { force: true })
    }
  }
  // -n: always a fresh instance, so the arguments reach it; -g: in the background.
  await run('/usr/bin/open', ['-g', '-n', '-a', 'OBS', '--args', ...OBS_ARGS])
  for (let i = 0; i < 20 && !obsPid; i++) {
    const { stdout } = await run('/usr/bin/pgrep', ['-n', '-f', '^/Applications/OBS.app/Contents/MacOS/OBS( |$)']).catch(() => ({ stdout: '' }))
    obsPid = Number(stdout.trim()) || null
    if (!obsPid) await new Promise((r) => setTimeout(r, 250))
  }
  console.log(`[zoom] camera: OBS started (pid ${obsPid ?? 'unknown'})`)
}

/**
 * Stop the camera by quitting Jarvis's OBS: SIGTERM (a clean quit; the exit
 * confirmation is off), then SIGKILL if it is still there after five seconds.
 */
export async function stopCamera() {
  const signal = async (sig) => {
    if (obsPid && alive(obsPid)) {
      try {
        process.kill(obsPid, sig)
      } catch {
        /* gone */
      }
    }
    await run('/usr/bin/pkill', [sig === 'SIGKILL' ? '-KILL' : '-TERM', '-f', JARVIS_OBS]).catch(() => {})
  }
  await signal('SIGTERM')
  for (let i = 0; i < 10 && (await obsRunning()); i++) await new Promise((r) => setTimeout(r, 500))
  if (await obsRunning()) await signal('SIGKILL')
  obsPid = null
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
    ...(session ? { muted: status.muted ?? null } : {}),
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
    // The window closed under us (Chrome quit or crashed): the call is over.
    if (session?.child === child) {
      session = null
      void stopCamera()
      setStatus('ended')
    }
  })

  try {
    for (const origin of ZOOM_ORIGINS) {
      await pipe.send('Browser.setPermission', { permission: { name: 'camera' }, setting: 'granted', origin })
      // Granted only because BlackHole is the one microphone the page can reach (MEDIA_GUARD).
      await pipe.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'granted', origin })
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
    await leaveZoom('error')
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
      if (state === 'ended' || state === 'invalid') return void endCall(s, state)
      if (state === 'in-call' && ++inCallFor >= 5) return void watchCall(s) // settled: stop touching the page
      // Without BlackHole there is no audio to join: still watch the call.
      if (state === 'in-call-no-audio' && ++inCallFor >= 20) return void watchCall(s)
    } catch {
      /* navigating; try again */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/** In the call: watch (read only) until it ends, then leave on our own. */
async function watchCall(s) {
  s.watching = true
  let gone = 0
  while (!s.stop && session === s) {
    await new Promise((r) => setTimeout(r, 2000))
    if (s.stop || session !== s) return
    try {
      const { result } = await s.pipe.send('Runtime.evaluate', { expression: CALL_STATE, returnByValue: true }, s.sessionId)
      const { state, mic } = result?.value ?? {}
      if (state === 'ended') return void endCall(s, 'ended')
      gone = state === 'gone' ? gone + 1 : 0
      // Muted except during the introduction: found unmuted, mute again.
      if (mic === 'unmuted' && !s.intro) {
        console.log('[zoom] microphone found unmuted outside the introduction; muting')
        await s.pipe.send('Runtime.evaluate', { expression: MIC_CLICK('muted'), returnByValue: true }, s.sessionId)
      }
      status.muted = mic === 'muted' ? true : mic === 'unmuted' ? false : null
      if (gone >= 5) return void endCall(s, 'ended') // no meeting controls for ten seconds
    } catch {
      if (++gone >= 5) return void endCall(s, 'ended')
    }
  }
}

/** The microphone's state in the Zoom page: 'muted', 'unmuted' or 'none' (audio not joined). */
async function micState(s) {
  const { result } = await s.pipe.send('Runtime.evaluate', { expression: CALL_STATE, returnByValue: true }, s.sessionId)
  return result?.value?.mic ?? 'none'
}

/** Click towards `to` and wait up to three seconds for Zoom to show it; true if it did. */
async function setMic(s, to) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await s.pipe.send('Runtime.evaluate', { expression: MIC_CLICK(to), returnByValue: true }, s.sessionId)
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 250))
      if ((await micState(s)) === to) return true
    }
  }
  return false
}

/**
 * The introduction, on Cmd+Shift+I only: unmute Jarvis's Zoom window, play the
 * prepared file to BlackHole, mute again, and verify Zoom shows it muted.
 * Refuses (and plays nothing) unless Jarvis is in the call with its audio
 * joined, BlackHole is present, and neither the default output nor system
 * sounds go to BlackHole, so nothing but the introduction can reach the call.
 */
export async function playIntro(file) {
  const s = session
  if (!s || !['in-call', 'in-call-no-audio'].includes(status.state) && !s.watching)
    return { ok: false, message: "I'm not in a call." }
  if (s.intro) return { ok: false, message: 'The introduction is already playing.' }
  const outs = await defaultOutputs().catch(() => [])
  if (outs.some((d) => d.includes('BlackHole')))
    return { ok: false, message: 'Your Mac is sending its sound to BlackHole. Change the output in Sound settings first.' }
  if ((await micState(s)) === 'none') return { ok: false, message: "My Zoom audio isn't connected, so I can't speak." }

  s.intro = true
  let played = false
  try {
    if (!(await setMic(s, 'unmuted'))) return { ok: false, message: "Zoom didn't let me unmute. The host may have muted me." }
    console.log('[zoom] introduction: unmuted, playing')
    await run(await ensureHelper(), [VOICE_DEVICE, file], { timeout: 90_000 })
    played = true
    await new Promise((r) => setTimeout(r, 400)) // let the last syllable through
  } catch (err) {
    console.error(`[zoom] introduction failed: ${err.message}`)
  } finally {
    const muted = await setMic(s, 'muted')
    s.intro = false
    status.muted = muted
    console.log(`[zoom] introduction ${played ? 'played' : 'not played'}; muted again: ${muted ? 'verified' : 'NOT VERIFIED'}`)
    s.introResult = { ok: played, muted }
  }
  const { muted } = s.introResult
  return {
    ok: played && muted,
    played,
    muted,
    message: !played ? "The introduction didn't play." : muted ? 'Introduced. Muted again, verified.' : "Introduced, but I couldn't verify I'm muted. Check Zoom now.",
  }
}

/** The call ended without us: close the window and stop the camera, keeping the reason. */
async function endCall(s, state) {
  if (session !== s) return
  await leaveZoom(state)
}

/** Leave: close the Jarvis Chrome window and stop the camera. `final` is why. */
export async function leaveZoom(final = 'left') {
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
  setStatus(final)
  return { ok: true, status }
}

// Jarvis quitting (the bridge is stopped with SIGTERM) leaves the call too:
// close the Jarvis window and stop the camera this bridge started.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    try {
      session?.child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    try {
      if (obsPid) process.kill(obsPid, 'SIGTERM')
    } catch {
      /* gone */
    }
    try {
      execFileSync('/usr/bin/pkill', ['-TERM', '-f', JARVIS_OBS])
    } catch {
      /* not running */
    }
    process.exit(0)
  })
}

/** For tests: the scripts run inside the Zoom page. */
export const __pageScripts = { MEDIA_GUARD, JOIN_STEP, CALL_STATE, MIC_CLICK }

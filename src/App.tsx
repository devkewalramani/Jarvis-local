import { useEffect, useRef } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Boot } from './ui/Boot'
import { Ignition } from './ui/Ignition'
import { Diagnostics } from './ui/Diagnostics'
import { MicTest } from './ui/MicTest'
import { MeetingHud } from './ui/MeetingHud'
import { parseAgenda, describeAgenda, type AgendaItem } from './lib/agenda'
import {
  useMeeting, beginSetup, cancelSetup, startMeeting, nextItem, endMeeting, clearOffer,
  OFFER_MS, type MeetingSummary,
} from './lib/meeting'
import { useStore } from './store'
import { startVoice, takeWake, type Voice, type VoiceMode } from './lib/voice'
import { DESKTOP } from './lib/desktop'
import { createSpeaker, cycleVoice, currentVoiceName } from './lib/tts'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import { listenForClap } from './lib/clap'
import * as camera from './lib/camera'
import * as kokoro from './lib/kokoro'
import { TTS_ENGINE } from './config'
import { forTool, attention } from './lib/fillers'
import {
  ask,
  warm,
  interrupt,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchUi,
  watchConnection,
  connectedLabels,
  usingBridge,
  type Msg,
} from './lib/brain'
import { startAnalyser, micLevel, releaseMic } from './lib/audio'
import { BRIDGE_HTTP_URL } from './config'
import { probeCapabilities } from './lib/capabilities'
import { env } from './config'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
const FOLLOW_UP_MS = 11000

// Meeting mode phrases. Local: none of these reach the brain.
const MEETING_START = /\b(start|begin|enter|turn on|switch to)\s+(the\s+)?meeting mode\b/i
// Commands, not questions: they must start with the verb ("join the meeting on my
// calendar now") and carry no question mark ("who will join the meeting?").
const ZOOM_JOIN = /^\W*(?:(?:please|can you|could you|go ahead and)\s+)?(?:join|get on|hop on|jump on)\s+(?:the\s+|my\s+|this\s+|our\s+)?(?:zoom\s+)?(?:meeting|call|zoom)\b[^?]{0,60}\??$/i
const ZOOM_LEAVE = /^\W*(?:(?:please|can you|could you|go ahead and)\s+)?(?:leave|drop|exit|get off|hang up)\s+(?:(?:from|off)\s+)?(?:the\s+|my\s+|this\s+|our\s+)?(?:zoom\s+)?(?:meeting|call|zoom)\b[^?]{0,60}\??$/i
const YES = /^\s*(yes|yeah|yep|sure|please|go ahead|do it|use it|ok(ay)?|sounds good)\b/i
const NO = /^\s*(no|nope|don'?t|do not|not now|skip|never mind)\b/i
const CANCEL = /\b(cancel|never mind|stop meeting mode)\b/i
/**
 * "Standby", "go to sleep", "stop listening", "that's all": back to waiting
 * for the wake word, nothing else heard until "Hey Jarvis". Whole utterances
 * only, so "how much sleep did I get" is a question, not a command.
 */
const STANDBY = new RegExp(
  String.raw`^\W*(?:(?:ok(?:ay)?|no|nope|no thanks|no thank you|thanks|thank you|alright|all right|jarvis)[\s,.!]*)*` +
    String.raw`(?:(?:go\s+)?(?:back\s+)?(?:to\s+)?(?:standby|stand by|sleep)|stop listening|that'?s all|that will be all|that'?ll be all|dismissed|you'?re dismissed|you can go|be quiet|quiet|go quiet|never ?mind)` +
    String.raw`(?:[\s,.!]*(?:now|please|thanks|thank you|jarvis|sir))*\W*$`,
  'i',
)
const DRAFT_FOLLOW_UP = /\bdraft\b.*\bfollow[\s-]*up\b|\bfollow[\s-]*up\b.*\bdraft\b/i

/** GET from the bridge, or null if it can't answer. */
async function bridgePost<T>(path: string, body?: unknown, timeoutMs = 30000): Promise<T | null> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}${path}`, {
      method: 'POST',
      // text/plain keeps this a simple request: no CORS preflight.
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'text/plain' } }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}

async function bridgeJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}${path}`, { signal: AbortSignal.timeout(20000) })
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}

type MeetingNow = { event: { title: string } | null; agenda: AgendaItem[] }

const followUpPrompt = (o: MeetingSummary) =>
  `Draft a follow-up from the meeting that just ended${o.title ? `, "${o.title}"` : ''}. ` +
  `Its agenda was: ${describeAgenda(o.items)}.`

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** The same mishearings voice.ts accepts for the wake word — otherwise a turn
 *  that woke him as "travis" gets that word sent on to the model as a question. */
const NAME = '(?:jarvis|jarvys|jervis|travis|jarviss|java\'s|jarv)'
/** A bare vocative — "Jarvis", "hey jarvis" — with nothing asked. */
const BARE_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}[\\s,.!?]*$`, 'i')
/** A leading vocative on a real command: "Jarvis, what's the weather". */
const LEADING_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

export default function App() {
  const store = useStore
  const phase = useStore((s) => s.phase)
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const booting = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  const goDormant = () => {
    clearIdle()
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    sfx.play('listen')
    idleTimer.current = setTimeout(goDormant, window)
  }

  // -- one turn -------------------------------------------------------------

  // -- meeting mode -----------------------------------------------------------

  /** A line from Jarvis outside a model turn: shown, and spoken only if allowed. */
  const reply = async (text: string, speak: boolean) => {
    const s = store.getState()
    s.pushTurn({ id: newId(), role: 'jarvis', text })
    if (!speak) return
    s.setPhase('speaking')
    const spk = createSpeaker()
    speaker.current = spk
    spk.push(text)
    await spk.end()
    speaker.current = null
  }

  /** The microphone, released completely for the meeting and opened again after. */
  const pauseListening = () => {
    voice.current?.stop()
    voice.current = null
    releaseMic()
    clearIdle()
    store.getState().setPhase('dormant')
  }
  const resumeListening = async () => {
    try {
      await startAnalyser()
    } catch {
      /* the reactor just won't pulse with the voice */
    }
    voice.current = await startVoice({ mode, onWake, onSpeechStart, onPartial, onUtterance, onError: onVoiceError })
  }

  const runMeeting = async (items: AgendaItem[], title: string | null, headphones: boolean) => {
    startMeeting(items, title, headphones)
    // The spoken introduction for a Zoom call, generated now so Cmd+Shift+I
    // plays it at once. Played only on that key, never automatically.
    void bridgePost('/zoom/intro/prepare', { items: items.map(({ title, minutes }) => ({ title, minutes })) }, 120000)
    const first = items[0]
    // Spoken only into headphones: Jarvis never speaks into the call.
    await reply(
      `Meeting mode on. ${first.title} first, ${first.minutes} minute${first.minutes === 1 ? '' : 's'}. Microphone off.`,
      headphones,
    )
    pauseListening()
    DESKTOP?.setMeetingActive?.(true)
  }

  const finishMeeting = async () => {
    const summary = endMeeting()
    if (!summary) return
    void bridgePost('/zoom/intro/prepare', { items: [] })
    DESKTOP?.setMeetingActive?.(false)
    await resumeListening()
    const minutes = Math.max(1, Math.round((summary.endedAt - summary.startedAt) / 60000))
    const said = `Meeting mode off after ${minutes} minute${minutes === 1 ? '' : 's'}, ` +
      `${summary.covered} of ${summary.items.length} items.`
    if (useMeeting.getState().offerSpoken) {
      // Heard in headphones: a plain "yes" answers it.
      await reply(`${said} Shall I draft the follow-up?`, true)
      listen(FOLLOW_UP_MS)
    } else {
      // Shown, not spoken (the call may still be on speakers), so nobody was
      // asked out loud: back to the wake word rather than an open microphone
      // that would take any "yeah" in the room as an answer.
      await reply(`${said} Say "Hey Jarvis, draft the follow-up" when you're ready.`, false)
      goDormant()
    }
  }

  /**
   * "Join the meeting", by voice or ⌃⌥⌘J: Jarvis joins the Zoom call on the
   * calendar now as J.A.R.V.I.S. (muted, no microphone, the tile as its
   * camera), then meeting mode starts. Spoken replies only into headphones.
   */
  const joinZoom = async () => {
    const out = await bridgeJson<{ headphones: boolean }>('/audio-output')
    const headphones = Boolean(out?.headphones)
    const res = await bridgePost<{ ok: boolean; message?: string; already?: boolean }>('/zoom/join')
    if (!res?.ok) {
      await reply(res?.message ?? "I couldn't open Zoom.", headphones)
      return
    }
    await reply(
      res.already
        ? "I'm already in the meeting."
        : 'Joining as J.A.R.V.I.S., muted, with the agenda timer as my camera. Admit me from the waiting room.',
      headphones,
    )
    void watchCall()
    if (useMeeting.getState().phase === 'off') await startMeetingSetup('', true)
  }

  /**
   * While Jarvis is in a call: when it ends (the host ended it, Jarvis was
   * removed, or the window closed), end meeting mode too, or drop a setup that
   * never got its agenda.
   */
  const watching = useRef(false)
  const watchCall = async () => {
    if (watching.current) return
    watching.current = true
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000))
        const st = await bridgeJson<{ state: string }>('/zoom/status')
        if (!st || !['ended', 'left', 'invalid', 'error', 'signin', 'idle'].includes(st.state)) continue
        const m = useMeeting.getState()
        if (st.state === 'left') return // left on the user's word; leaveZoom handled it
        if (m.phase === 'running') await finishMeeting()
        else if (m.phase === 'setup') {
          cancelSetup()
          await reply(st.state === 'ended' ? 'The call has ended. Meeting mode off.' : 'Not in the call. Meeting mode off.', false)
          goDormant()
        }
        return
      }
    } finally {
      watching.current = false
    }
  }

  /**
   * Cmd+Shift+I: the spoken introduction in the Zoom call (the bridge unmutes
   * Jarvis's Zoom window, plays it to BlackHole, mutes and verifies). Shown,
   * never spoken here: the result is for the user's eyes only.
   */
  const playIntro = async (variant: 'full' | 'short') => {
    const res = await bridgePost<{ ok: boolean; message?: string }>('/zoom/intro', { variant }, 120000)
    await reply(res?.message ?? "The introduction didn't play.", false)
  }

  /** "Leave the meeting", by voice or ⌃⌥⌘L: close Jarvis's Zoom window, stop the camera, end meeting mode. */
  const leaveZoom = async () => {
    await bridgePost('/zoom/leave')
    const m = useMeeting.getState()
    if (m.phase === 'running') await finishMeeting()
    else {
      if (m.phase === 'setup') cancelSetup()
      await reply('Left the meeting.', false)
    }
  }

  /** "Start meeting mode", by voice or shortcut. Never from the calendar on its own. */
  const startMeetingSetup = async (said: string, inCall = false) => {
    const [now, out] = await Promise.all([
      bridgeJson<MeetingNow>('/meeting/now'),
      bridgeJson<{ headphones: boolean }>('/audio-output'),
    ])
    const headphones = Boolean(out?.headphones)
    const title = now?.event?.title ?? null
    // An agenda said with the command starts straight away.
    const spoken = /\bagenda\b/i.test(said) ? parseAgenda(said) : []
    if (spoken.length) return runMeeting(spoken, title, headphones)
    // A meeting already under way on speakers: show the prompts, don't say them.
    const speak = headphones || !now?.event
    // In a call Jarvis joined, answers come with the wake word, whenever the
    // user is ready: the microphone never opens on its own during a call.
    const hey = inCall ? 'Hey Jarvis, ' : ''
    if (now?.event && now.agenda.length) {
      beginSetup({ step: 'confirm', offered: now.agenda, title, speak, wakeOnly: inCall }, headphones)
      await reply(
        `You're in ${title}. The invite's agenda is ${describeAgenda(now.agenda)}. ` +
          (inCall ? 'Say "Hey Jarvis, use it", or give another agenda.' : 'Shall I use it?'),
        speak,
      )
    } else {
      beginSetup({ step: 'ask', offered: [], title, speak, wakeOnly: inCall }, headphones)
      await reply(
        `${title ? `You're in ${title}. ` : ''}What's the agenda? Say "${hey}agenda: pricing fifteen, timeline ten".`,
        speak,
      )
    }
    if (inCall) goDormant()
    else listen(AWAIT_SPEECH_MS)
  }

  /** Meeting mode's part of a turn. True when it handled what was said. */
  const meetingTurn = async (said: string): Promise<boolean> => {
    const m = useMeeting.getState()
    if (m.offer && Date.now() - m.offer.endedAt > OFFER_MS) clearOffer()
    if (m.offer && Date.now() - m.offer.endedAt <= OFFER_MS) {
      const offer = m.offer
      // "Draft the follow-up" always means this meeting while the offer is open;
      // a bare "yes" only counts if the question was actually heard.
      if (DRAFT_FOLLOW_UP.test(said) || (m.offerSpoken && YES.test(said))) {
        clearOffer()
        void respond(followUpPrompt(offer))
        return true
      }
      if (m.offerSpoken && NO.test(said)) {
        clearOffer()
        await reply('Very good, sir.', true)
        listen(FOLLOW_UP_MS)
        return true
      }
    }
    if (m.phase === 'setup' && m.setup) {
      const setup = m.setup
      const next = (ms: number) => (setup.wakeOnly ? goDormant() : listen(ms))
      if (CANCEL.test(said)) {
        cancelSetup()
        await reply('Meeting mode cancelled.', setup.speak)
        next(FOLLOW_UP_MS)
        return true
      }
      if (setup.step === 'confirm' && (YES.test(said) || /\buse it\b/i.test(said))) {
        await runMeeting(setup.offered, setup.title, m.headphones)
        return true
      }
      const items = parseAgenda(said)
      if (items.length) {
        await runMeeting(items, setup.title, m.headphones)
        return true
      }
      if (setup.step === 'confirm' && NO.test(said)) {
        beginSetup({ ...setup, step: 'ask', offered: [] }, m.headphones)
        await reply('Then what is the agenda? Each item and its minutes.', setup.speak)
      } else {
        await reply("I didn't catch an agenda. Each item and its minutes, like pricing fifteen, timeline ten.", setup.speak)
      }
      next(AWAIT_SPEECH_MS)
      return true
    }
    if (ZOOM_LEAVE.test(said)) {
      clearIdle()
      await leaveZoom()
      return true
    }
    if (ZOOM_JOIN.test(said)) {
      clearIdle()
      await joinZoom()
      return true
    }
    if (MEETING_START.test(said)) {
      clearIdle()
      await startMeetingSetup(said)
      return true
    }
    return false
  }

  /** Shortcuts: start (⌃⌥⌘M), next item (⌃⌥⌘N), end (⌃⌥⌘E). */
  const meetingKey = (action: 'start' | 'next' | 'end' | 'join' | 'leave' | 'intro', arg?: string) => {
    const m = useMeeting.getState()
    if (action === 'join') return void joinZoom()
    if (action === 'leave') return void leaveZoom()
    if (action === 'intro') return void playIntro(arg === 'short' ? 'short' : 'full')
    if (action === 'start') {
      if (m.phase === 'off' && store.getState().phase !== 'offline' && store.getState().phase !== 'boot') {
        void startMeetingSetup('')
      }
    } else if (action === 'next') {
      if (m.phase === 'running' && !nextItem()) void finishMeeting()
    } else if (m.phase === 'running') {
      void finishMeeting()
    } else if (m.phase === 'setup') {
      cancelSetup()
    }
  }

  /** "Standby": say so, then hear nothing but the wake word. Drops an unfinished meeting setup too. */
  const standBy = async () => {
    clearIdle()
    const setup = useMeeting.getState().setup
    if (useMeeting.getState().phase === 'setup') cancelSetup()
    // Spoken, except in a meeting on speakers, where Jarvis never talks.
    await reply('Standing by.', setup ? setup.speak : true)
    goDormant()
  }

  const respond = async (said: string): Promise<void> => {
    if (STANDBY.test(said)) return void standBy()
    if (await meetingTurn(said)) return
    const mine = ++turn.current
    const stale = () => mine !== turn.current

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    const userTurnId = newId()
    s.pushTurn({ id: userTurnId, role: 'user', text: said })
    s.setPhase('thinking')
    // The wake word confidence that started this turn, if a wake did.
    const wake = takeWake()

    const spk = createSpeaker()
    speaker.current = spk
    sfx.duck(true)
    music.duck(true)

    const turnId = newId()
    let started = false
    let filled = false

    try {
      const { text, notRequest } = await ask(said, history.current, {
        onText: (delta) => {
          if (stale()) return
          if (!started) {
            started = true
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            music.working(false)
            store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' })
          }
          store.getState().appendToLastTurn(delta)
          spk.push(delta)
        },
        // The bridge's acknowledgment for a Claude-routed request ("Drafting
        // that now."). It counts as this turn's filler, so the tool filler
        // below does not speak a second one.
        onAck: (line) => {
          if (stale() || filled || started) return
          filled = true
          spk.say(line)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          music.working(true)
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          if (!filled && !started) {
            filled = true
            spk.say(forTool(name))
          }
        },
      }, wake)

      if (stale()) return

      // Speech that wasn't a request: keep Jarvis's reply, drop the words he
      // overheard, and (if a wake started it) record the wake's confidence so
      // the menu can suggest a sensitivity above it.
      if (notRequest) {
        store.getState().removeTurn(userTurnId)
        if (wake) DESKTOP?.reportFalseWake?.(wake)
      }

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      await spk.end()
      if (stale()) return
      sfx.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine.
        listen(FOLLOW_UP_MS)
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    switch (store.getState().phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return 'wake'
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  const onWake = (trailing: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return

    store.getState().setError(null)
    sfx.play('wake')

    // "Jarvis, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      void respond(trailing)
      return
    }

    store.getState().setPhase('waking')

    // Answer to his name. Deliberately NOT awaited any more: the microphone is
    // already open and the echo filter knows his voice, so the user can talk
    // straight over the greeting instead of waiting it out.
    const greeting = createSpeaker()
    speaker.current = greeting
    greeting.say(attention())
    void greeting.end()

    listen(AWAIT_SPEECH_MS)
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt()
      store.getState().setActiveTool(null)
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    }
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question.
    if (BARE_NAME.test(text)) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    const said = text.replace(LEADING_NAME, '').trim()
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }

    void respond(said)
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[jarvis] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  const ignite = async () => {
    const s = store.getState()

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture.
    await sfx.unlockAudio()
    sfx.play('boot')
    // The score. Must be started from inside this click handler for the same
    // reason as the rest of the audio.
    music.enable()
    music.playBoot()
    music.startAmbient()

    s.setPhase('boot')

    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))

    /**
     * JARVIS asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[jarvis] unknown ui op:', op, args)
      }
    })
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    watchConnection((state) => {
      if (state === 'lost') {
        store.getState().setError('Bridge connection lost — reconnecting.')
      } else if (state === 'reconnected') {
        store
          .getState()
          .setError('Bridge reconnected. The previous conversation was not kept.')
      }
    })
    const warming = warm().catch((err: Error) => s.setError(err.message))

    if (!usingBridge && !env.anthropicKey) {
      s.setError(
        'No Anthropic API key — copy .env.example to .env.local and set VITE_ANTHROPIC_API_KEY.',
      )
    }

    // Pull the neural voice down during the boot sequence so the first
    // "Hey Jarvis" isn't waiting on an 86MB download. Deliberately not awaited
    // — if it's slow, JARVIS comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro') {
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    // Long enough for the four-beat start-up sequence in Boot.tsx to play —
    // status bar, rings, suit schematic, reactor power-up — before the live
    // interface takes over. Kept a touch under the boot cue so the music is
    // still rising as the reactor lands.
    await new Promise((r) => setTimeout(r, 9200)) // boot sequence
    await warming
    store.getState().setConnected(connectedLabels())
    store.getState().setVoice(currentVoiceName())

    // The analyser is what makes the reactor pulse with your voice. It needs a
    // getUserMedia stream; speech recognition does not, and gets its own. So a
    // failure here costs the animation and nothing else — saying "voice input
    // is unavailable" was both alarming and untrue.
    try {
      await startAnalyser()
    } catch {
      console.warn(
        '[jarvis] no microphone stream — the reactor will not pulse with your ' +
          'voice. Speech recognition is unaffected.',
      )
    }

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload.
    await probeCapabilities()

    // One voice loop, started once, running until the page closes.
    voice.current = await startVoice({
      mode,
      onWake,
      onSpeechStart,
      onPartial,
      onUtterance,
      onError: onVoiceError,
    })

    store.getState().setPhase('dormant')
  }

  // -- clap to start --------------------------------------------------------

  /**
   * A clap brings him up, as an alternative to the button.
   *
   * Only while the ignition screen is showing, and torn down the moment he
   * boots — the microphone is about to belong to the voice loop, and two
   * analysers arguing over the same stream is how you get an assistant that
   * hears half of what you say.
   *
   * Deliberately silent about failure. If the microphone is refused, or has not
   * been granted yet, the button is still right there; announcing an error
   * about a feature nobody asked for would be worse than quietly doing without.
   */
  useEffect(() => {
    if (phase !== 'offline') return
    let live: { stop: () => void } | null = null
    let gone = false
    void listenForClap(() => {
      if (!gone) void powerOn()
    }).then((l) => {
      if (gone) l.stop()
      else live = l
    })
    return () => {
      gone = true
      live?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // -- meeting mode: page state and desktop hooks ----------------------------

  const meetingPhase = useMeeting((m) => m.phase)
  useEffect(() => {
    document.documentElement.classList.toggle('meeting-on', meetingPhase === 'running')
  }, [meetingPhase])

  // The meeting tile (/tile, the camera Jarvis shows a call) follows meeting
  // mode through the bridge. Only the agenda and the timer are sent.
  useEffect(() => {
    const share = (m: ReturnType<typeof useMeeting.getState>) => {
      const body = JSON.stringify({ phase: m.phase, items: m.items, index: m.index, itemStartedAt: m.itemStartedAt })
      // text/plain keeps this a simple request: no CORS preflight.
      void fetch(`${BRIDGE_HTTP_URL}/meeting/state`, { method: 'POST', body, headers: { 'content-type': 'text/plain' } }).catch(() => {})
    }
    share(useMeeting.getState())
    return useMeeting.subscribe((m, prev) => {
      if (m.phase !== prev.phase || m.index !== prev.index || m.itemStartedAt !== prev.itemStartedAt || m.items !== prev.items) share(m)
    })
  }, [])

  useEffect(() => {
    // Global shortcuts from the desktop app (they work while the call has focus).
    DESKTOP?.onMeetingKey?.((action, arg) => meetingKey(action, arg))
    // Test aid (JARVIS_DESKTOP_MEETING_TEST): run a meeting with a fixed agenda.
    DESKTOP?.onMeetingTest?.((agenda) => {
      void (async () => {
        const out = await bridgeJson<{ headphones: boolean }>('/audio-output')
        await runMeeting(parseAgenda(`agenda: ${agenda}`), 'Test meeting', Boolean(out?.headphones))
      })()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0

    const pump = () => {
      const st = store.getState()
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : micLevel()
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voice set to ${name.replace(/\(.*?\)/g, '').trim()}. At your service, sir.`)
        void demo.end()
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? 'Camera access denied — gesture control is unavailable.'
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Audio test. If you can hear this, speech output is working, sir.')
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        if (store.getState().phase !== 'offline') goDormant()
        return
      }

      // Meeting mode shortcuts (⌃⌥⌘ + M/N/E). The desktop app also registers
      // them globally, so they work while the call has focus.
      if (e.ctrlKey && e.altKey && e.metaKey && !e.repeat) {
        const action = ({ KeyM: 'start', KeyN: 'next', KeyE: 'end' } as const)[e.code as 'KeyM' | 'KeyN' | 'KeyE']
        if (action) {
          e.preventDefault()
          meetingKey(action)
          return
        }
      }

      // Space starts a turn without the wake word. Worth using while filming so
      // a missed wake word doesn't cost a take. Not during a meeting: the
      // microphone stays off until it ends.
      if (e.code !== 'Space' || e.repeat) return
      if (useMeeting.getState().phase === 'running') return
      e.preventDefault()

      const phase = store.getState().phase
      if (phase === 'offline') {
        void powerOn()
      } else if (phase === 'boot') {
        /* ignore — the boot sequence owns the phase until it finishes */
      } else if (
        phase === 'thinking' ||
        phase === 'tooling' ||
        phase === 'speaking'
      ) {
        onSpeechStart()
        listen(AWAIT_SPEECH_MS)
      } else {
        onWake('')
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      voice.current?.stop()
      speaker.current?.cancel()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Scene />
      <Hud />
      <Boot />
      <Diagnostics />
      <MicTest />
      <MeetingHud />
      <Ignition onStart={() => void powerOn()} />
    </>
  )
}

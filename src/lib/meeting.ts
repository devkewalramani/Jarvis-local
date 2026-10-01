import { create } from 'zustand'
import type { AgendaItem } from './agenda'

/**
 * Meeting mode: a timer over an agenda, started only by the user (by voice,
 * "start meeting mode", or the keyboard shortcut), never from the calendar.
 *
 * While it runs the microphone is released entirely: no wake word, no
 * recording, no transcription (App pauses the voice loop and closes the mic).
 * It is time based only. Jarvis never speaks into the call; audio nudges are
 * a short tone, and only when the output is headphones.
 */

export const AMBER_MS = 2 * 60_000 // amber with two minutes left on an item

export type MeetingSummary = {
  title: string | null
  items: AgendaItem[]
  covered: number
  startedAt: number
  endedAt: number
}

type Setup = {
  step: 'confirm' | 'ask'
  offered: AgendaItem[]
  title: string | null
  /** Speak the setup prompts? Not when a meeting is under way on speakers. */
  speak: boolean
}

type MeetingState = {
  phase: 'off' | 'setup' | 'running'
  setup: Setup | null
  title: string | null
  items: AgendaItem[]
  index: number
  itemStartedAt: number
  startedAt: number
  /** Output is headphones: the only case where a nudge may make a sound. */
  headphones: boolean
  /** The last meeting, kept for "shall I draft the follow up?". */
  offer: MeetingSummary | null
  /** Whether that offer was spoken (into headphones): only then does a bare "yes" answer it. */
  offerSpoken: boolean
}

export const useMeeting = create<MeetingState>(() => ({
  phase: 'off',
  setup: null,
  title: null,
  items: [],
  index: 0,
  itemStartedAt: 0,
  startedAt: 0,
  headphones: false,
  offer: null,
  offerSpoken: false,
}))

/** How long "draft the follow up" still refers to the meeting that just ended. */
export const OFFER_MS = 30 * 60_000

export function beginSetup(setup: Setup, headphones: boolean) {
  useMeeting.setState({ phase: 'setup', setup, headphones, offer: null })
}

export function cancelSetup() {
  useMeeting.setState({ phase: 'off', setup: null })
}

export function startMeeting(items: AgendaItem[], title: string | null, headphones: boolean) {
  const now = Date.now()
  useMeeting.setState({
    phase: 'running', setup: null, title, items, index: 0,
    itemStartedAt: now, startedAt: now, headphones, offer: null,
  })
}

/** Next item; returns false when there was no next item (the meeting should end). */
export function nextItem(): boolean {
  const m = useMeeting.getState()
  if (m.phase !== 'running' || m.index >= m.items.length - 1) return false
  useMeeting.setState({ index: m.index + 1, itemStartedAt: Date.now() })
  return true
}

export function endMeeting(): MeetingSummary | null {
  const m = useMeeting.getState()
  if (m.phase !== 'running') return null
  const summary: MeetingSummary = {
    title: m.title, items: m.items, covered: m.index + 1,
    startedAt: m.startedAt, endedAt: Date.now(),
  }
  useMeeting.setState({ phase: 'off', items: [], index: 0, offer: summary, offerSpoken: m.headphones })
  return summary
}

export function clearOffer() {
  useMeeting.setState({ offer: null })
}

/** Time left on the current item; negative once it has overrun. */
export function itemLeftMs(m = useMeeting.getState(), now = Date.now()): number {
  const item = m.items[m.index]
  return item ? item.minutes * 60_000 - (now - m.itemStartedAt) : 0
}

/** Time left in the whole meeting: the current item (overrun included) plus the rest. */
export function totalLeftMs(m = useMeeting.getState(), now = Date.now()): number {
  const later = m.items.slice(m.index + 1).reduce((t, i) => t + i.minutes * 60_000, 0)
  return itemLeftMs(m, now) + later
}

/** 'amber' with two minutes left on the item, 'red' at zero and after. */
export function meetingAlert(m = useMeeting.getState(), now = Date.now()): 'amber' | 'red' | null {
  if (m.phase !== 'running') return null
  const left = itemLeftMs(m, now)
  return left <= 0 ? 'red' : left <= AMBER_MS ? 'amber' : null
}

/** m:ss, with a minus sign once overrun. */
export function clock(ms: number): string {
  const neg = ms < 0
  const s = Math.floor(Math.abs(ms) / 1000)
  return `${neg ? '−' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * A soft tone for a nudge: two notes for amber, three lower ones for time up.
 * Generated here, never speech. Callers only use it when the output is
 * headphones, so it can't be heard on the call.
 */
export function chime(kind: 'amber' | 'red') {
  try {
    const ctx = new AudioContext()
    const notes = kind === 'amber' ? [880, 1175] : [660, 660, 660]
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const t = ctx.currentTime + i * 0.22
      osc.frequency.value = f
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.2)
    })
    setTimeout(() => void ctx.close(), 1200)
  } catch {
    /* no audio output; the nudge stays visual */
  }
}

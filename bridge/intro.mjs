/**
 * Jarvis's spoken introduction in a Zoom call.
 *
 * Generated with Kokoro (the local voice service) when meeting mode starts, in
 * two variants, and played only when the user presses Cmd+Shift+I (see
 * zoom.mjs: unmute, play to BlackHole, mute, verify).
 *
 * The owner's name comes from JARVIS_OWNER_NAME in .env; without it Jarvis
 * says "an AI assistant".
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VOICE_URL = process.env.JARVIS_VOICE_URL || 'http://127.0.0.1:8790'
const DIR = join(homedir(), 'Library', 'Application Support', 'Jarvis', 'intro')

export const greeting = (date = new Date()) => {
  const h = date.getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

/** "pricing, timeline, and next steps" */
const spokenList = (titles) =>
  titles.length <= 1 ? (titles[0] ?? '') :
  titles.length === 2 ? `${titles[0]} and ${titles[1]}` :
  `${titles.slice(0, -1).join(', ')}, and ${titles[titles.length - 1]}`

/** The two intros, filled in from the agenda. */
export function introText(items, variant, { date = new Date(), owner = process.env.JARVIS_OWNER_NAME } = {}) {
  const name = String(owner ?? '').trim()
  if (variant === 'short') {
    return `Hi everyone, I'm Jarvis, ${name ? `${name}'s assistant` : 'an AI assistant'}. ` +
      "I'm just keeping time on our agenda, and I'm not recording. Muting now."
  }
  const minutes = items.reduce((t, i) => t + (Number(i.minutes) || 0), 0)
  return `${greeting(date)}. I'm Jarvis, ${name ? `${name}'s AI assistant` : 'an AI assistant'}. ` +
    `I'm here only to keep time on today's agenda: ${spokenList(items.map((i) => i.title))}, ` +
    `over ${minutes} minute${minutes === 1 ? '' : 's'}. ` +
    "I'm not recording or transcribing this call. " +
    "I'll stay muted from here, and you'll see the agenda timer on my screen."
}

let intro = { ready: false, played: false, items: [], greeting: null, files: {}, texts: {} }

export const introState = () => ({ ready: intro.ready, played: intro.played })

async function synthesise(text, file) {
  const res = await fetch(`${VOICE_URL}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`voice service answered ${res.status}`)
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
}

/** Generate both variants for this agenda. Resolves when both files are written. */
export async function prepareIntro(items) {
  const clean = (Array.isArray(items) ? items : [])
    .slice(0, 20)
    .map((i) => ({ title: String(i?.title ?? '').slice(0, 60), minutes: Math.max(0, Math.min(240, Number(i?.minutes) || 0)) }))
    .filter((i) => i.title && i.minutes)
  if (!clean.length) throw new Error('no agenda')
  mkdirSync(DIR, { recursive: true })
  const next = { ready: false, played: false, items: clean, greeting: greeting(), files: {}, texts: {} }
  for (const variant of ['full', 'short']) {
    next.texts[variant] = introText(clean, variant)
    next.files[variant] = join(DIR, `${variant}.wav`)
    await synthesise(next.texts[variant], next.files[variant])
  }
  next.ready = true
  intro = next
  console.log(`[intro] ready (${clean.length} items): ${next.texts.full}`)
  return introState()
}

/**
 * The file to play for a variant. Regenerated first if the greeting has
 * changed since it was prepared (prepared at 11:58, played at 12:01).
 */
export async function introFile(variant = 'full') {
  if (!intro.ready) return null
  const v = variant === 'short' ? 'short' : 'full'
  if (v === 'full' && intro.greeting !== greeting()) {
    intro.greeting = greeting()
    intro.texts.full = introText(intro.items, 'full')
    await synthesise(intro.texts.full, intro.files.full)
  }
  return { file: intro.files[v], text: intro.texts[v] }
}

export function markPlayed() {
  intro.played = true
}

export function clearIntro() {
  intro = { ready: false, played: false, items: [], greeting: null, files: {}, texts: {} }
}

/**
 * Meeting mode support for the page: the meeting happening now (with an agenda
 * read from its invite) and whether the audio output is headphones.
 *
 *   GET /meeting/now    -> { event: { title, start, end } | null, agenda: [{ title, minutes }] }
 *   GET /audio-output   -> { name, transport, headphones }
 *
 * The calendar is read through the same Thunderbird MCP server Jarvis uses
 * (the `thunderbird` entry in ~/.claude.json), with exactly one tool allowed:
 * listEvents. Meeting mode never starts on its own; this only answers the
 * page when the user starts it.
 */

import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const READ_ONLY = new Set(['listEvents'])

/** One read-only MCP call to the Thunderbird server; resolves with the parsed result. */
function thunderbirdCall(name, args, timeoutMs = 15000) {
  if (!READ_ONLY.has(name)) return Promise.reject(new Error(`refused: ${name}`))
  const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'))
  const tb = cfg.mcpServers?.thunderbird
  if (!tb?.command) return Promise.reject(new Error('no thunderbird MCP server configured'))
  return new Promise((resolve, reject) => {
    const p = spawn(tb.command, tb.args ?? [], { stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    const done = (fn, v) => { clearTimeout(timer); p.kill(); fn(v) }
    const timer = setTimeout(() => done(reject, new Error('Thunderbird did not answer')), timeoutMs)
    p.on('error', (err) => done(reject, err))
    p.stdout.on('data', (d) => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        const m = JSON.parse(line)
        if (m.id !== 2) continue
        try {
          done(resolve, JSON.parse(m.result?.content?.[0]?.text ?? 'null'))
        } catch (err) {
          done(reject, err)
        }
      }
    })
    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jarvis-meeting', version: '1' } } })
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
    }, 300)
  })
}

/**
 * An agenda from an invite description: every line that carries a duration
 * ("Pricing - 15 min", "1. Timeline (10m)", "Next steps: 5 minutes",
 * "15 min Pricing") becomes an item. Lines without a duration are ignored.
 */
export function agendaFromDescription(text) {
  const items = []
  const plain = String(text ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
  for (const raw of plain.split(/\r?\n/)) {
    const m = /(\d{1,3})\s*(?:m|min|mins|minute|minutes)\b/i.exec(raw)
    if (!m) continue
    const title = raw
      .replace(m[0], ' ')
      .replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '')
      .replace(/[()[\]:–—-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const minutes = Number(m[1])
    if (title && minutes > 0 && minutes <= 240) items.push({ title, minutes })
  }
  return items
}

/** The timed calendar event happening right now, if any, with its invite agenda. */
export async function meetingNow() {
  const now = new Date()
  const from = new Date(now.getTime() - 12 * 3600_000)
  const to = new Date(now.getTime() + 60_000)
  const events = await thunderbirdCall('listEvents', { startDate: from.toISOString(), endDate: to.toISOString(), maxResults: 100 })
  const list = Array.isArray(events) ? events : events?.events ?? []
  const current = list
    .filter((e) => !e.allDay && new Date(e.startDate) <= now && new Date(e.endDate) > now)
    .sort((a, b) => new Date(b.startDate) - new Date(a.startDate))[0]
  if (!current) return { event: null, agenda: [] }
  return {
    event: { title: String(current.title ?? '').trim(), start: current.startDate, end: current.endDate },
    agenda: agendaFromDescription(current.description),
  }
}

/**
 * Whether the default audio output is headphones. Strict on purpose: only a
 * device whose name says so (or one listed in JARVIS_HEADPHONE_NAMES) counts,
 * so a generic "USB Audio" or a speaker never gets a sound during a call.
 */
const HEADPHONE_NAME = /headphone|headset|earphone|earpods|airpods|buds|beats|\bwh-|\bwf-|bose qc|jabra/i

export async function audioOutput() {
  const extra = (process.env.JARVIS_HEADPHONE_NAMES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const { stdout } = await run('/usr/sbin/system_profiler', ['SPAudioDataType', '-json'], { timeout: 5000 })
  const devices = (JSON.parse(stdout).SPAudioDataType ?? []).flatMap((g) => g._items ?? [])
  const out = devices.find((d) => d.coreaudio_default_audio_output_device === 'spaudio_yes')
  if (!out) return { name: null, transport: null, headphones: false }
  const name = String(out._name ?? '')
  return {
    name,
    transport: String(out.coreaudio_device_transport ?? '').replace('coreaudio_device_type_', ''),
    headphones: HEADPHONE_NAME.test(name) || extra.includes(name.toLowerCase()),
  }
}

/**
 * The part of meeting mode the tile may show to a call: whether a meeting is
 * running, its agenda items (title and minutes) and the timer. Everything is
 * re-validated here, so whatever the page sends, nothing else gets through.
 */
export function publicMeeting(m) {
  const running = m?.phase === 'running' && Array.isArray(m.items) && m.items.length > 0
  if (!running) return { phase: 'off', items: [], index: 0, itemStartedAt: 0 }
  const items = m.items.slice(0, 20).map((i) => ({
    title: String(i?.title ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 60),
    minutes: Math.max(0, Math.min(240, Number(i?.minutes) || 0)),
  }))
  const index = Math.max(0, Math.min(items.length - 1, Math.floor(Number(m.index) || 0)))
  const itemStartedAt = Number(m.itemStartedAt) || Date.now()
  return { phase: 'running', items, index, itemStartedAt }
}

/** A Zoom meeting link in free text (an invite's location or description). */
const ZOOM_LINK = /https:\/\/(?:[\w-]+\.)*zoom\.us\/(?:j|w|s|my|wc)\/[^\s"'<>)\]]+/i

export function zoomLinkIn(...texts) {
  for (const t of texts) {
    const m = ZOOM_LINK.exec(String(t ?? ''))
    if (m) return m[0].replace(/[.,;]+$/, '')
  }
  return null
}

/**
 * The Zoom link of the meeting to join: one happening now, or starting within
 * the next 15 minutes, preferring the one already under way. Read only, from
 * the calendar; null when there is none.
 */
export async function zoomLinkNow() {
  const now = Date.now()
  const events = await thunderbirdCall('listEvents', {
    startDate: new Date(now - 12 * 3600_000).toISOString(),
    endDate: new Date(now + 15 * 60_000).toISOString(),
    maxResults: 100,
  })
  const list = (Array.isArray(events) ? events : events?.events ?? [])
    .filter((e) => !e.allDay && new Date(e.endDate) > now && new Date(e.startDate) <= now + 15 * 60_000)
    .map((e) => ({ title: String(e.title ?? '').trim(), start: e.startDate, link: zoomLinkIn(e.onlineMeetingURL, e.location, e.description) }))
    .filter((e) => e.link)
    .sort((a, b) => Math.abs(new Date(a.start) - now) - Math.abs(new Date(b.start) - now))
  return list[0] ?? null
}

/**
 * Two brains, and the rule that picks between them.
 *
 *   local  — qwen3 30B instruct-2507 on a Jarvis-only Ollama (127.0.0.1:11435). Claude Code is
 *            pointed at it with ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN, set in
 *            that session's environment only. Used for simple lookups.
 *   claude — Claude Code on the user's Claude subscription login. Its
 *            environment has every Anthropic credential variable stripped, so it
 *            can only authenticate with the claude.ai login.
 *
 * Neither ever sees ANTHROPIC_API_KEY. The bridge refuses to start if it can
 * see one at all (see assertNoApiKey), and the environments below delete it
 * again as a second line of defence.
 *
 * The routing rules live in routing.json, re-read on every request.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// Personal settings (see .env.example). This module is the bridge's first
// import, so loading .env here puts it in place before any other module reads
// the environment, and before the billing guard runs: an API key put in .env
// is refused like any other. Under `npm start` the launcher already loaded it.
try {
  process.loadEnvFile(join(HERE, '..', '.env'))
} catch {
  /* no .env: defaults everywhere */
}
const ROUTING_FILE = join(HERE, 'routing.json')
const LOG_DIR = join(HERE, '..', 'logs')
export const BRAIN_LOG = join(LOG_DIR, 'brain.log')

export const LOCAL_URL = process.env.JARVIS_LOCAL_URL ?? 'http://localhost:11435'
export const LOCAL_MODEL = process.env.JARVIS_LOCAL_MODEL ?? 'qwen3:30b-a3b-instruct-2507-q4_K_M'

// ---------------------------------------------------------------------------
// Billing guard
// ---------------------------------------------------------------------------

/** Variables that would make Claude Code bill something other than the subscription. */
const CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']

export function assertNoApiKey() {
  const seen = CREDENTIAL_VARS.filter((k) => process.env[k])
  if (!seen.length) return
  console.error(
    `\n[jarvis] REFUSING TO START: ${seen.join(', ')} is visible to the bridge.\n` +
      '[jarvis] Jarvis must run on your Claude subscription, never an API key.\n' +
      '[jarvis] Start it with `npm start`, which removes the key for Jarvis only,\n' +
      '[jarvis] or run: env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL npm run bridge\n',
  )
  process.exit(1)
}

function baseEnv() {
  const env = { ...process.env }
  for (const k of CREDENTIAL_VARS) delete env[k]
  // Without an API key Claude Code would also load your claude.ai connectors
  // (Gmail, Drive, ...). Jarvis reaches mail only through Thunderbird.
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false'
  return env
}

/** The subscription brain: no credential variables at all, so the CLI uses the claude.ai login. */
export const claudeEnv = () => baseEnv()

/** The local brain: pointed at the Jarvis Ollama, with every model alias mapped to it. */
export const localEnv = () => ({
  ...baseEnv(),
  ANTHROPIC_BASE_URL: LOCAL_URL,
  ANTHROPIC_AUTH_TOKEN: 'ollama',
  ANTHROPIC_MODEL: LOCAL_MODEL,
  ANTHROPIC_DEFAULT_OPUS_MODEL: LOCAL_MODEL,
  ANTHROPIC_DEFAULT_SONNET_MODEL: LOCAL_MODEL,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: LOCAL_MODEL,
  ANTHROPIC_SMALL_FAST_MODEL: LOCAL_MODEL,
  CLAUDE_CODE_SUBAGENT_MODEL: LOCAL_MODEL,
  // Nothing from this session should go anywhere but the local model.
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
})

// ---------------------------------------------------------------------------
// Thunderbird tool policy
// ---------------------------------------------------------------------------

/**
 * The only Thunderbird tools Jarvis may call, whatever JARVIS_ALLOW_WRITES says.
 * Everything else the server offers is denied, including tools it adds later.
 */
export const THUNDERBIRD_ALLOWED = new Set([
  'listAccounts', 'searchMessages', 'getMessage', 'getRecentMessages',
  'listFolders', 'listCalendars', 'listEvents', 'saveDraft',
])

/** The local brain only looks things up; drafting is Claude's job. */
const THUNDERBIRD_ALLOWED_LOCAL = new Set(
  [...THUNDERBIRD_ALLOWED].filter((t) => t !== 'saveDraft'),
)

/**
 * Claude may also open a reply window: replyToMessage, the only tool that
 * threads a reply properly (saveDraft takes no in-reply-to). It opens
 * Thunderbird's compose window for the user to review and sends nothing — the
 * extension's "Block skipReview" preference is on, and reviewReplyInput below
 * strips skipReview from every call regardless. Still denied in
 * ~/.claude/settings.json for ordinary Claude Code sessions.
 */
const THUNDERBIRD_ALLOWED_CLAUDE = new Set([...THUNDERBIRD_ALLOWED, 'replyToMessage'])

export const thunderbirdAllows = (tool, brain) =>
  (brain === 'local' ? THUNDERBIRD_ALLOWED_LOCAL : THUNDERBIRD_ALLOWED_CLAUDE).has(tool)

/**
 * Every tool the server exposed when this was set up. Anything here that is not
 * allowed is also removed from the model's view entirely (disallowedTools), so
 * it cannot even be attempted. Unknown future tools still hit the deny in
 * decideTool.
 */
const THUNDERBIRD_KNOWN = [
  'listAccounts', 'listFolders', 'searchMessages', 'getMessage', 'getMessages',
  'sendMail', 'saveDraft', 'listCalendars', 'createEvent', 'listEvents',
  'updateEvent', 'deleteEvent', 'createTask', 'listCategories', 'listTasks',
  'updateTask', 'searchContacts', 'getContact', 'createContact', 'updateContact',
  'deleteContact', 'replyToMessage', 'forwardMessage', 'getRecentMessages',
  'displayMessage', 'deleteMessages', 'updateMessage', 'createFolder',
  'renameFolder', 'deleteFolder', 'emptyTrash', 'emptyJunk', 'moveFolder',
  'listFilters', 'createFilter', 'updateFilter', 'deleteFilter',
  'reorderFilters', 'applyFilters', 'getAccountAccess',
]

// ---------------------------------------------------------------------------
// Granola tool policy
// ---------------------------------------------------------------------------

/**
 * Granola meeting notes: read tools only (list, get notes/summary, get
 * transcript, search), and only for Claude — the local brain never sees
 * Granola. Anything else the server offers, now or later, is denied.
 */
export const GRANOLA_ALLOWED = new Set([
  'list_meetings', 'get_meetings', 'get_meeting_transcript', 'query_granola_meetings',
])

export const granolaAllows = (tool, brain) => brain !== 'local' && GRANOLA_ALLOWED.has(tool)

// ---------------------------------------------------------------------------
// Zoom tool policy
// ---------------------------------------------------------------------------

/**
 * Zoom's official MCP server: read tools only (search meetings, list
 * recordings, meeting assets and AI summary, recording resources such as the
 * transcript), and only for Claude. Everything else, including the tools that
 * create files or docs and any tool Zoom adds later, is denied.
 */
export const ZOOM_ALLOWED = new Set([
  'search_meetings', 'recordings_list', 'get_meeting_assets', 'get_recording_resource',
])

export const zoomAllows = (tool, brain) => brain !== 'local' && ZOOM_ALLOWED.has(tool)

export const thunderbirdDisallowed = (brain) =>
  THUNDERBIRD_KNOWN.filter((t) => !thunderbirdAllows(t, brain)).map(
    (t) => `mcp__thunderbird__${t}`,
  )

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function loadRules() {
  try {
    const raw = JSON.parse(readFileSync(ROUTING_FILE, 'utf8'))
    const compile = (list) =>
      (list ?? []).map((src) => ({ src, re: new RegExp(src, 'i') }))
    return {
      default: raw.default === 'local' ? 'local' : 'claude',
      claude: compile(raw.claude),
      local: compile(raw.local),
      acknowledge: (raw.acknowledge ?? []).map((a) => ({ re: new RegExp(a.pattern, 'i'), say: a.say })),
      acknowledgeDefault: raw.acknowledgeDefault ?? '',
      refuse: raw.refuse
        ? {
            patterns: (raw.refuse.patterns ?? []).map((src) => ({ src, re: new RegExp(src, 'i') })),
            unless: raw.refuse.unless ? new RegExp(raw.refuse.unless, 'i') : null,
            say: raw.refuse.say,
          }
        : null,
    }
  } catch (err) {
    console.error(`[jarvis] routing.json unreadable, sending everything to claude: ${err.message}`)
    return { default: 'claude', claude: [], local: [], acknowledge: [], acknowledgeDefault: '', refuse: null }
  }
}

/**
 * -> { brain: 'local' | 'claude' | 'canned', rule: string, ack: string, say?: string }
 * `ack` is what to say straight away; only Claude, the slow brain, gets one.
 * 'canned' means the bridge answers itself with `say` (a refusal to send).
 */
export function route(text) {
  const rules = loadRules()
  const refuse = rules.refuse
  if (refuse && !(refuse.unless && refuse.unless.test(text))) {
    const hit = refuse.patterns.find((r) => r.re.test(text))
    if (hit) return { brain: 'canned', rule: `refuse:${hit.src}`, ack: '', say: refuse.say }
  }
  const ackFor = () =>
    rules.acknowledge.find((a) => a.re.test(text))?.say ?? rules.acknowledgeDefault
  for (const r of rules.claude) if (r.re.test(text)) return { brain: 'claude', rule: `claude:${r.src}`, ack: ackFor() }
  for (const r of rules.local) if (r.re.test(text)) return { brain: 'local', rule: `local:${r.src}`, ack: '' }
  return { brain: rules.default, rule: 'default', ack: rules.default === 'claude' ? ackFor() : '' }
}

// ---------------------------------------------------------------------------
// Reply scope
// ---------------------------------------------------------------------------

const REPLY = /\brepl(y|ies|ying)\b|\brespond/i
const REPLY_ALL = /\breply[\s-]*(to\s+)?all\b/i

/**
 * A reply goes to the sender only unless the user said "reply all". Enforced
 * on saveDraft's input rather than trusted to the model: `to` is cut to its
 * first address and cc/bcc are dropped. Requests that are not replies ("draft
 * an email to Bob and Alice") are left alone. Returns the input to use, or null.
 */
/**
 * replyToMessage, made safe to call: never skipReview (so it can only open a
 * review window), and sender only unless the user said "reply all".
 */
export function reviewReplyInput(input, requestText) {
  const out = { ...(input ?? {}) }
  delete out.skipReview
  if (!REPLY_ALL.test(requestText)) {
    out.replyAll = false
    delete out.cc
    delete out.bcc
  }
  return out
}

export function scopeReplyDraft(input, requestText) {
  if (!input || typeof input !== 'object') return null
  if (!REPLY.test(requestText) || REPLY_ALL.test(requestText)) return null
  const out = { ...input }
  let changed = false
  if (typeof out.to === 'string' && out.to.includes(',')) {
    // Split on commas outside quotes: "Iyer, K" <k@x.com> is one address.
    const first = out.to.match(/(?:"[^"]*"|[^,])+/)?.[0]?.trim()
    if (first && first !== out.to.trim()) {
      out.to = first
      changed = true
    }
  }
  for (const k of ['cc', 'bcc']) {
    if (out[k]) {
      delete out[k]
      changed = true
    }
  }
  return changed ? out : null
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

/** One JSON line per event in logs/brain.log, plus a readable console line. */
export function logBrain(entry) {
  const line = { at: new Date().toISOString(), ...entry }
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(BRAIN_LOG, JSON.stringify(line) + '\n')
  } catch (err) {
    console.error(`[jarvis] could not write brain log: ${err.message}`)
  }
  const { event, brain, ...rest } = entry
  console.log(`[brain] ${event} ${brain} ${JSON.stringify(rest)}`)
}

// ---------------------------------------------------------------------------
// Time zones, handled here rather than by the model
// ---------------------------------------------------------------------------

/** "+HH:MM" / "-HH:MM" for this machine at the given moment. */
export function utcOffset(at = new Date()) {
  const off = -at.getTimezoneOffset()
  const pad = (n) => String(n).padStart(2, '0')
  return `${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
}

const MIDNIGHT = /^(\d{4}-\d{2}-\d{2})(?:T00:00(?::00(?:\.0+)?)?Z?)?$/
const DAY_MS = 24 * 60 * 60 * 1000

/** A date the model gave us, as an instant. A bare or midnight date means local midnight. */
function asInstant(value) {
  if (typeof value !== 'string') return null
  const m = MIDNIGHT.exec(value)
  const d = m ? new Date(`${m[1]}T00:00:00`) : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * The window each listEvents call asked for, by tool-use id, so the hook that
 * reads the result can filter to it.
 */
const calendarWindows = new Map()

/**
 * Thunderbird's own range filter is unreliable for all-day events at the edges
 * of a range, and models ask for "tomorrow" as midnight-to-midnight UTC. So:
 * remember the local-time window that was meant, ask Thunderbird for a day
 * either side of it, and let localiseTimesHook cut the result back down.
 * `allCalendars` drops a single-calendar filter (the local model adds one
 * unprompted). Returns the input to run, or null to leave it alone.
 */
export function fixCalendarInput(input, toolUseID, { allCalendars = false } = {}) {
  if (!input || typeof input !== 'object') return null
  const out = { ...input }
  let changed = false
  const start = asInstant(out.startDate)
  const end = asInstant(out.endDate)
  if (start && end && end > start) {
    calendarWindows.set(toolUseID, { start, end })
    out.startDate = new Date(start.getTime() - DAY_MS).toISOString()
    out.endDate = new Date(end.getTime() + DAY_MS).toISOString()
    changed = true
  }
  if (allCalendars && 'calendarId' in out) {
    delete out.calendarId
    changed = true
  }
  return changed ? out : null
}

/** Does this event fall in the window? All-day events by their date, others by overlap. */
function inWindow(ev, { start, end }) {
  if (!ev || typeof ev.startDate !== 'string') return true
  if (ev.allDay === true) {
    const day = new Date(`${ev.startDate.slice(0, 10)}T00:00:00`)
    return day >= start && day < end
  }
  const s = new Date(ev.startDate)
  const e = typeof ev.endDate === 'string' ? new Date(ev.endDate) : s
  return s < end && e > start
}

/** listEvents returns a JSON array of events inside a text block; filter it. */
function filterEvents(response, window) {
  const filterText = (text) => {
    try {
      const events = JSON.parse(text)
      return Array.isArray(events) ? JSON.stringify(events.filter((ev) => inWindow(ev, window))) : text
    } catch {
      return text
    }
  }
  if (typeof response === 'string') return filterText(response)
  if (Array.isArray(response)) {
    return response.map((b) => (b?.type === 'text' ? { ...b, text: filterText(b.text) } : b))
  }
  if (response && Array.isArray(response.content)) return { ...response, content: filterEvents(response.content, window) }
  return response
}

const ISO_Z = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)\b/g

function localStamp(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const when = d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
  return `${when} local time`
}

/** Walk a tool result, rewriting UTC timestamps to local and all-day events to their date. */
function localiseValue(v) {
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        return JSON.stringify(localiseValue(JSON.parse(trimmed)))
      } catch {
        /* not JSON; fall through */
      }
    }
    return v.replace(ISO_Z, (iso) => localStamp(iso))
  }
  if (Array.isArray(v)) return v.map(localiseValue)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      if (v.allDay === true && (k === 'startDate' || k === 'endDate') && typeof val === 'string') {
        out[k] = `${val.slice(0, 10)} (all day)`
      } else if (k === 'recurrenceId') {
        continue
      } else {
        out[k] = localiseValue(val)
      }
    }
    return out
  }
  return v
}

/**
 * PostToolUse hook: Thunderbird reports every time in UTC, and a model reading
 * "22:30Z" aloud as "ten thirty" is the commonest wrong answer. Convert first.
 */
export const localiseTimesHook = async (input) => {
  if (!String(input.tool_name).startsWith('mcp__thunderbird__')) return {}
  let response = input.tool_response
  const window = calendarWindows.get(input.tool_use_id)
  if (window) {
    calendarWindows.delete(input.tool_use_id)
    response = filterEvents(response, window)
  }
  const updated = localiseValue(response)
  if (process.env.JARVIS_DEBUG_HOOK === '1') {
    console.log(`[hook] ${input.tool_name} ${window ? 'filtered+' : ''}localised: ${JSON.stringify(updated).slice(0, 400)}`)
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedMCPToolOutput: updated,
    },
  }
}

#!/usr/bin/env node
/**
 * Read-only Thunderbird data for the Jarvis desktop HUD.
 *
 * Talks to the same Thunderbird MCP server Jarvis uses (the mcp-bridge.cjs
 * that ~/.claude.json points at) and calls ONLY the read tools listed in
 * READ_ONLY below; anything else is refused before it is sent.
 *
 * Prints one JSON object:
 *   { accounts: [{ name, unread }], meetings: [{ title, start, end }], at, error? }
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const READ_ONLY = new Set(['listAccounts', 'listFolders', 'listEvents'])

function bridgeCommand() {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.claude.json`, 'utf8'))
  const tb = cfg.mcpServers?.thunderbird
  if (!tb?.command) throw new Error('no thunderbird MCP server in ~/.claude.json')
  return [tb.command, tb.args ?? []]
}

function session() {
  const [cmd, args] = bridgeCommand()
  const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] })
  const waiting = new Map()
  let buf = '', next = 1
  p.stdout.on('data', (d) => {
    buf += d
    const lines = buf.split('\n'); buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      const m = JSON.parse(line)
      waiting.get(m.id)?.(m); waiting.delete(m.id)
    }
  })
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n')
  const request = (method, params) => new Promise((resolve) => {
    const id = next++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params })
  })
  return {
    async init() {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jarvis-hud', version: '1' } })
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    },
    async call(name, args = {}) {
      if (!READ_ONLY.has(name)) throw new Error(`refused: ${name} is not a read-only tool`)
      const r = await request('tools/call', { name, arguments: args })
      const text = r.result?.content?.[0]?.text ?? 'null'
      const data = JSON.parse(text)
      if (data?.error) throw new Error(data.error)
      return data
    },
    close() { p.kill() },
  }
}

const out = { accounts: [], meetings: [], at: new Date().toISOString() }
const s = session()
const timeout = setTimeout(() => { out.error = 'Thunderbird did not answer'; print() }, 20000)
function print() { clearTimeout(timeout); s.close(); process.stdout.write(JSON.stringify(out)); process.exit(0) }

try {
  await s.init()
  const accounts = await s.call('listAccounts')
  const folders = await s.call('listFolders')
  const inboxes = (Array.isArray(folders) ? folders : folders.folders ?? []).filter((f) => f.type === 'inbox')
  for (const a of Array.isArray(accounts) ? accounts : accounts.accounts ?? []) {
    const inbox = inboxes.find((f) => f.accountId === a.id)
    if (inbox) out.accounts.push({ name: a.name, unread: inbox.unreadMessages ?? 0 })
  }
  // Today's remaining timed meetings, next three.
  const now = new Date()
  const end = new Date(now); end.setHours(24, 0, 0, 0)
  const events = await s.call('listEvents', { startDate: now.toISOString(), endDate: end.toISOString(), maxResults: 50 })
  out.meetings = (Array.isArray(events) ? events : events.events ?? [])
    .filter((e) => !e.allDay && new Date(e.endDate) > now)
    .sort((a, b) => new Date(a.startDate) - new Date(b.startDate))
    .slice(0, 3)
    .map((e) => ({ title: (e.title ?? '').trim(), start: e.startDate, end: e.endDate }))
} catch (err) {
  out.error = String(err.message ?? err)
}
print()

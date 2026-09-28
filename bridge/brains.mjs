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
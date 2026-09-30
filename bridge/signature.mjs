/**
 * Thunderbird signatures for drafts saved with saveDraft.
 *
 * Thunderbird inserts a signature only when a compose window opens, so a draft
 * saved directly (saveDraft) has none. Before every saveDraft the bridge:
 *   1. resolves the sending identity from the `from` the model chose, and
 *      always passes it explicitly (as the identity id), so a draft never
 *      falls back to the default account;
 *   2. reads that identity's signature from the Thunderbird profile's prefs.js:
 *      htmlSigText when htmlSigFormat is true, else sig_file when
 *      attach_signature is true, else a plain htmlSigText; none if empty;
 *   3. sends the draft as HTML: the body as simple paragraphs, then
 *      Thunderbird's standard separator ("-- ") and the signature, at the
 *      bottom (sig_bottom only matters for replies, and these are new drafts).
 *
 * prefs.js is read fresh on every draft, so signature edits in Thunderbird
 * apply straight away. This module never writes to the profile.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const TB_DIR = join(homedir(), 'Library', 'Thunderbird')

/** The profile Thunderbird launches with: the [Install…] Default in profiles.ini. */
function profileDir() {
  const ini = readFileSync(join(TB_DIR, 'profiles.ini'), 'utf8')
  let section = ''
  let installDefault = null
  let profileDefault = null
  let lastPath = null
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim()
    const s = /^\[(.+)\]$/.exec(line)
    if (s) { section = s[1]; continue }
    const kv = /^([^=]+)=(.*)$/.exec(line)
    if (!kv) continue
    const [, k, v] = kv
    if (section.startsWith('Install') && k === 'Default') installDefault = v
    if (section.startsWith('Profile') && k === 'Path') lastPath = v
    if (section.startsWith('Profile') && k === 'Default' && v === '1') profileDefault = lastPath
  }
  const rel = installDefault ?? profileDefault
  if (!rel) throw new Error('no default Thunderbird profile in profiles.ini')
  return isAbsolute(rel) ? rel : join(TB_DIR, rel)
}

/** user_pref("key", value); lines, values parsed as JSON literals. */
function readPrefs(dir) {
  const prefs = {}
  for (const line of readFileSync(join(dir, 'prefs.js'), 'utf8').split('\n')) {
    const m = /^user_pref\("([^"]+)",\s*(.*)\);\s*$/.exec(line)
    if (!m) continue
    try {
      prefs[m[1]] = JSON.parse(m[2])
    } catch {
      prefs[m[1]] = m[2]
    }
  }
  return prefs
}

/** Every sending identity, with its account and signature settings. */
function identities(prefs) {
  const out = []
  const accounts = String(prefs['mail.accountmanager.accounts'] ?? '').split(',').filter(Boolean)
  for (const account of accounts) {
    const ids = String(prefs[`mail.account.${account}.identities`] ?? '').split(',').filter(Boolean)
    const server = prefs[`mail.account.${account}.server`]
    ids.forEach((id, i) => {
      const g = (k) => prefs[`mail.identity.${id}.${k}`]
      out.push({
        id,
        account,
        accountName: prefs[`mail.server.${server}.name`] ?? account,
        email: String(g('useremail') ?? ''),
        isAccountDefault: i === 0,
        htmlSigText: String(g('htmlSigText') ?? ''),
        htmlSigFormat: g('htmlSigFormat') === true,
        attachSignature: g('attach_signature') === true,
        sigFile: g('sig_file') ?? null,
        suppressSeparator: g('suppress_sig_separator') === true,
      })
    })
  }
  return out
}

/**
 * The identity `from` names: an identity id (id5), an exact address, or an
 * address in any case (then the account's default identity for it).
 */
function resolveIdentity(from, list) {
  const f = String(from ?? '').trim()
  if (!f) return null
  const byId = list.find((x) => x.id === f)
  if (byId) return byId
  const email = (/<([^>]+)>/.exec(f)?.[1] ?? f).trim()
  const exact = list.find((x) => x.email === email)
  if (exact) return exact
  const same = list.filter((x) => x.email.toLowerCase() === email.toLowerCase())
  return same.find((x) => x.isAccountDefault) ?? same[0] ?? null
}

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Plain text to simple HTML: blank lines separate paragraphs, single newlines become <br>. */
export function textToHtml(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

/** The identity's signature as HTML, or '' when it has none. */
function signatureHtml(identity) {
  if (identity.htmlSigFormat && identity.htmlSigText.trim()) return identity.htmlSigText
  if (identity.attachSignature && identity.sigFile && existsSync(identity.sigFile)) {
    const content = readFileSync(identity.sigFile, 'utf8')
    return /\.html?$/i.test(identity.sigFile) ? content : escapeHtml(content).replace(/\n/g, '<br>')
  }
  if (identity.htmlSigText.trim()) return escapeHtml(identity.htmlSigText).replace(/\n/g, '<br>')
  return ''
}

/**
 * Rewrite a saveDraft call: explicit sending identity, HTML body, signature.
 * Returns { input, identity, signed } or { error } (the call is then refused
 * with that message, which tells the model how to retry).
 */
export function prepareDraft(input) {
  let list
  try {
    list = identities(readPrefs(profileDir()))
  } catch (err) {
    return { error: `Could not read the Thunderbird profile to add the signature (${err.message}).` }
  }
  const identity = resolveIdentity(input?.from, list)
  if (!identity) {
    const known = list.map((x) => `${x.email} (${x.accountName})`).join(', ')
    return {
      error:
        'saveDraft needs "from": the email address of the account to send from, ' +
        `following the account rules. Accounts: ${known}. Try again with "from" set.`,
    }
  }
  const body = input.isHtml ? String(input.body ?? '') : textToHtml(input.body)
  const sig = signatureHtml(identity)
  const html = sig
    ? `${body}\n<p><br></p>\n<div class="moz-signature">${identity.suppressSeparator ? '' : '-- <br>\n'}${sig}</div>`
    : body
  return {
    input: { ...input, from: identity.id, isHtml: true, body: html },
    identity: `${identity.accountName} <${identity.email}> (${identity.id})`,
    signed: Boolean(sig),
  }
}

// Opens the Jarvis Chrome profile (the one Jarvis joins Zoom calls with) so you
// can do the one-time setup in it, such as signing in to Zoom on the web:
//   node scripts/zoom-profile.mjs [url]
// Close the window when done. Jarvis must not be in a call at the time.
import { spawn } from 'node:child_process'
import { ensureProfile, PROFILE_DIR } from '../bridge/zoom.mjs'

ensureProfile()
const url = process.argv[2] || 'https://zoom.us/signin'
spawn(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [`--user-data-dir=${PROFILE_DIR}`, '--no-first-run', '--no-default-browser-check', url],
  { detached: true, stdio: 'ignore' },
).unref()
console.log(`Opened the Jarvis Chrome profile at ${url}`)

// Copies the built app to /Applications/Jarvis.app and gives it an ad-hoc
// signature (Apple Silicon will not run an unsigned app). The outer app is
// re-signed with an explicit designated requirement — its bundle identifier —
// because macOS ties the microphone permission to that requirement: by default
// an ad-hoc one is the exact binary hash, so every rebuild asked again.
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, cpSync } from 'node:fs'

const built = 'dist/mac-arm64/Jarvis.app'
const target = '/Applications/Jarvis.app'
if (!existsSync(built)) throw new Error(`${built} not found — run electron-builder first`)
if (existsSync(target)) rmSync(target, { recursive: true, force: true })
cpSync(built, target, { recursive: true, verbatimSymlinks: true })
execFileSync('codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'inherit' })
execFileSync('codesign', ['--force', '--sign', '-', '-r=designated => identifier "local.jarvis.desktop"', target], { stdio: 'inherit' })
execFileSync('codesign', ['--verify', '--deep', '--strict', target], { stdio: 'inherit' })
console.log(`installed ${target}`)

// Ask the running bridge one question, as the page would, and print the answer.
//   node scripts/ask.mjs "What's on my calendar tomorrow?"
import WebSocket from 'ws'
const text = process.argv.slice(2).join(' ')
const ws = new WebSocket('ws://localhost:8787', { origin: 'http://localhost:5173' })
const id = `t${Date.now()}`
let out = ''
const t0 = Date.now()
const timer = setTimeout(() => { console.log('\n[timeout]'); process.exit(2) }, 240_000)
ws.on('open', () => ws.send(JSON.stringify({ type: 'ask', id, text })))
ws.on('message', (raw) => {
  const m = JSON.parse(raw)
  if (m.ask && m.ask !== id) return
  if (m.type === 'ack') console.log(`  [ack spoken after ${Date.now() - t0} ms] ${m.text}`)
  if (m.type === 'tool') console.log(`  [tool] ${m.name}`)
  if (m.type === 'text') out += m.delta
  if (m.type === 'done' || m.type === 'error') {
    console.log(`JARVIS (${((Date.now() - t0) / 1000).toFixed(1)} s): ${m.text || out || m.message}`)
    clearTimeout(timer); ws.close(); process.exit(0)
  }
})

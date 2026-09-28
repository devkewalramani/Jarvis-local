#!/usr/bin/env node
/**
 * Everything the Jarvis desktop HUD shows, as one JSON object:
 *   mail + meetings  from Thunderbird, read only (thunderbird.mjs)
 *   weather          from Open-Meteo (no key) for the place in ../config.json,
 *                    cached 15 minutes
 *   cpu + memory     from top and memory_pressure
 * Run by the Übersicht widget every 30 seconds.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE = join(HERE, '..', '.cache')
const MAX_AGE_MS = 15 * 60 * 1000
// Your location lives in config.json (gitignored); config.example.json is the template.
function loadConfig() {
  for (const f of ['config.json', 'config.example.json']) {
    try { return JSON.parse(readFileSync(join(HERE, '..', f), 'utf8')) } catch { /* try the next */ }
  }
  return {}
}
const WEATHER = { place: 'Weather', lat: 0, lon: 0, ...loadConfig().weather }

async function thunderbird() {
  try {
    const { stdout } = await run(process.execPath, [join(HERE, 'thunderbird.mjs')], { timeout: 25000 })
    return JSON.parse(stdout)
  } catch (err) {
    return { accounts: [], meetings: [], error: 'Thunderbird unavailable' }
  }
}

async function weather() {
  const file = join(CACHE, 'weather.json')
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8'))
    if (Date.now() - cached.fetched < MAX_AGE_MS && cached.place === WEATHER.place) return cached
  } catch { /* no cache yet */ }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER.lat}&longitude=${WEATHER.lon}` +
      '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min&forecast_days=1' +
      '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto'
    const d = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json()
    const out = {
      place: WEATHER.place,
      temp: Math.round(d.current.temperature_2m),
      feels: Math.round(d.current.apparent_temperature),
      code: d.current.weather_code,
      wind: Math.round(d.current.wind_speed_10m),
      hi: Math.round(d.daily.temperature_2m_max[0]),
      lo: Math.round(d.daily.temperature_2m_min[0]),
      fetched: Date.now(),
    }
    mkdirSync(CACHE, { recursive: true })
    writeFileSync(file, JSON.stringify(out))
    return out
  } catch {
    try { return { ...JSON.parse(readFileSync(file, 'utf8')), stale: true } } catch { return null }
  }
}

async function system() {
  try {
    const [{ stdout: top }, { stdout: mem }] = await Promise.all([
      run('/usr/bin/top', ['-l', '2', '-n', '0', '-s', '1'], { timeout: 8000 }),
      run('/usr/bin/memory_pressure', ['-Q'], { timeout: 8000 }),
    ])
    const cpuLine = top.trim().split('\n').filter((l) => l.startsWith('CPU usage')).pop() ?? ''
    const idle = Number(/([\d.]+)% idle/.exec(cpuLine)?.[1] ?? NaN)
    const free = Number(/free percentage:\s*(\d+)%/.exec(mem)?.[1] ?? NaN)
    return { cpu: Math.round(100 - idle), mem: Math.round(100 - free) }
  } catch {
    return null
  }
}

const [tb, wx, sys] = await Promise.all([thunderbird(), weather(), system()])
process.stdout.write(JSON.stringify({ ...tb, weather: wx, system: sys }))

// Jarvis desktop HUD for Übersicht: time and date, today's next meetings,
// unread mail per account, local weather, CPU and memory.
// Style from ~/jarvis-home/src/index.css: cyan #00e5ff on #01060c, thin lines,
// Chakra Petch with JetBrains Mono for numbers. Data: lib/hud.mjs (read only).
//
// POSITION: a right hand column. Keep it clear of the Jarvis app window by
// changing `right` / `top` / `width` below. Weather place: config.json.

import { css } from 'uebersicht'

export const command = '/opt/homebrew/bin/node jarvis-hud/lib/hud.mjs'
export const refreshFrequency = 30 * 1000

const CYAN = '0, 229, 255'
const c = (a) => `rgba(${CYAN}, ${a})`

export const className = `
  top: 56px;
  right: 40px;
  width: 520px;
  font-family: 'Chakra Petch', system-ui, sans-serif;
  color: ${c(0.92)};
  text-transform: uppercase;
  letter-spacing: 0.16em;
  -webkit-font-smoothing: antialiased;
  text-shadow: 0 0 8px ${c(0.45)}, 0 1px 2px rgba(0, 0, 0, 0.9);
`

const panel = css`
  position: relative;
  margin-bottom: 14px;
  padding: 14px 18px 16px;
  background: rgba(1, 6, 12, 0.55);
  border: 1px solid ${c(0.28)};
  box-shadow: 0 0 14px ${c(0.18)}, inset 0 0 24px ${c(0.05)};
  &::before, &::after {
    content: '';
    position: absolute;
    width: 14px;
    height: 14px;
    border: 1px solid ${c(0.85)};
  }
  &::before { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
  &::after { bottom: -1px; right: -1px; border-left: 0; border-top: 0; }
`
const label = css`
  font-size: 9px;
  letter-spacing: 0.34em;
  opacity: 0.72;
  margin-bottom: 9px;
`
const mono = css`
  font-family: 'JetBrains Mono', monospace;
  letter-spacing: 0.06em;
`
const row = css`
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 12px;
  padding: 3px 0;
`
const dim = css`opacity: 0.55;`
const bar = (pct) => css`
  height: 3px;
  margin: 4px 0 8px;
  background: ${c(0.12)};
  & > div {
    width: ${Math.max(0, Math.min(100, pct))}%;
    height: 100%;
    background: ${c(0.85)};
    box-shadow: 0 0 6px ${c(0.8)};
  }
`

const WEATHER = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog',
  51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle', 61: 'Rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Snow', 73: 'Snow', 75: 'Snow', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers',
  95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm',
}
const hhmm = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export const render = ({ output, error }) => {
  let d = {}
  try { d = JSON.parse(output) } catch { /* first run, or no output yet */ }
  const now = new Date()
  const mail = d.accounts ?? []
  const total = mail.reduce((n, a) => n + a.unread, 0)
  const w = d.weather
  const s = d.system

  return (
    <div>
      <div className={panel}>
        <div className={label}>Local time</div>
        <div className={mono} style={{ fontSize: 46, lineHeight: 1, letterSpacing: '0.04em' }}>
          {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
        </div>
        <div style={{ fontSize: 12, marginTop: 8, opacity: 0.85 }}>
          {now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
        </div>
      </div>

      <div className={panel}>
        <div className={label}>Next meetings today</div>
        {(d.meetings ?? []).length === 0 && <div className={`${row} ${dim}`}>Nothing else today</div>}
        {(d.meetings ?? []).map((m, i) => (
          <div className={row} key={i}>
            <span style={{ textTransform: 'none', letterSpacing: '0.04em', maxWidth: 360, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{m.title}</span>
            <span className={mono}>{hhmm(new Date(m.start))}</span>
          </div>
        ))}
      </div>

      <div className={panel}>
        <div className={label}>Unread mail · {total}</div>
        {mail.map((a) => (
          <div className={`${row} ${a.unread ? '' : dim}`} key={a.name}>
            <span>{a.name}</span>
            <span className={mono}>{String(a.unread).padStart(3, '0')}</span>
          </div>
        ))}
        {d.error && <div className={`${row} ${dim}`}>{d.error}</div>}
      </div>

      <div className={panel}>
        <div className={label}>{w?.place ?? 'Weather'}{w?.stale ? ' · stale' : ''}</div>
        {w ? (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
            <span className={mono} style={{ fontSize: 34, lineHeight: 1 }}>{w.temp}°</span>
            <span style={{ fontSize: 12 }}>
              {WEATHER[w.code] ?? 'Weather'}
              <span className={dim}> · feels {w.feels}° · H {w.hi}° L {w.lo}° · wind {w.wind} mph</span>
            </span>
          </div>
        ) : <div className={dim}>Weather unavailable</div>}
      </div>

      <div className={panel}>
        <div className={label}>System</div>
        <div className={row}><span>CPU</span><span className={mono}>{s ? `${s.cpu}%` : '--'}</span></div>
        <div className={bar(s?.cpu ?? 0)}><div /></div>
        <div className={row}><span>Memory</span><span className={mono}>{s ? `${s.mem}%` : '--'}</span></div>
        <div className={bar(s?.mem ?? 0)}><div /></div>
      </div>
      {error && <div className={dim} style={{ fontSize: 10 }}>{String(error).slice(0, 120)}</div>}
    </div>
  )
}

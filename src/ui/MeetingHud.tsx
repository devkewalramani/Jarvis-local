import { useEffect, useRef, useState } from 'react'
import { IS_DESKTOP } from '../lib/desktop'
import { chime, clock, itemLeftMs, meetingAlert, totalLeftMs, useMeeting } from '../lib/meeting'

/**
 * Meeting mode on the HUD: the current item's countdown in the middle of the
 * reactor, and below the rings the current item, the next one, the total time
 * left, and the shortcuts. The ring itself turns amber at two minutes left and
 * red at zero (Scene reads meetingAlert). A nudge sounds once per threshold,
 * and only when the output is headphones.
 */
const KEYS = '⌃⌥⌘'

export function MeetingHud() {
  const m = useMeeting()
  const [, repaint] = useState(0)
  const nudged = useRef({ index: -1, amber: false, red: false })

  useEffect(() => {
    if (m.phase !== 'running') return
    const id = window.setInterval(() => {
      repaint((n) => n + 1)
      const state = useMeeting.getState()
      const alert = meetingAlert(state)
      const seen = nudged.current
      if (seen.index !== state.index) nudged.current = { index: state.index, amber: false, red: false }
      if (alert && !nudged.current[alert]) {
        nudged.current[alert] = true
        if (state.headphones) chime(alert)
      }
    }, 250)
    return () => window.clearInterval(id)
  }, [m.phase])

  if (m.phase !== 'running') return null
  const item = m.items[m.index]
  const next = m.items[m.index + 1]
  const left = itemLeftMs(m)
  const alert = meetingAlert(m)

  return (
    <div className={`meeting meeting-${alert ?? 'ok'}`} role="timer" aria-live="off">
      <div className="meeting-centre">
        <div className="meeting-clock">{clock(left)}</div>
        <div className="meeting-centre-label">{left < 0 ? 'over on' : 'left on'} {item?.title}</div>
      </div>
      <div className="meeting-strip">
        <div className="meeting-row">
          <span className="meeting-tag">Now</span>
          <span className="meeting-item">{item?.title}</span>
          <span className="meeting-mono">{item?.minutes} min</span>
        </div>
        <div className="meeting-row meeting-dim">
          <span className="meeting-tag">Next</span>
          <span className="meeting-item">{next ? next.title : 'End of agenda'}</span>
          <span className="meeting-mono">{next ? `${next.minutes} min` : ''}</span>
        </div>
        <div className="meeting-row">
          <span className="meeting-tag">Total left</span>
          <span className="meeting-item meeting-mono">{clock(totalLeftMs(m))}</span>
          <span className="meeting-mono meeting-dim">
            item {m.index + 1}/{m.items.length}
          </span>
        </div>
        <div className="meeting-foot">
          Mic off · nudges {m.headphones ? 'in headphones' : 'visual only'} · {KEYS}N next · {KEYS}E end
          {IS_DESKTOP ? '' : ' (window focused)'}
        </div>
      </div>
    </div>
  )
}

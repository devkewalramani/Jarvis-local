import { useEffect, useState } from 'react'
import { Scene } from '../scene/Scene'
import { useStore } from '../store'
import { BRIDGE_HTTP_URL } from '../config'
import { clock, itemLeftMs, meetingAlert, useMeeting } from '../lib/meeting'

/**
 * The meeting tile: a 1280x720 page that OBS captures as Jarvis's camera in a
 * call. The reactor, the current agenda item and its time left, a small
 * label, and a status line. It follows meeting mode through the bridge's
 * /meeting/state, which carries only the agenda and the timer, so nothing
 * private (no transcript, no title, no mail) can reach this page.
 *
 * It never opens a microphone, a camera or the bridge's socket.
 */
type Call = { introReady: boolean; muted: boolean | null }
type TileState = {
  phase: 'off' | 'running'
  items: { title: string; minutes: number }[]
  index: number
  itemStartedAt: number
  call: Call
}

const POLL_MS = 500

export function statusLine(phase: TileState['phase'], call: Call): string {
  const parts: string[] = []
  if (call.introReady) parts.push('INTRO READY')
  if (call.muted === true) parts.push('MUTED')
  if (call.muted === false) parts.push('MIC LIVE')
  if (parts.length) return parts.join(' · ')
  return phase === 'running' ? 'KEEPING TIME' : 'STANDING BY'
}

export function Tile() {
  const [call, setCall] = useState<Call>({ introReady: false, muted: null })
  const m = useMeeting()
  const [, repaint] = useState(0)

  useEffect(() => {
    // The reactor idles in its calm colour; meeting alerts tint it amber/red.
    useStore.setState({ phase: 'dormant' })
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch(`${BRIDGE_HTTP_URL}/meeting/state`, { cache: 'no-store', signal: AbortSignal.timeout(2000) })
        const s = (await res.json()) as TileState
        if (!alive) return
        useMeeting.setState(
          s.phase === 'running'
            ? { phase: 'running', items: s.items, index: s.index, itemStartedAt: s.itemStartedAt }
            : { phase: 'off', items: [], index: 0, itemStartedAt: 0 },
        )
        setCall(s.call ?? { introReady: false, muted: null })
      } catch {
        /* bridge restarting: keep the last state */
      }
      repaint((n) => n + 1)
    }
    void poll()
    const id = window.setInterval(poll, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])

  const running = m.phase === 'running'
  const item = running ? m.items[m.index] : undefined
  const left = itemLeftMs(m)
  const alert = meetingAlert(m)

  return (
    <div className={`tile tile-${alert ?? 'ok'}`}>
      <div className="tile-stage">
        <Scene />
      </div>
      <div className="tile-label">J.A.R.V.I.S.</div>
      <div className="tile-strip">
        {item ? (
          <>
            <div className="tile-item">{item.title}</div>
            <div className="tile-left">
              <span className="tile-clock">{left < 0 ? `+${clock(-left)}` : clock(left)}</span>
              <span className="tile-left-word">{left < 0 ? 'over' : 'left'}</span>
              <span className="tile-count">
                item {m.index + 1} of {m.items.length}
              </span>
            </div>
          </>
        ) : (
          <div className="tile-item tile-idle">Timekeeper</div>
        )}
      </div>
      <div className="tile-status">{statusLine(running ? 'running' : 'off', call)}</div>
    </div>
  )
}

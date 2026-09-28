import { useEffect, useRef, useState } from 'react'
import { DESKTOP } from '../lib/desktop'
import { diag, startMicTest } from '../lib/voice'
import { voiceSettings } from '../lib/voiceSettings'

/**
 * "Test mic", from the desktop app's menu bar icon.
 *
 * For ten seconds it shows the live input level against the level that counts
 * as speech, and the openWakeWord confidence of each thing said, against the
 * wake word threshold chosen in the menu. Nothing said during the test wakes
 * Jarvis or reaches the brain (see micTesting in voice.ts).
 */
const TEST_MS = 10_000

export function MicTest() {
  const [until, setUntil] = useState(0)
  const [, repaint] = useState(0)
  const peak = useRef(0)
  const startedAt = useRef(0)

  useEffect(() => {
    DESKTOP?.onMicTest?.((ms) => {
      const length = ms > 0 ? ms : TEST_MS
      startMicTest(length)
      peak.current = 0
      startedAt.current = Date.now()
      setUntil(Date.now() + length)
    })
  }, [])

  useEffect(() => {
    if (!until) return
    const id = window.setInterval(() => {
      if (Date.now() > until) {
        setUntil(0)
        window.clearInterval(id)
      }
      repaint((n) => n + 1)
    }, 100)
    return () => window.clearInterval(id)
  }, [until])

  if (!until) return null

  const m = diag.meter?.() ?? { energy: 0, floor: 0, threshold: 0, speaking: false }
  // The trigger sits at the middle of the bar: fill past the line and it
  // counts as speech. Louder than twice the trigger simply fills the bar.
  const level = m.threshold > 0 ? Math.min(1, m.energy / (m.threshold * 2)) : 0
  peak.current = Math.max(peak.current, level)
  const s = voiceSettings()
  const scored = diag.wakeScoreAt >= startedAt.current ? diag.wakeScore : null
  const threshold = diag.wakeThreshold ?? s.wakeThreshold
  const secondsLeft = Math.max(0, Math.ceil((until - Date.now()) / 1000))

  return (
    <div className="mic-test" role="status">
      <div className="mic-test-head">
        <span>Mic test</span>
        <span className="mic-test-mono">{secondsLeft}s</span>
      </div>

      <div className="mic-test-label">
        Input level {m.speaking ? <b>· speech</b> : <span className="mic-test-dim">· quiet</span>}
      </div>
      <div className="mic-test-bar">
        <div className="mic-test-fill" style={{ width: `${level * 100}%` }} />
        <div className="mic-test-peak" style={{ left: `${peak.current * 100}%` }} />
        <div className="mic-test-trigger" title="speech starts here" />
      </div>

      <div className="mic-test-label">Wake word confidence</div>
      <div className="mic-test-score">
        <span className="mic-test-mono">{scored == null ? '--' : scored.toFixed(2)}</span>
        <span className="mic-test-dim"> / needs {threshold.toFixed(2)}</span>
        {scored != null && (
          <b className={scored >= threshold ? 'mic-test-ok' : 'mic-test-miss'}>
            {scored >= threshold ? ' · would wake' : ' · would not wake'}
          </b>
        )}
      </div>
      {diag.testHeard && <div className="mic-test-heard">heard: “{diag.testHeard}”</div>}

      <div className="mic-test-foot">
        Say “Hey Jarvis” at your normal volume. End of speech pause {(s.pauseMs / 1000).toFixed(1)}s.
        {diag.engine !== 'elevenlabs' && ' Wake word scores need the local voice service.'}
      </div>
    </div>
  )
}

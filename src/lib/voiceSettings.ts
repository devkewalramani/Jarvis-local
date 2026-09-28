import { DESKTOP, type VoiceSettings } from './desktop'

/**
 * Microphone sensitivity, chosen from the desktop app's menu bar icon and
 * saved there (~/Library/Application Support/Jarvis/voice-settings.json). The
 * browser version uses the defaults.
 *
 *   wakeThreshold  openWakeWord confidence needed to wake (lower = more
 *                  sensitive). Sent with every wake clip; the voice service
 *                  applies it to that clip.
 *   pauseMs        how long a quiet gap ends what you are saying (vad.ts).
 */
const DEFAULTS: VoiceSettings = { wakeThreshold: 0.5, pauseMs: 1000 }

let current: VoiceSettings = { ...DEFAULTS, ...(DESKTOP?.getVoiceSettings?.() ?? {}) }
DESKTOP?.onVoiceSettings?.((s) => {
  current = { ...current, ...s }
})

export const voiceSettings = (): VoiceSettings => current

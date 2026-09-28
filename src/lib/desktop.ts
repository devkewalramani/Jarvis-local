/**
 * True inside the Electron desktop wrapper (desktop/), whose preload exposes
 * `window.jarvisDesktop`. There the page is drawn over the user's desktop, so
 * every full-screen background is transparent (see html.desktop in index.css).
 */
export type VoiceSettings = { wakeThreshold: number; pauseMs: number }

type DesktopBridge = {
  isDesktop: true
  getVoiceSettings?: () => VoiceSettings
  onVoiceSettings?: (cb: (s: VoiceSettings) => void) => void
  onMicTest?: (cb: (ms: number) => void) => void
  /** A wake whose speech turned out not to be a request, for the menu's list. */
  reportFalseWake?: (w: { score: number; threshold: number | null }) => void
}

export const DESKTOP: DesktopBridge | undefined = (
  window as { jarvisDesktop?: DesktopBridge }
).jarvisDesktop

export const IS_DESKTOP = Boolean(DESKTOP)

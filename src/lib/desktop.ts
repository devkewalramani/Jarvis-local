/**
 * True inside the Electron desktop wrapper (desktop/), whose preload exposes
 * `window.jarvisDesktop`. There the page is drawn over the user's desktop, so
 * every full-screen background is transparent (see html.desktop in index.css).
 */
export const IS_DESKTOP = Boolean(
  (window as { jarvisDesktop?: unknown }).jarvisDesktop,
)

/**
 * Runs in an isolated world before the page. Exposes one flag the page reads
 * to go transparent (src/lib/desktop.ts), marks <html> with the backdrop chosen
 * in the menu bar (styled in index.css), and turns a press-and-move into a
 * window drag. Nothing from Node or Electron reaches the page.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jarvisDesktop', Object.freeze({ isDesktop: true }))

// --- Backdrop: 'clear' | 'frosted' | 'dark' ---------------------------------

let backdrop = ipcRenderer.sendSync('jarvis:get-backdrop')
const markBackdrop = () => {
  if (document.documentElement) document.documentElement.dataset.backdrop = backdrop
}
markBackdrop()
document.addEventListener('DOMContentLoaded', markBackdrop)
ipcRenderer.on('jarvis:backdrop', (_e, mode) => {
  backdrop = mode
  markBackdrop()
})

// --- Dragging ---------------------------------------------------------------
//
// Clear: drag by the reactor. The reactor is the WebGL canvas; transparent
// parts of it never receive the press (clicks fall through them), so a press
// on the canvas is on something visible.
//
// Frosted and Dark: the whole panel is a handle — anywhere that is not a
// control, a panel or a blade (those keep their own clicks and drags).
//
// A small threshold keeps plain clicks working as clicks.

const INTERACTIVE =
  'button, a, input, textarea, select, label, iframe, video, [role="button"], [contenteditable], .blade, .blades-stack, .panels > *'

function isHandle(target) {
  if (!(target instanceof Element)) return false
  if (target instanceof HTMLCanvasElement) return true
  if (backdrop === 'clear') return false
  return !target.closest(INTERACTIVE)
}

let press = null

window.addEventListener(
  'mousedown',
  (e) => {
    if (e.button !== 0 || !isHandle(e.target)) return
    press = { x: e.screenX, y: e.screenY, moving: false }
  },
  true,
)

window.addEventListener(
  'mousemove',
  (e) => {
    if (!press || press.moving) return
    if (Math.hypot(e.screenX - press.x, e.screenY - press.y) < 4) return
    press.moving = true
    ipcRenderer.send('jarvis:drag-start')
  },
  true,
)

window.addEventListener(
  'mouseup',
  () => {
    if (press?.moving) {
      ipcRenderer.send('jarvis:drag-end')
      // Swallow the click that follows a drag.
      window.addEventListener('click', (ev) => ev.stopPropagation(), { capture: true, once: true })
    }
    press = null
  },
  true,
)

window.addEventListener('blur', () => {
  if (press?.moving) ipcRenderer.send('jarvis:drag-end')
  press = null
})


const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jarvisDesktop', Object.freeze({ isDesktop: true }))

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

let press = null

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

// Renders the app icon (build/icon.png, 1024px) and the menu bar template icon
// (assets/trayTemplate.png + @2x) from SVG, using Electron itself.
//   npx electron make-icon.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
 <defs>
  <radialGradient id="bg" cx="50%" cy="45%" r="70%"><stop offset="0" stop-color="#0b2433"/><stop offset="1" stop-color="#01060c"/></radialGradient>
  <radialGradient id="core" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffffff"/><stop offset="0.35" stop-color="#bff6ff"/><stop offset="1" stop-color="#00e5ff" stop-opacity="0"/></radialGradient>
  <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
 </defs>
 <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>
 <g filter="url(#glow)" fill="none" stroke="#35e6ff">
  <circle cx="512" cy="512" r="300" stroke-width="10" opacity="0.55"/>
  <circle cx="512" cy="512" r="262" stroke-width="26" stroke-dasharray="46 22"/>
  <circle cx="512" cy="512" r="205" stroke-width="8" opacity="0.8"/>
  <polygon points="512,352 651,592 373,592" stroke-width="22" stroke-linejoin="round"/>
 </g>
 <circle cx="512" cy="512" r="150" fill="url(#core)"/>
</svg>`

const tray = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 18 18">
 <g fill="none" stroke="#000">
  <circle cx="9" cy="9" r="7.6" stroke-width="1.3"/>
  <circle cx="9" cy="9" r="5.2" stroke-width="1" stroke-dasharray="1.6 0.9"/>
  <polygon points="9,5.6 12,10.9 6,10.9" stroke-width="1.2" stroke-linejoin="round"/>
 </g>
 <circle cx="9" cy="9" r="1.4" fill="#000"/>
</svg>`

// One offscreen window for every render: loading into a fresh window straight
// after destroying the last one fails with ERR_FAILED.
let w = null
async function render(svg, size, out, drawAt = size) {
  // Tiny windows refuse to load, so small icons are drawn large and scaled down.
  svg = svg.replace(/width="\d+" height="\d+"/, `width="${drawAt}" height="${drawAt}"`)
  w ??= new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false,
    useContentSize: true, webPreferences: { offscreen: true }, backgroundColor: '#00000000' })
  await w.loadURL('data:text/html,' + encodeURIComponent(
    `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg style="display:block" ')}</body></html>`))
  await new Promise((r) => setTimeout(r, 400))
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: drawAt, height: drawAt })
  fs.writeFileSync(out, img.resize({ width: size, height: size, quality: 'best' }).toPNG())
  console.log('wrote', out)
}

app.whenReady().then(async () => {
  await render(appIcon, 1024, path.join(__dirname, 'build', 'icon.png'))
  await render(tray(18), 18, path.join(__dirname, 'assets', 'trayTemplate.png'), 360)
  await render(tray(36), 36, path.join(__dirname, 'assets', 'trayTemplate@2x.png'), 360)
  app.quit()
})

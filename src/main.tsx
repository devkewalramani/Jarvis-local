import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { IS_DESKTOP } from './lib/desktop'

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
// Inside the desktop wrapper every full-screen background goes transparent.
if (IS_DESKTOP) document.documentElement.classList.add('desktop')

// Code changes reload the whole page rather than hot-swapping modules. A hot
// swap re-runs App's effects inside a page whose microphone is already open,
// which leaves the voice loop dead (no wake word) until a manual reload.
if (import.meta.hot) import.meta.hot.on('vite:beforeUpdate', () => location.reload())

// /tile is the meeting tile OBS shows to a call: its own page, with none of
// the assistant (no microphone, no socket, no transcript).
const root = createRoot(document.getElementById('root')!)
if (location.pathname === '/tile') {
  document.documentElement.classList.add('tile-page')
  void import('./ui/Tile').then(({ Tile }) => root.render(<Tile />))
} else {
  root.render(<App />)
}

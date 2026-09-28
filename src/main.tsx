import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { IS_DESKTOP } from './lib/desktop'

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
// Inside the desktop wrapper every full-screen background goes transparent.
if (IS_DESKTOP) document.documentElement.classList.add('desktop')

createRoot(document.getElementById('root')!).render(<App />)

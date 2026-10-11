import '@fontsource/barlow-condensed/500.css'
import '@fontsource/barlow-condensed/600.css'
import '@fontsource/barlow-condensed/700.css'
import '@fontsource/barlow-semi-condensed/400.css'
import '@fontsource/barlow-semi-condensed/500.css'
import '@fontsource/barlow-semi-condensed/600.css'
import '@fontsource/barlow-semi-condensed/700.css'
import '@fontsource-variable/noto-sans-sc/wght.css'
import './styles/tokens.css'
import './styles/base.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import type { Snapshot } from './bridge/protocol.ts'
import { Landing } from './landing/Landing.tsx'
import { connect, embedded } from './live/channel.ts'
import { receiveSnapshot } from './live/store.ts'
import { useStore } from './state/store.ts'
import { fontsReady, loadLocaleFonts } from './styles/fonts.ts'

const params = new URLSearchParams(window.location.search)
const mode = embedded() ? 'embed' : params.has('demo') ? 'demo' : 'landing'

if (mode === 'embed') connect()
const demo =
  mode === 'demo'
    ? import('./live/fixtures/demo.json').then(m => receiveSnapshot({ ...(m.default as unknown as Snapshot), at: Date.now() }, 'demo'))
    : null

const locale = useStore.getState().locale
void Promise.all([loadLocaleFonts(locale).then(() => fontsReady(locale)), demo]).then(() => {
  createRoot(document.getElementById('root')!).render(<StrictMode>{mode === 'landing' ? <Landing /> : <App />}</StrictMode>)
})

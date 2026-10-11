import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { GAME_ORIGINS } from './src/bridge/protocol.ts'
import { PAGES_BASE, USERSCRIPT_FILE, userscript } from './src/bridge/userscript.ts'

function userscriptFile(): Plugin {
  return {
    name: 'nimitzpf-userscript',
    configureServer(server) {
      server.middlewares.use(`/${USERSCRIPT_FILE}`, (req, res) => {
        const base = `http://${req.headers.host ?? 'localhost:5173'}/`
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(userscript({ base, bridge: 'src/bridge/main.ts', dev: true }))
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: USERSCRIPT_FILE, source: userscript({ base: PAGES_BASE, bridge: 'bridge.js' }) })
    },
  }
}

export default defineConfig({
  plugins: [react(), userscriptFile()],
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  server: { cors: { origin: [...GAME_ORIGINS] } },
})

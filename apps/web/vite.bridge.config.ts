import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: false,
  build: {
    target: 'es2022',
    emptyOutDir: false,
    sourcemap: false,
    lib: { entry: 'src/bridge/main.ts', formats: ['es'], fileName: () => 'bridge.js' },
  },
})

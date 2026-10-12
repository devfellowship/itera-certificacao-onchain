import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Fixture mode (VITE_FIXTURE_MODE=design): serve and emit msw's mockServiceWorker.js. Without the
 * flag this plugin does nothing, so the production build has no service worker.
 */
function mswWorker(): Plugin {
  const require = createRequire(import.meta.url)
  const source = () => readFileSync(require.resolve('msw/mockServiceWorker.js'), 'utf8')
  return {
    name: 'msw-worker',
    configureServer(server) {
      server.middlewares.use('/mockServiceWorker.js', (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript')
        res.end(source())
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'mockServiceWorker.js', source: source() })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const fixture = (process.env.VITE_FIXTURE_MODE ?? env.VITE_FIXTURE_MODE) === 'design'
  return {
    plugins: [react(), ...(fixture ? [mswWorker()] : [])],
  }
})

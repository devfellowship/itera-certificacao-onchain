/**
 * Static server of the web2 client (apps/web2). Same pattern as apps/web/server.mjs, without the
 * Open Graph injection: it serves the Vite build (`dist/`), falls back to index.html for unknown
 * paths (SPA routing), and answers `GET /health` with `ok` (Docker HEALTHCHECK).
 * No dependencies: node:http only.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'dist')
const PORT = Number(process.env.PORT ?? 80)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/** The file for a URL path inside ROOT, or null if it is not a regular file (or escapes ROOT). */
async function resolveFile(urlPath) {
  let decoded
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  const file = normalize(join(ROOT, decoded))
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return null
  try {
    return (await stat(file)).isFile() ? file : null
  } catch {
    return null
  }
}

function send(res, status, file) {
  const ext = extname(file)
  const headers = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream' }
  // Vite file names carry a content hash: cache them. index.html must always be revalidated.
  headers['Cache-Control'] = file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'
  res.writeHead(status, headers)
  createReadStream(file).pipe(res)
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('ok')
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' })
    res.end()
    return
  }
  const file = await resolveFile(url.pathname)
  if (file) return send(res, 200, file)
  // A missing file with an extension is a real 404; any other path is a client-side route.
  if (extname(url.pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  send(res, 200, join(ROOT, 'index.html'))
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`web2 listening on :${PORT}`))
}

/**
 * Static server of the web app (replaces Nginx; plan 20261012-itera-testmyagent-ui-refactor, ADR-7, U14).
 *
 * - Serves the Vite build (`dist/`). Unknown paths fall back to index.html (SPA routing).
 * - For `GET /e/:slugOrHash` it reads the public profile from the API and injects Open Graph and
 *   Twitter meta into index.html, so X, LinkedIn and Slack unfurl the link without running JS.
 *   If the API is slow or down, it serves the plain index.html: the SPA still works.
 * - `GET /health` answers `ok` (Docker HEALTHCHECK).
 *
 * No dependencies: node:http only.
 */
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'dist')
const PORT = Number(process.env.PORT ?? 80)
const API_BASE_URL = (process.env.API_BASE_URL ?? 'https://itera-agent-credentials-api.devfellowship.com').replace(/\/+$/, '')
const API_TIMEOUT_MS = Number(process.env.OG_API_TIMEOUT_MS ?? 4000)
const META_TTL_MS = 60_000
const KEY_RE = /^[A-Za-z0-9-]{3,100}$/

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
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
}

let indexHtml = ''
async function loadIndex() {
  indexHtml = await readFile(join(ROOT, 'index.html'), 'utf8')
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function fmtScore(n) {
  if (n === null || n === undefined) return '—'
  return Number.isInteger(n) ? String(n) : Number(n).toFixed(1)
}

/** The meta block for one public profile (the JSON of GET /public/evaluations/:key). */
export function profileMeta(p, origin) {
  const n = p.tasks?.length ?? 0
  const url = `${origin}/e/${p.slug}`
  const title = `${p.agent.name} — ${fmtScore(p.score)} on TestMyAgent`
  const verified = p.record?.status === 'Confirmed' ? 'verified onchain' : 'onchain record pending'
  const description = `${p.counts.pass} of ${n} task${n === 1 ? '' : 's'} PASS · ${p.agent.modelLabel} · ${verified}`
  const image = p.links?.og ?? `${API_BASE_URL}/public/evaluations/${encodeURIComponent(p.slug)}/og.png`
  const m = (attr, key, value) => `<meta ${attr}="${key}" content="${escapeHtml(value)}" />`
  return {
    title,
    description,
    tags: [
      m('property', 'og:type', 'website'),
      m('property', 'og:site_name', 'TestMyAgent'),
      m('property', 'og:title', title),
      m('property', 'og:description', description),
      m('property', 'og:url', url),
      m('property', 'og:image', image),
      m('property', 'og:image:type', 'image/png'),
      m('property', 'og:image:width', '1200'),
      m('property', 'og:image:height', '630'),
      m('property', 'og:image:alt', `${title}. ${description}.`),
      m('name', 'twitter:card', 'summary_large_image'),
      m('name', 'twitter:title', title),
      m('name', 'twitter:description', description),
      m('name', 'twitter:image', image),
      `<link rel="canonical" href="${escapeHtml(url)}" />`,
    ].join('\n    '),
  }
}

/** index.html with the profile's title, description and OG/Twitter tags. */
export function injectMeta(html, meta) {
  let out = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(meta.title)}</title>`)
  out = out.replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${escapeHtml(meta.description)}" />`)
  return out.replace('</head>', `    ${meta.tags}\n  </head>`)
}

const metaCache = new Map()
async function profileFor(key) {
  const hit = metaCache.get(key)
  if (hit && hit.at > Date.now() - META_TTL_MS) return hit.profile
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE_URL}/public/evaluations/${encodeURIComponent(key)}`, { signal: ctrl.signal })
    const profile = res.ok ? await res.json() : null
    if (res.ok || res.status === 404) {
      metaCache.set(key, { at: Date.now(), profile })
      while (metaCache.size > 500) metaCache.delete(metaCache.keys().next().value)
    }
    return profile
  } finally {
    clearTimeout(timer)
  }
}

function sendIndex(res, html, status = 200) {
  res.writeHead(status, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' })
  res.end(html)
}

function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] ?? 'https').split(',')[0].trim()
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0].trim()
  return `${proto}://${host}`
}

async function serveFile(res, path) {
  const ext = extname(path).toLowerCase()
  const immutable = path.includes(`${sep}assets${sep}`)
  res.writeHead(200, {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
  })
  createReadStream(path).pipe(res)
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = decodeURIComponent(url.pathname)
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' })
    res.end()
    return
  }

  const profileMatch = /^\/e\/([^/]+)\/?$/.exec(pathname)
  if (profileMatch) {
    const key = profileMatch[1]
    if (KEY_RE.test(key)) {
      try {
        const profile = await profileFor(key)
        if (profile) return sendIndex(res, injectMeta(indexHtml, profileMeta(profile, originOf(req))))
      } catch (e) {
        console.error(JSON.stringify({ event: 'og_inject_error', key, error: e instanceof Error ? e.message : String(e) }))
      }
    }
    return sendIndex(res, indexHtml)
  }

  // Static file, with a guard against path traversal.
  const filePath = normalize(join(ROOT, pathname))
  if (filePath.startsWith(ROOT + sep) && pathname !== '/') {
    try {
      const s = await stat(filePath)
      if (s.isFile()) return serveFile(res, filePath)
    } catch {
      /* not a file: SPA fallback */
    }
    if (pathname.startsWith('/assets/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
  }
  return sendIndex(res, indexHtml)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadIndex()
  createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(JSON.stringify({ event: 'request_error', error: e instanceof Error ? e.message : String(e) }))
      if (!res.headersSent) sendIndex(res, indexHtml)
      else res.end()
    })
  }).listen(PORT, () => console.log(`testmyagent-web listening on port ${PORT} (api ${API_BASE_URL})`))
}

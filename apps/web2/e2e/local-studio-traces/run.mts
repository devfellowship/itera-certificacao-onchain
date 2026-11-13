/**
 * Local browser proof of S2 (/studio/traces) and S3 (/studio/traces/:sessionId) (plan 20261112-tma-c5-studio-area-web2,
 * task C5-T6). NOT a Playwright spec (the prod e2e config matches *.spec.ts only) and it never touches a DFL host.
 *
 * What it runs, all on 127.0.0.1, all synthetic:
 *   1. the REAL `startStudioServer` (services/runner/src/cli/studio/server.ts) over the synthetic fixture of
 *      fixture.test-helpers.ts (`buildFixture`), with an introspect that calls the stub TMA API below;
 *   2. a stub TMA API that LOGS every request (method, path, query, body) and answers GET /auth/me and GET /me for a
 *      token signed by the fixture test key (fakeApi), plus CORS for the web2 origin;
 *   3. a `vite build` of apps/web2 with VITE_TMA_API_URL = the stub API and VITE_TMA_STUDIO_SERVE_URL = the serve,
 *      served by `vite preview`;
 *   4. the three-assertion checker .proof/verify-render.mjs on S2 and S3 with a storageState session for webToken();
 *   5. a check that the stub API log holds no fixture trace text and no session id;
 *   6. negative controls: a token for OTHER (not on the allow-list), and the serve stopped. Both must exit 4.
 *
 * Run from the repo root (Playwright from a temp dir, chromium already installed):
 *   PW_MODULE=/tmp/pw/node_modules/playwright npx tsx apps/web2/e2e/local-studio-traces/run.mts [outDir]
 * Exit 0 only when every step holds. Results: <outDir>/result.json, screenshots, api-requests.json.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startStudioServer } from '../../../../services/runner/src/cli/studio/server.ts'
import { ALLOWED, OTHER, SID_A, SID_B, SID_OUTSIDE, SUB_AGENT, buildFixture, fakeApi, webToken } from '../../../../services/runner/src/cli/studio/fixture.test-helpers.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../../..')
const WEB2 = join(REPO, 'apps/web2')
const OUT = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), 'c5-t6-proof-')))
mkdirSync(OUT, { recursive: true })

/** Every piece of trace content in buildFixture() that S2/S3 show. None may reach the TMA API. */
const TRACE_TEXT = ['Fixture expected state.', 'Fixture outcome.', 'B'.repeat(40), 'fixture step', 'Fixture session', SID_A, SID_B, SID_OUTSIDE, SUB_AGENT]

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const p = (s.address() as AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return p
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()))
const readBody = (req: IncomingMessage) =>
  new Promise<string>((r) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => r(Buffer.concat(chunks).toString('utf8')))
  })

const P1 = await freePort() // studio serve
const P2 = await freePort() // stub TMA API
const P3 = await freePort() // vite preview
const ORIGIN = `http://127.0.0.1:${P3}`
const SERVE = `http://127.0.0.1:${P1}`
const API = `http://127.0.0.1:${P2}`

// --- 2. stub TMA API ---------------------------------------------------------------------------------
type Logged = { method: string; path: string; query: string; body: string; from: 'browser' | 'serve' }
const apiLog: Logged[] = []
const verify = fakeApi()
const api = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', API)
  const body = await readBody(req)
  apiLog.push({ method: req.method ?? '', path: url.pathname, query: url.search, body, from: req.headers['x-proof-caller'] === 'serve' ? 'serve' : 'browser' })
  const cors = { 'access-control-allow-origin': ORIGIN, vary: 'Origin' }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, POST, PATCH, DELETE', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' })
    return res.end()
  }
  const send = (status: number, b: unknown) => {
    res.writeHead(status, { ...cors, 'content-type': 'application/json' })
    res.end(JSON.stringify(b))
  }
  const token = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''
  if (req.method === 'GET' && (url.pathname === '/auth/me' || url.pathname === '/me')) {
    const v = await verify(token)
    if (v.status !== 200 || !v.body) return send(v.status, v.body ?? { error: 'unauthorized' })
    const id = String(v.body.id)
    // /auth/me: the shape the serve's auth.ts reads ({id}) and web2's T.AuthMe ({wallet}). /me: web2's T.Me.
    if (url.pathname === '/auth/me') return send(200, { id, wallet: id, kind: 'dfl' })
    return send(200, { wallet: id, username: null, displayName: 'Fixture User', handle: null, avatarUrl: null, initials: 'FU' })
  }
  return send(404, { error: 'not_found' })
})
await new Promise<void>((r) => api.listen(P2, '127.0.0.1', r))

// --- 1. the real studio serve over the synthetic fixture -----------------------------------------------
const sources = buildFixture()
const serveLog: string[] = []
const introspect = async (token: string) => {
  const r = await fetch(`${API}/auth/me`, { headers: { authorization: `Bearer ${token}`, 'x-proof-caller': 'serve' } })
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null }
}
let serve: Server | null = await startStudioServer(P1, {
  sources,
  auth: { introspect, allowPrincipals: new Set([ALLOWED]) },
  allowOrigins: new Set([ORIGIN]),
  log: (l) => serveLog.push(l),
})

// --- 3. build web2 and preview it ----------------------------------------------------------------------
const dist = mkdtempSync(join(tmpdir(), 'c5-t6-web2-dist-'))
const env = { ...process.env, VITE_TMA_API_URL: API, VITE_TMA_STUDIO_SERVE_URL: SERVE }
const build = spawnSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], { cwd: WEB2, env, encoding: 'utf8' })
if (build.status !== 0) {
  console.error(build.stdout, build.stderr)
  throw new Error('vite build failed')
}
const preview: ChildProcess = spawn('npx', ['vite', 'preview', '--outDir', dist, '--host', '127.0.0.1', '--port', String(P3), '--strictPort'], { cwd: WEB2, env, stdio: 'ignore', detached: true })
for (let i = 0; ; i++) {
  if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) break
  if (i > 100) throw new Error('vite preview did not start')
  await new Promise((r) => setTimeout(r, 100))
}

// --- 4. storageState + verify-render -------------------------------------------------------------------
function storage(file: string, sub: string) {
  const session = { token: webToken(sub), user: { id: sub, email: 'fixture@example.invalid' } }
  writeFileSync(file, JSON.stringify({ cookies: [], origins: [{ origin: ORIGIN, localStorage: [{ name: 'tma2.session', value: JSON.stringify(session) }] }] }))
  return file
}
const okState = storage(join(OUT, 'state-allowed.json'), ALLOWED)
const otherState = storage(join(OUT, 'state-other.json'), OTHER)

/** Async on purpose: the serve and the stub API live in THIS process, so a sync spawn would block them. */
function run(cmd: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const p = spawn(cmd, args, { cwd: REPO, env: process.env })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    p.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    p.on('close', (status) => done({ status, stdout, stderr }))
  })
}

async function verifyRender(name: string, path: string, state: string, controls: string[]) {
  const args = [join(REPO, '.proof/verify-render.mjs'), '--url', `${ORIGIN}${path}`, '--storage-state', state, ...controls, '--json', '--screenshot', join(OUT, `${name}.png`), '--control-timeout', '8000']
  const r = await run(process.execPath, args)
  let json: unknown = null
  try {
    json = JSON.parse(r.stdout)
  } catch {
    json = { raw: r.stdout.slice(0, 4000), stderr: r.stderr.slice(0, 2000) }
  }
  return { name, path, exit: r.status, json }
}

const N_ROWS = 4 // candidates-2026-11-02.jsonl of buildFixture
const M_STEPS = 3 // SID_A: main run 2 spans + subagent 1 span
const results = [
  await verifyRender('s2', '/studio/traces', okState, ['--min-count', `[data-trace-row]=${N_ROWS}`, '--expect-selector', '[data-task-summary]']),
  await verifyRender('s3', `/studio/traces/${SID_A}`, okState, ['--min-count', `[data-trace-step]=${M_STEPS}`, '--expect-selector', '[data-first-failure]', '--expect-selector', '[data-trace-summary]']),
  // 6a. negative control: a valid token for a principal that is not allowed -> the serve answers 403, no rows.
  await verifyRender('neg-other-principal', '/studio/traces', otherState, ['--min-count', `[data-trace-row]=${N_ROWS}`, '--expect-selector', '[data-task-summary]']),
]
// 6b. negative control: the serve is stopped -> network error state, no rows.
await close(serve!)
serve = null
results.push(await verifyRender('neg-serve-stopped', '/studio/traces', okState, ['--min-count', `[data-trace-row]=${N_ROWS}`, '--expect-selector', '[data-task-summary]']))

// --- 5. the TMA API never saw trace content ------------------------------------------------------------
const browserApi = apiLog.filter((l) => l.from === 'browser')
const leaks = apiLog.flatMap((l) => TRACE_TEXT.filter((t) => `${l.path}${l.query}${l.body}`.includes(t)).map((t) => ({ request: `${l.method} ${l.path}${l.query}`, text: t })))
const requestSet = [...new Set(apiLog.map((l) => `${l.from}: ${l.method} ${l.path}${l.query}`))].sort()

preview.pid && process.kill(-preview.pid, 'SIGTERM')
await close(api)

const expect = { s2: 0, s3: 0, 'neg-other-principal': 4, 'neg-serve-stopped': 4 } as Record<string, number>
const pass = results.every((r) => r.exit === expect[r.name]) && leaks.length === 0
const summary = {
  pass,
  ports: { serve: P1, api: P2, web: P3 },
  verify_render: results.map((r) => ({ name: r.name, path: r.path, exit: r.exit, expected_exit: expect[r.name] })),
  api_requests: requestSet,
  api_request_count: apiLog.length,
  trace_text_leaks_to_api: leaks,
  serve_log: serveLog,
}
writeFileSync(join(OUT, 'result.json'), JSON.stringify({ ...summary, verify_render_json: results }, null, 2))
writeFileSync(join(OUT, 'api-requests.json'), JSON.stringify(apiLog, null, 2))
console.log(JSON.stringify(summary, null, 2))
console.log(`out: ${OUT}`)
console.log(`browser requests to the TMA API: ${browserApi.length}`)
process.exit(pass ? 0 : 1)

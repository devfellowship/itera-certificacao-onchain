// @vitest-environment jsdom
/**
 * L14c: the run artifacts page, mounted on its route with a mocked API (no network).
 * Mount + mocked fetch follow src/evaluation.test.tsx.
 * L17: the stored outputs (GET /runs/:id/artifacts + the file hrefs) are mocked in the second block;
 * the L14c block stays as it was: the stub answers 404 on /artifacts, the L14c behaviour.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { SessionProvider } from './auth/session'
import { RunArtifactsPage } from './pages/RunArtifactsPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = { token: 'tma-session-token', user: { id: 'dfl:1', email: 'ana@example.com' } }
const EVAL_ID = '11111111-2222-4333-8444-555555555555'
const RUN_ID = '4ecfe219-6ee3-4729-845f-9d7721ec5a3c'
const AGENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SLUG = 'tsk_html_reports'

const HTML = '<!doctype html>\n<html>\n<head><title>Report</title></head>\n<body><h1>Report</h1><p>KPI 1284</p></body>\n</html>\n'
const JSON_TEXT = '{\n  "filename": "report.html",\n  "content_type": "text/html",\n  "bytes": 14537,\n  "ok": true,\n  "totals": { "runs": 1284, "cost_usd": 41.7, "by_type": [1, 2, 3, 4] }\n}\n'
function added(path: string, text: string): string {
  const lines = text.replace(/\n$/, '').split('\n')
  return [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n') + '\n'
}
const MODIFIED = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n const a = 1\n-const b = 2\n+const b = 3\n'
const PATCH = added('out/report.html', HTML) + added('out/result.json', JSON_TEXT) + MODIFIED

const SHORT_INSTRUCTION = 'Build the HTML report from the CSV. Put it in out/report.html and the totals in out/result.json.'
const LONG_INSTRUCTION = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: ${'build the report '.repeat(5)}`).join('\n')

function runView(over: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    status: 'pass',
    phase: 'done',
    scoreTotal: 100,
    benchmark: { id: 'html-reports', version: '1' },
    agentId: AGENT_ID,
    createdAt: '2026-10-15T03:42:00.000Z',
    completedAt: '2026-10-15T04:21:52.000Z',
    modelCostUsd: 0.068364,
    modelTokens: { in: 249009, out: 3959 },
    score: { parts: { hidden_behavior: 50, public_behavior: 20 }, version: 2, rule: { formula: 'hidden_ratio_x100_gated', hidden: '20/20', gates: { patch_scope: true, agent_finished: true, mcp_state: null } } },
    tests: {
      public: { total: 3, passed: 3, failed: 0, cases: [{ name: 'renders the title', file: 'tests/public/public.test.ts', passed: true }, { name: 'sums the totals', file: 'tests/public/public.test.ts', passed: true }, { name: 'keeps the schema', file: 'tests/public/schema.test.ts', passed: true }] },
      publicBaseline: { total: 3, passed: 1, failed: 2 },
      hidden: { total: 20, passed: 20, failed: 0 },
    },
    patchScope: { changedFiles: ['out/report.html', 'out/result.json', 'src/a.ts'], allowed: true },
    patch: PATCH,
    actionsCount: 19,
    errors: [],
    proof: null,
    result: { state: 'completed', verdict: 'pass', scored: true },
    evidence: { executorProfile: 'docker-v2', environmentDigest: 'sha256:env', contractDigest: 'sha256:contract', limitations: ['no network'] },
    resultOrigin: 'hosted',
    ...over,
  }
}

function evaluationView(over: Record<string, unknown> = {}) {
  return {
    id: EVAL_ID,
    shortId: 'ev_1111',
    slug: null,
    status: 'graded',
    uiState: 'graded',
    paymentKind: 'free_byok',
    resultOrigin: 'hosted',
    createdAt: '2026-10-15T03:40:00.000Z',
    elapsedMs: 2392000,
    agent: { id: AGENT_ID, name: 'opencode-go/deepseek-v4.1-flash', initials: 'OD', repo: 'devfellowship/demo', commit: 'abc1234' },
    model: { id: 'deepseek/deepseek-v4.1-flash', release: null },
    taskCount: 1,
    tasks: [{ runId: RUN_ID, taskId: 't1', name: 'HTML Reports', slug: SLUG, stage: 'graded', status: 'pass', outcome: 'PASS', score: 100, testsPassed: 20, testsTotal: 20, durationMs: 2392000 }],
    stages: [],
    events: [],
    proofs: [],
    isPublic: false,
    shareUrl: null,
    score: 100,
    counts: { pass: 1, fail: 0, invalid: 0 },
    ...over,
  }
}

function taskView(instruction: string) {
  return {
    id: 't1',
    slug: SLUG,
    name: 'HTML Reports',
    description: 'd',
    tags: [],
    curatedByItera: true,
    runnable: true,
    estMinutes: 5,
    price: { usdPerRun: 1, currency: 'USD', paidIn: 'SOL', network: 'devnet' },
    tests: { label: 'sealed', hiddenCount: 20, publicCount: 3 },
    version: { number: 1, latest: 1, isLatest: true, createdAt: '2026-10-01T00:00:00Z', commit: null, repoUrl: null, digest: null, digests: { contract: 'c', environment: 'e', mcpSchema: null, fixture: null, hidden: null, seeds: [] }, history: [] },
    goal: { text: 'g', doneWhen: [] },
    input: { instruction: { text: instruction, truncated: false }, repository: { repo: 'devfellowship/tma-tasks', path: 'tasks/html-reports', commit: 'deadbeef0' }, editablePaths: [], protectedPaths: [] },
    output: { summary: 's', checkedBy: null, separateContainer: true, hiddenCount: 20 },
    tools: [],
    mcp: { servers: [], scorerReads: [], snapshotDigest: null },
    limits: { runTimeoutSec: null, estMinutes: null, costCapUsd: 1, resources: { cpus: null, memoryMb: null, pids: null }, network: 'model-gateway', secrets: [], mcpBootTimeoutSec: null, editablePaths: [], protectedPaths: [] },
    scoring: { parts: [], total: 100 },
    reputation: null,
    results: { runs: 0, leaderboard: [] },
    resultsAll: { runs: 0, leaderboard: [] },
    links: { web: '', api: '' },
  }
}

const action = (seq: number, ok: boolean | null = true) => ({ seq, tool: seq % 2 ? 'bash' : 'read', target: `target-${seq}`, ok, occurredAt: `2026-10-15T03:${String(42 + Math.floor(seq / 60)).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}.000Z` })

let root: Root | undefined
beforeEach(() => {
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(() => {})
})
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

function stubApi(overrides: Record<string, Handler> = {}) {
  const routes: Record<string, Handler> = {
    [`GET /evaluations/${EVAL_ID}`]: () => json(200, evaluationView()),
    [`GET /runs/${RUN_ID}`]: () => json(200, runView()),
    [`GET /runs/${RUN_ID}/actions`]: (url) => {
      const after = Number(url.searchParams.get('after_seq') ?? 0)
      if (after === 0) return json(200, { runId: RUN_ID, afterSeq: 0, actions: Array.from({ length: 10 }, (_, i) => action(i + 1)), hasMore: true, nextAfterSeq: 10 })
      return json(200, { runId: RUN_ID, afterSeq: after, actions: Array.from({ length: 9 }, (_, i) => action(11 + i, i === 3 ? false : true)), hasMore: false, nextAfterSeq: 19 })
    },
    [`GET /public/tasks/${SLUG}`]: () => json(200, taskView(SHORT_INSTRUCTION)),
    ...overrides,
  }
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    const key = `${init.method ?? 'GET'} ${url.pathname}`
    const handler = routes[key]
    if (!handler) return json(404, { error: `no mock for ${key}` })
    return handler(url, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const probe = { pathname: '', search: '' }
function LocationProbe() {
  const l = useLocation()
  probe.pathname = l.pathname
  probe.search = l.search
  return null
}

function mountAt(path: string) {
  saveSession(SESSION)
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          <Route
            element={
              <SessionProvider>
                <Outlet />
              </SessionProvider>
            }
          >
            <Route path="/evaluations/:eid/runs/:runId" element={<RunArtifactsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    ),
  )
  return c
}

const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const qa = (c: HTMLElement, id: string) => Array.from(c.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`))
async function waitFor(check: () => boolean, label: string, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}
const tabs = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>('[data-testid="run-tabs"] [role="tab"]'))
const tabText = (c: HTMLElement) => tabs(c).map((t) => t.textContent)
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const PAGE = `/evaluations/${EVAL_ID}/runs/${RUN_ID}`

describe('run artifacts page', () => {
  it('shows the 5 tabs with counts, the title from the evaluation, and opens on Artifacts with the HTML preview and the JSON tree', async () => {
    stubApi()
    const c = mountAt(PAGE)
    await waitFor(() => q(c, 'run-tabs') !== null, 'tabs')
    // Artifacts = run.json + patch.diff + 2 added + 1 modified = 5. Tests = 3 public cases + 20 hidden. Log = actionsCount.
    expect(tabText(c)).toEqual(['Summary', 'Artifacts5', 'Tests23', 'Log19', 'Patch'])
    expect(q(c, 'run-tabs')!.getAttribute('data-tab')).toBe('artifacts')
    expect(q(c, 'run-title')!.textContent).toContain('opencode-go/deepseek-v4.1-flash')
    expect(q(c, 'run-subtitle')!.textContent).toContain('pass · HTML Reports · 100 · hidden tests 20/20 · 39:52')
    expect(c.querySelector('.tma-breadcrumb')!.textContent).toContain('ev_1111')
    expect(q(c, 'self-declared-chip')).toBeNull()

    const wide = q(c, 'artifact-wide')!
    expect(wide.getAttribute('data-kind')).toBe('html')
    expect(q(wide, 'artifact-title')!.textContent).toBe(`out/report.html · ${(HTML.length / 1024).toFixed(1)} KB`)
    const frame = wide.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy')
    expect(wide.textContent).toContain('sandbox · out/report.html')

    const narrow = q(c, 'artifact-narrow')!
    expect(narrow.getAttribute('data-kind')).toBe('json')
    expect(q(narrow, 'artifact-title')!.textContent).toContain('out/result.json ·')
    expect(narrow.querySelector('[data-testid="json-tree"]')).not.toBeNull()
    expect(narrow.textContent).toContain('object · 5 keys')
    expect(narrow.textContent).toContain('"report.html"')
    expect(narrow.textContent).toContain('by_type')
    // The other artifacts follow as collapsible cards.
    const rest = qa(q(c, 'artifact-list')!, 'artifact-card')
    expect(rest.map((r) => r.getAttribute('data-path'))).toEqual(['run.json', 'patch.diff', 'src/a.ts'])
    expect(q(c, 'artifacts-empty')).toBeNull()
    // Download: run-{short}.json and run-{short}.diff, client side.
    expect(q(c, 'download-json')!.getAttribute('download')).toBe('run-4ecfe219.json')
    expect(q(c, 'download-diff')!.getAttribute('download')).toBe('run-4ecfe219.diff')
    expect(q(c, 'download-json')!.getAttribute('href')!.startsWith('data:application/json')).toBe(true)
  })

  it('?tab=log shows the tool lines of both pages, with a red mark on ok=false', async () => {
    const fetchMock = stubApi()
    const c = mountAt(`${PAGE}?tab=log`)
    await waitFor(() => qa(c, 'log-line').length === 19, '19 log lines')
    const lines = qa(c, 'log-line')
    expect(lines[0]!.textContent).toContain('#1')
    expect(lines[0]!.textContent).toContain('bash')
    expect(lines[0]!.textContent).toContain('target-1')
    expect(lines[0]!.textContent).toContain('00:01')
    expect(lines[18]!.getAttribute('data-seq')).toBe('19')
    expect(lines.filter((l) => l.classList.contains('ra-log__line--bad')).map((l) => l.getAttribute('data-seq'))).toEqual(['14'])
    expect(q(c, 'log-load-more')).toBeNull()
    const actionCalls = fetchMock.mock.calls.map((x) => String(x[0])).filter((u) => u.includes('/actions'))
    expect(actionCalls).toHaveLength(2)
    expect(actionCalls[1]).toContain('after_seq=10')
  })

  it('?tab=patch shows the diff with the changed files and the scope', async () => {
    stubApi()
    const c = mountAt(`${PAGE}?tab=patch`)
    await waitFor(() => q(c, 'patch-diff') !== null, 'patch diff')
    const files = qa(c, 'diff-file').map((f) => f.getAttribute('data-path'))
    expect(files).toEqual(['out/report.html', 'out/result.json', 'src/a.ts'])
    expect(q(c, 'patch-diff')!.querySelector('.ra-diff__l--del .ra-code__t')!.textContent).toBe('const b = 2')
    expect(q(c, 'changed-files')!.textContent).toContain('src/a.ts')
    expect(q(c, 'patch-scope')!.textContent).toContain('allowed')
  })

  it('?tab=tests shows the public cases, the baseline vs after-patch counts and one square per hidden check', async () => {
    stubApi()
    const c = mountAt(`${PAGE}?tab=tests`)
    await waitFor(() => qa(c, 'public-case').length === 3, 'public cases')
    expect(q(c, 'tests-public')!.textContent).toContain('after patch 3/3')
    expect(q(c, 'tests-public')!.textContent).toContain('baseline 1/3')
    expect(q(c, 'hidden-count')!.textContent).toBe('20/20')
    expect(qa(c, 'hidden-square')).toHaveLength(20)
    expect(qa(c, 'hidden-square').every((s) => s.getAttribute('data-passed') === 'true')).toBe(true)
  })

  it('Summary shows the instruction inline when short', async () => {
    stubApi()
    const c = mountAt(`${PAGE}?tab=summary`)
    await waitFor(() => q(c, 'input-text') !== null, 'input text')
    expect(q(c, 'input-text')!.textContent).toBe(SHORT_INSTRUCTION)
    expect(q(c, 'input-text')!.getAttribute('data-long')).toBe('false')
    expect(q(c, 'input-full-link')).toBeNull()
    expect(q(c, 'input-link')!.getAttribute('href')).toBe(`/tasks/${SLUG}?tab=input`)
    expect(q(c, 'summary-score-value')!.textContent).toBe('100')
    expect(c.querySelector('[data-testid="score-bar"]')!.getAttribute('aria-label')).toContain('pass line 100')
    expect(q(c, 'summary-facts')!.textContent).toContain('$0.0684')
    expect(q(c, 'summary-facts')!.textContent).toContain('249,009 / 3,959')
    expect(q(c, 'summary-parts')!.textContent).toContain('patch_scope')
    expect(q(c, 'summary-evidence')!.textContent).toContain('sha256:env')
    expect(q(c, 'summary-limitations')!.textContent).toContain('no network')
    expect(q(c, 'input-repo')!.textContent).toContain('devfellowship/tma-tasks')
  })

  it('Summary shows the first 3 lines and the link when the instruction is long', async () => {
    stubApi({ [`GET /public/tasks/${SLUG}`]: () => json(200, taskView(LONG_INSTRUCTION)) })
    const c = mountAt(`${PAGE}?tab=summary`)
    await waitFor(() => q(c, 'input-text') !== null, 'input text')
    expect(q(c, 'input-text')!.getAttribute('data-long')).toBe('true')
    expect(q(c, 'input-text')!.textContent).toContain('Line 3:')
    expect(q(c, 'input-text')!.textContent).not.toContain('Line 4:')
    expect(q(c, 'input-full-link')!.getAttribute('href')).toBe(`/tasks/${SLUG}?tab=input`)
  })

  it('a private task (404) leaves only the link to the task input', async () => {
    stubApi({ [`GET /public/tasks/${SLUG}`]: () => json(404, { error: 'not found' }) })
    const c = mountAt(`${PAGE}?tab=summary`)
    await waitFor(() => q(c, 'input-private') !== null, 'private note')
    expect(q(c, 'input-text')).toBeNull()
    expect(q(c, 'input-link')!.getAttribute('href')).toBe(`/tasks/${SLUG}?tab=input`)
  })

  it('a non-owner run (patch null, evaluation 404) shows a generic title, the owner-only note and No files stored', async () => {
    stubApi({
      [`GET /evaluations/${EVAL_ID}`]: () => json(404, { error: 'not found' }),
      [`GET /runs/${RUN_ID}`]: () => json(200, runView({ patch: null, errors: [], evidence: null, patchScope: { changedFiles: [], allowed: true } })),
    })
    const c = mountAt(PAGE)
    await waitFor(() => q(c, 'run-tabs') !== null, 'tabs')
    expect(q(c, 'run-artifacts-page')!.getAttribute('data-owner')).toBe('false')
    expect(q(c, 'run-title')!.textContent).toContain('Run 4ecfe219')
    expect(tabText(c)).toEqual(['Summary', 'Artifacts1', 'Tests23', 'Log19', 'Patch'])
    // No rich file → the default tab is Summary.
    expect(q(c, 'run-tabs')!.getAttribute('data-tab')).toBe('summary')
    click(tabs(c)[1])
    expect(probe.search).toBe('?tab=artifacts')
    expect(q(c, 'artifacts-empty')!.textContent).toContain('No files stored')
    expect(q(c, 'artifacts-empty')!.textContent).toContain('visible to the run owner only')
    expect(q(c, 'artifact-narrow')!.getAttribute('data-path')).toBe('run.json')
    expect(q(c, 'download-diff')).toBeNull()
    click(tabs(c)[4])
    expect(q(c, 'patch-owner-only')!.textContent).toContain('The patch is visible to the run owner only.')
  })

  it('a self-declared run shows the chip and the note', async () => {
    stubApi({
      [`GET /evaluations/${EVAL_ID}`]: () => json(200, evaluationView({ resultOrigin: 'self_declared', paymentKind: 'none' })),
      [`GET /runs/${RUN_ID}`]: () => json(200, runView({ patch: null, tests: null, resultOrigin: 'self_declared', actionsCount: 0, evidence: null, patchScope: null })),
      [`GET /runs/${RUN_ID}/actions`]: () => json(200, { runId: RUN_ID, afterSeq: 0, actions: [], hasMore: false, nextAfterSeq: 0 }),
    })
    const c = mountAt(PAGE)
    await waitFor(() => q(c, 'run-tabs') !== null, 'tabs')
    expect(q(c, 'self-declared-chip')!.textContent).toBe('self-declared')
    expect(q(c, 'run-tabs')!.getAttribute('data-tab')).toBe('summary')
    expect(q(c, 'self-declared-note')!.textContent).toBe('TestMyAgent did not run this. It stores numbers only.')
    click(tabs(c)[1])
    expect(q(c, 'artifacts-empty')!.textContent).toContain('self-declared run stores numbers only')
  })

  it('a missing run shows the error state', async () => {
    stubApi({ [`GET /runs/${RUN_ID}`]: () => json(404, { error: 'run not found' }) })
    const c = mountAt(PAGE)
    await waitFor(() => q(c, 'run-error') !== null, 'run error')
    expect(q(c, 'run-error')!.textContent).toContain('Run not found')
  })
})

/* ---------- L17: stored outputs ---------- */

/** The stored report differs from the patch's: the page must show the STORED bytes, not the rebuilt text. */
const STORED_HTML = '<!doctype html>\n<html>\n<head><title>Report</title></head>\n<body><h1>Report</h1><p>KPI 1284</p><p>stored-marker-7f3a</p></body>\n</html>\n'
const RESULT_JSON = '{"verdict":"pass","filename":"report.html","totals":{"runs":1284},"stored":true}'
const TRACE_TEXT = '{"type":"tool.call","part":{"tool":"bash"}}\n{"type":"message.part","part":{"text":"done"}}\n{"truncated":true,"reason":"maxFileBytes"}\n'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const fileHref = (path: string) => `/runs/${RUN_ID}/artifacts/file?path=${encodeURIComponent(path)}`
type StoredEntry = { path: string; contentType: string; kind: 'json' | 'markdown' | 'html' | 'text' | 'image' | 'diff'; encoding: 'utf-8' | 'base64'; bytes: number; sha256: string; href: string }
const entry = (path: string, contentType: string, kind: StoredEntry['kind'], bytes: number, encoding: StoredEntry['encoding'] = 'utf-8'): StoredEntry => ({ path, contentType, kind, encoding, bytes, sha256: 'ab'.repeat(32), href: fileHref(path) })
const STORED_LIST = [entry('patch.diff', 'text/x-diff', 'diff', PATCH.length), entry('result.json', 'application/json', 'json', RESULT_JSON.length), entry('agent/trace.jsonl', 'application/x-ndjson', 'text', TRACE_TEXT.length), entry('files/out/report.html', 'text/html', 'html', STORED_HTML.length), entry('files/out/chart.png', 'image/png', 'image', PNG.length, 'base64')]
const FILES: Record<string, { body: string | Uint8Array; type: string }> = {
  'patch.diff': { body: PATCH, type: 'text/x-diff' },
  'result.json': { body: RESULT_JSON, type: 'application/json' },
  'agent/trace.jsonl': { body: TRACE_TEXT, type: 'application/x-ndjson' },
  'files/out/report.html': { body: STORED_HTML, type: 'text/html' },
  'files/out/chart.png': { body: PNG, type: 'image/png' },
}
function storedView(artifacts: StoredEntry[] = STORED_LIST, reason: null | 'self_declared' | 'none_stored' = null) {
  return { runId: RUN_ID, resultOrigin: 'hosted', limits: { maxFileBytes: 524288, maxRunBytes: 2097152, maxCount: 25 }, reason, artifacts }
}
/** The file endpoint: 401 without the bearer, 404 for an unknown path, else the raw bytes as an attachment. */
const fileRoute =
  (fail: Record<string, number> = {}): Handler =>
  (url, init) => {
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization
    if (auth !== `Bearer ${SESSION.token}`) return json(401, { error: 'unauthorized' })
    const path = url.searchParams.get('path') ?? ''
    if (fail[path]) return json(fail[path]!, { error: 'boom' })
    const f = FILES[path]
    if (!f) return json(404, { error: 'run not found' })
    return new Response(f.body as BodyInit, { status: 200, headers: { 'Content-Type': f.type, 'Content-Disposition': `attachment; filename="${path.split('/').pop()}"` } })
  }
function stubStored(list = STORED_LIST, reason: null | 'self_declared' | 'none_stored' = null, fail: Record<string, number> = {}) {
  return stubApi({ [`GET /runs/${RUN_ID}/artifacts`]: () => json(200, storedView(list, reason)), [`GET /runs/${RUN_ID}/artifacts/file`]: fileRoute(fail) })
}
/** jsdom has no object URLs. Adds the two methods to the real URL (never replaces the constructor: the fetch mock calls `new URL`). */
function stubObjectUrl(value: string) {
  const u = URL as unknown as Record<string, unknown>
  u.createObjectURL = vi.fn((_b: Blob) => value)
  u.revokeObjectURL = vi.fn()
}
afterEach(() => {
  const u = URL as unknown as Record<string, unknown>
  delete u.createObjectURL
  delete u.revokeObjectURL
})
const cardsOf = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>('[data-testid="tab-artifacts"] .ra-card'))
const loadOf = (el: HTMLElement) => el.getAttribute('data-load')

describe('run artifacts page: stored outputs (L17)', () => {
  it('merges the stored outputs: count 8, the stored HTML preview and the result.json tree render from the fetched bytes with the bearer header', async () => {
    const fetchMock = stubStored()
    const c = mountAt(PAGE)
    await waitFor(() => q(c, 'run-tabs') !== null, 'tabs')
    // Merged: result.json, files/out/report.html, files/out/chart.png, patch.diff, agent/trace.jsonl (stored) + run.json, added:out/result.json, modified:src/a.ts.
    expect(tabText(c)).toEqual(['Summary', 'Artifacts8', 'Tests23', 'Log19', 'Patch'])
    expect(q(c, 'run-tabs')!.getAttribute('data-tab')).toBe('artifacts')
    expect(q(c, 'tab-artifacts')!.getAttribute('data-stored-count')).toBe('5')
    expect(q(c, 'artifacts-none-stored')).toBeNull()
    expect(q(c, 'artifacts-empty')).toBeNull()

    const wide = q(c, 'artifact-wide')!
    expect(wide.getAttribute('data-source')).toBe('stored')
    expect(wide.getAttribute('data-kind')).toBe('html')
    expect(q(wide, 'artifact-title')!.textContent).toBe(`out/report.html · ${(STORED_HTML.length / 1024).toFixed(1)} KB`)
    await waitFor(() => loadOf(wide) === 'ok', 'stored html loaded')
    const frame = wide.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy')
    expect(frame.getAttribute('srcdoc')).toContain('stored-marker-7f3a')
    expect(frame.getAttribute('src')).toBeNull()
    // The Diff view of the replaced patch file stays reachable on the stored card.
    expect(Array.from(wide.querySelectorAll('.tma-segmented__btn')).map((b) => b.textContent)).toEqual(['Preview', 'Source', 'Diff'])

    const narrow = q(c, 'artifact-narrow')!
    expect(narrow.getAttribute('data-source')).toBe('stored')
    expect(narrow.getAttribute('data-path')).toBe('result.json')
    await waitFor(() => loadOf(narrow) === 'ok', 'stored result.json loaded')
    expect(narrow.querySelector('[data-testid="json-tree"]')).not.toBeNull()
    expect(narrow.textContent).toContain('object · 4 keys')
    expect(narrow.textContent).toContain('"pass"')
    expect(q(narrow, 'artifact-download')!.getAttribute('data-filename')).toBe('result.json')
    expect(q(narrow, 'artifact-download')!.hasAttribute('disabled')).toBe(false)

    const rest = qa(q(c, 'artifact-list')!, 'artifact-card')
    expect(rest.map((r) => r.getAttribute('data-path'))).toEqual(['out/chart.png', 'patch.diff', 'agent/trace.jsonl', 'run.json', 'out/result.json', 'src/a.ts'])
    expect(rest.map((r) => r.getAttribute('data-source'))).toEqual(['stored', 'stored', 'stored', 'run', 'added', 'modified'])
    // A collapsed stored card has not loaded yet: only the two open cards fetched their bytes. The stored patch.diff needs no load (its diff is at hand).
    expect(rest.filter((r) => r.getAttribute('data-source') === 'stored').map(loadOf)).toEqual(['idle', 'ok', 'idle'])
    const fileCalls = fetchMock.mock.calls.filter((x) => String(x[0]).includes('/artifacts/file'))
    expect(fileCalls.map((x) => new URL(String(x[0])).searchParams.get('path')).sort()).toEqual(['files/out/report.html', 'result.json'])
    for (const call of fileCalls) expect((call[1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${SESSION.token}` })
    expect(fetchMock.mock.calls.some((x) => String(x[0]).endsWith(`/runs/${RUN_ID}/artifacts`))).toBe(true)
  })

  it('the PNG card shows an <img> with a blob: src when opened, and the trace card shows the list view', async () => {
    stubObjectUrl('blob:http://localhost/chart-1')
    const fetchMock = stubStored()
    const c = mountAt(PAGE)
    await waitFor(() => q(c, 'run-tabs') !== null, 'tabs')
    const png = cardsOf(c).find((x) => x.getAttribute('data-path') === 'out/chart.png')!
    expect(loadOf(png)).toBe('idle')
    click(q(png, 'artifact-toggle'))
    await waitFor(() => loadOf(png) === 'ok', 'png loaded')
    const img = png.querySelector('[data-testid="image-view"] img')!
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('blob:http://localhost/chart-1')
    expect(img.getAttribute('alt')).toBe('out/chart.png')
    expect(q(png, 'artifact-title')!.textContent).toBe('out/chart.png · 0.0 KB')
    expect(png.querySelectorAll('a[href^="blob:"]')).toHaveLength(0)
    const trace = cardsOf(c).find((x) => x.getAttribute('data-path') === 'agent/trace.jsonl')!
    expect(trace.getAttribute('data-kind')).toBe('ndjson')
    click(q(trace, 'artifact-toggle'))
    await waitFor(() => loadOf(trace) === 'ok', 'trace loaded')
    const rows = qa(trace, 'trace-row')
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['ok', 'ok', 'truncated'])
    expect(rows[0]!.textContent).toContain('tool.call · bash')
    // The stored patch.diff renders its diff without a fetch (the derived text is reused), and its Download is enabled.
    const patch = cardsOf(c).find((x) => x.getAttribute('data-path') === 'patch.diff')!
    click(q(patch, 'artifact-toggle'))
    expect(loadOf(patch)).toBe('ok')
    expect(qa(patch, 'diff-file').map((f) => f.getAttribute('data-path'))).toEqual(['out/report.html', 'out/result.json', 'src/a.ts'])
    expect(q(patch, 'artifact-download')!.hasAttribute('disabled')).toBe(false)
    expect(q(patch, 'artifact-download')!.getAttribute('data-filename')).toBe('patch.diff')
    expect((fetchMock.mock.calls as unknown[][]).some((x) => String(x[0]).includes('path=patch.diff'))).toBe(false)
  })

  it('a 404 on /runs/:id/artifacts keeps the L14c list: count 5, the derived HTML preview, no stored card', async () => {
    const fetchMock = stubApi({ [`GET /runs/${RUN_ID}/artifacts`]: () => json(404, { error: 'run not found' }) })
    const c = mountAt(PAGE)
    await waitFor(() => q(c, 'run-tabs') !== null, 'tabs')
    expect(tabText(c)).toEqual(['Summary', 'Artifacts5', 'Tests23', 'Log19', 'Patch'])
    expect(q(c, 'tab-artifacts')!.getAttribute('data-stored-count')).toBe('0')
    expect(q(c, 'artifact-wide')!.getAttribute('data-source')).toBe('added')
    expect(q(c, 'artifact-wide')!.querySelector('iframe')!.getAttribute('srcdoc')).not.toContain('stored-marker')
    expect(cardsOf(c).every((x) => x.getAttribute('data-source') !== 'stored')).toBe(true)
    expect(q(c, 'artifacts-none-stored')).toBeNull()
    expect(fetchMock.mock.calls.some((x) => String(x[0]).includes('/artifacts/file'))).toBe(false)
  })

  it('reason none_stored shows the note and keeps the derived patch files under it', async () => {
    stubStored([], 'none_stored')
    const c = mountAt(PAGE)
    await waitFor(() => q(c, 'run-tabs') !== null, 'tabs')
    expect(tabText(c)[1]).toBe('Artifacts5')
    expect(q(c, 'artifacts-none-stored')!.textContent).toBe('No output files stored for this run. Runs before 2026-10-27 have only the patch.')
    expect(q(c, 'artifacts-empty')).toBeNull()
    expect(q(c, 'artifact-wide')!.getAttribute('data-path')).toBe('out/report.html')
  })

  it('reason self_declared with an empty list keeps the self-declared note', async () => {
    stubApi({
      [`GET /evaluations/${EVAL_ID}`]: () => json(200, evaluationView({ resultOrigin: 'self_declared', paymentKind: 'none' })),
      [`GET /runs/${RUN_ID}`]: () => json(200, runView({ patch: null, tests: null, resultOrigin: 'self_declared', actionsCount: 0, evidence: null, patchScope: null })),
      [`GET /runs/${RUN_ID}/actions`]: () => json(200, { runId: RUN_ID, afterSeq: 0, actions: [], hasMore: false, nextAfterSeq: 0 }),
      [`GET /runs/${RUN_ID}/artifacts`]: () => json(200, { ...storedView([], 'self_declared'), resultOrigin: 'self_declared' }),
    })
    const c = mountAt(PAGE)
    await waitFor(() => q(c, 'run-tabs') !== null, 'tabs')
    expect(tabText(c)[1]).toBe('Artifacts1')
    expect(q(c, 'run-tabs')!.getAttribute('data-tab')).toBe('summary')
    click(tabs(c)[1])
    expect(q(c, 'artifacts-empty')!.textContent).toContain('self-declared run stores numbers only')
    expect(q(c, 'artifacts-none-stored')).toBeNull()
  })

  it('a file href that answers 500 shows the error in that card; the page and the other cards stay', async () => {
    stubStored(STORED_LIST, null, { 'files/out/report.html': 500 })
    const c = mountAt(PAGE)
    await waitFor(() => q(c, 'run-tabs') !== null, 'tabs')
    const wide = q(c, 'artifact-wide')!
    await waitFor(() => loadOf(wide) === 'error', 'wide card error')
    const err = q(wide, 'artifact-error')!
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toContain('HTTP 500')
    expect(err.textContent).toContain('boom')
    expect(wide.querySelector('iframe')).toBeNull()
    expect(q(wide, 'artifact-download')!.hasAttribute('disabled')).toBe(true)
    const narrow = q(c, 'artifact-narrow')!
    await waitFor(() => loadOf(narrow) === 'ok', 'narrow ok')
    expect(narrow.querySelector('[data-testid="json-tree"]')).not.toBeNull()
    expect(q(c, 'run-artifacts-page')).not.toBeNull()
    expect(tabText(c)[1]).toBe('Artifacts8')
    expect(q(c, 'run-error')).toBeNull()
  })

  it('a 401 on a file href signs the session out (the same handler as request)', async () => {
    stubApi({
      [`GET /runs/${RUN_ID}/artifacts`]: () => json(200, storedView([entry('result.json', 'application/json', 'json', 10)])),
      [`GET /runs/${RUN_ID}/artifacts/file`]: () => json(401, { error: 'unauthorized' }),
    })
    const c = mountAt(PAGE)
    await waitFor(() => q(c, 'run-tabs') !== null, 'tabs')
    const narrow = q(c, 'artifact-narrow')!
    expect(narrow.getAttribute('data-path')).toBe('result.json')
    await waitFor(() => localStorage.getItem('tma2.session') === null, 'signed out')
    expect(localStorage.getItem('tma2.session')).toBeNull()
  })
})

// @vitest-environment jsdom
/**
 * L14c: the run artifacts page, mounted on its route with a mocked API (no network).
 * Mount + mocked fetch follow src/evaluation.test.tsx.
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

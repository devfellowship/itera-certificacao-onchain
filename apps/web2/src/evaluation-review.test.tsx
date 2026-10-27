// @vitest-environment jsdom
/**
 * L14b: the review layout of a terminal evaluation — score header (score, 90% CI, verdict, bar),
 * item navigator (?item=, prev/next, ← →), the Expected-vs-agent table and the Artifacts card.
 * Mocked fetch; nothing touches the network.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { SessionProvider } from './auth/session'
import { RunningEvaluationPage } from './pages/RunningEvaluationPage'
import { compareRows, inputPreview, mostLost, patchStats, sourceOf, subtitleOf, verdictOf } from './pages/running-evaluation/review'
import { wilson90 } from './tma/detail'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = { token: 'tma-session-token', user: { id: 'dfl:1', email: 'ana@example.com' } }
const EVAL_ID = '11111111-2222-4333-8444-555555555555'
const AGENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const T1 = 'tttttttt-0000-4000-8000-000000000001'
const T2 = 'tttttttt-0000-4000-8000-000000000002'

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
async function waitFor(check: () => boolean, label: string, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}; body: ${document.body.innerHTML.slice(0, 1500)}`)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

// ---------- fixtures ----------
const PATCH_1 = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '+line one', '+line two', '-old line', 'diff --git a/src/b.ts b/src/b.ts', '--- a/src/b.ts', '+++ b/src/b.ts', '+added'].join('\n')

function gates(over: Record<string, boolean | null> = {}) {
  return { hidden_measured: true, patch_nonempty: true, patch_scope: true, mcp_state: null, agent_finished: true, ...over }
}

/** One PASS run: 5/5 hidden, 3 public cases, patch inside scope. */
const RUN_1 = {
  runId: 'r1', status: 'pass', phase: 'done', scoreTotal: 100, durationMs: 90_000, modelCostUsd: 0.12, actionsCount: 42, completedAt: '2026-10-15T10:05:00.000Z',
  score: { parts: { hidden_behavior: 100 }, version: 2, rule: { formula: 'hidden_ratio_x100_gated', hidden: '5/5', gates: gates() } },
  tests: {
    public: { total: 3, passed: 3, failed: 0, cases: [{ name: 'creates the event', file: 'events.test.ts', passed: true }, { name: 'rejects a duplicate', file: 'events.test.ts', passed: true }, { name: 'keeps the order', file: 'events.test.ts', passed: true }] },
    publicBaseline: { total: 3, passed: 3, failed: 0 },
    hidden: { total: 5, passed: 5, failed: 0 },
  },
  patchScope: { changedFiles: ['src/a.ts', 'src/b.ts'], allowed: true },
  patch: PATCH_1,
  result: { state: 'finished', verdict: 'PASS', scored: true },
  evidence: { executorProfile: 'sandbox-container', environmentDigest: 'sha256:env', contractDigest: 'sha256:contract', limitations: [] },
  errors: [], proof: null, resultOrigin: 'hosted',
}
/** One FAIL run: 3/5 hidden, one public case fails, patch outside scope (the gate zeroes the score). */
const RUN_2 = {
  runId: 'r2', status: 'fail', phase: 'done', scoreTotal: 0, durationMs: 120_000, modelCostUsd: 0.4, actionsCount: 77, completedAt: '2026-10-15T10:07:00.000Z',
  score: { parts: { hidden_behavior: 60 }, version: 2, rule: { formula: 'hidden_ratio_x100_gated', hidden: '3/5', gates: gates({ patch_scope: false }) } },
  tests: {
    public: { total: 3, passed: 2, failed: 1, cases: [{ name: 'creates the event', file: 'events.test.ts', passed: true }, { name: 'rejects a duplicate', file: 'events.test.ts', passed: false }, { name: 'keeps the order', file: 'events.test.ts', passed: true }] },
    publicBaseline: { total: 3, passed: 3, failed: 0 },
    hidden: { total: 5, passed: 3, failed: 2 },
  },
  patchScope: { changedFiles: ['src/x.ts'], allowed: false },
  patch: 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n+one\n',
  result: { state: 'finished', verdict: 'FAIL', scored: true },
  evidence: null, errors: [], proof: null, resultOrigin: 'hosted',
}

type Over = { status?: string; events?: Array<{ tMs: number; tone: string; label: string; detail: string | null }>; paymentKind?: string; resultOrigin?: string; tasks?: unknown[]; counts?: Record<string, number>; score?: number | null; testsPassed?: number; testsTotal?: number }
function evaluationView(over: Over = {}) {
  const status = over.status ?? 'graded'
  const terminal = status === 'graded'
  const tasks = over.tasks ?? [
    { runId: 'r1', slotRunId: 'r1', seq: 1, attempts: 1, taskId: T1, name: 'Fix the bug', slug: 'fix-the-bug', stage: terminal ? 'graded' : 'grading', status: terminal ? 'pass' : 'running', phase: terminal ? 'done' : 'grading', outcome: terminal ? 'PASS' : null, score: terminal ? 100 : null, testsPassed: terminal ? 5 : null, testsTotal: terminal ? 5 : null, durationMs: 90_000 },
    { runId: 'r2', slotRunId: 'r2', seq: 2, attempts: 1, taskId: T2, name: 'Add feature', slug: 'add-feature', stage: terminal ? 'graded' : 'awaiting_artifact', status: terminal ? 'fail' : 'running', phase: terminal ? 'done' : 'agent_running', outcome: terminal ? 'FAIL' : null, score: terminal ? 0 : null, testsPassed: terminal ? 3 : null, testsTotal: terminal ? 5 : null, durationMs: 120_000 },
  ]
  return {
    id: EVAL_ID, shortId: '8d9e905a', slug: null, status, uiState: terminal ? 'graded' : 'running',
    paymentKind: over.paymentKind ?? 'free_byok', resultOrigin: over.resultOrigin ?? 'hosted',
    createdAt: '2026-10-15T10:00:00.000Z', elapsedMs: 420_000,
    agent: { id: AGENT_ID, name: 'codex-agent', initials: 'CA', repo: 'devfellowship/codex-agent', commit: 'abc1234', authorWallet: null },
    model: { id: 'openai/gpt-5-mini', release: null },
    taskCount: tasks.length, tasks,
    stages: [{ key: 'contract', state: 'done', detail: null }, { key: 'agent_calls', state: terminal ? 'done' : 'active', detail: null }, { key: 'grading', state: terminal ? 'done' : 'wait', detail: null }],
    events: over.events ?? [{ tMs: 0, tone: 'ok', label: 'Evaluation queued', detail: '2 runs · free · your model key' }],
    proofs: [], isPublic: false, shareUrl: null,
    score: over.score !== undefined ? over.score : terminal ? 50 : null,
    counts: over.counts ?? (terminal ? { pass: 1, fail: 1, invalid: 0, review: 0, cancelled: 0, queued: 0, running: 0 } : { pass: 0, fail: 0, invalid: 0, review: 0, cancelled: 0, queued: 0, running: 2 }),
    testsPassed: over.testsPassed ?? (terminal ? 8 : 0), testsTotal: over.testsTotal ?? (terminal ? 10 : 0),
  }
}

function taskProfile(slug: string, instruction: string) {
  return {
    id: T1, slug, name: 'Fix the bug', description: 'A bug fix task.', tags: [], curatedByItera: true, runnable: true, estMinutes: 5,
    price: { usdPerRun: 0, currency: 'USD', paidIn: 'SOL', network: 'devnet' },
    tests: { label: 'sealed', hiddenCount: 5, publicCount: 3 },
    version: { number: 1, latest: 1, isLatest: true, createdAt: '2026-10-01T00:00:00.000Z', commit: null, repoUrl: null, digest: null, digests: { contract: 'c', environment: 'e', mcpSchema: null, fixture: null, hidden: null, seeds: [] }, history: [] },
    goal: { text: 'Fix it', doneWhen: [] },
    input: { instruction: { text: instruction, truncated: false }, repository: { repo: null, path: null, commit: null }, editablePaths: ['src/'], protectedPaths: ['tests/'] },
    output: { summary: 'A patch', checkedBy: null, separateContainer: true, hiddenCount: 5 },
    tools: [], mcp: { servers: [], scorerReads: [], snapshotDigest: null },
    limits: { runTimeoutSec: 600, estMinutes: 5, costCapUsd: 1, resources: { cpus: null, memoryMb: null, pids: null }, network: 'model-gateway', secrets: [], mcpBootTimeoutSec: null, editablePaths: ['src/'], protectedPaths: ['tests/'] },
    scoring: { parts: [{ key: 'hidden_behavior', label: 'Hidden', points: 100, description: '' }], gates: ['hidden_measured', 'patch_nonempty', 'patch_scope', 'mcp_state', 'agent_finished'], version: 2, total: 100 },
    resultsAll: { runs: 0 }, results: { runs: 0 },
  }
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>
function stubApi(overrides: Record<string, Handler> = {}) {
  const routes: Record<string, Handler> = {
    'GET /tasks': () => json(200, { tasks: [] }),
    'GET /models': () => json(200, { default: 'openai/gpt-5-mini', models: [{ id: 'openai/gpt-5-mini', label: 'GPT-5 mini' }] }),
    [`GET /evaluations/${EVAL_ID}`]: () => json(200, evaluationView()),
    'GET /runs/r1': () => json(200, RUN_1),
    'GET /runs/r2': () => json(200, RUN_2),
    'GET /runs/r1/actions': () => json(200, { runId: 'r1', afterSeq: 0, actions: [], hasMore: false, nextAfterSeq: 0 }),
    'GET /runs/r2/actions': () => json(200, { runId: 'r2', afterSeq: 0, actions: [], hasMore: false, nextAfterSeq: 0 }),
    'GET /public/tasks/fix-the-bug': () => json(200, taskProfile('fix-the-bug', 'Fix the duplicate insert in POST /events.')),
    // add-feature is a private task: 404.
    ...overrides,
  }
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    const handler = routes[`${init.method ?? 'GET'} ${url.pathname}`]
    if (!handler) return json(404, { error: `no mock for ${url.pathname}` })
    return handler(input, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const probe = { search: '' }
function LocationProbe() {
  probe.search = useLocation().search
  return null
}
/**
 * pollMs is 10 ms so a terminal evaluation renders at once. A non-terminal one never stops polling, so its test passes
 * a long interval: a 10 ms poll loop (each tick also reads every active run) starved the act() flushes on CI runners
 * and timed the test out at 5 s (main 23edb42, 2026-10-27).
 */
function mountAt(path: string, pollMs = 10) {
  saveSession(SESSION)
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          <Route element={<SessionProvider><Outlet /></SessionProvider>}>
            <Route path="/evaluations/:eid" element={<RunningEvaluationPage pollMs={pollMs} />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    ),
  )
  return c
}
const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const qa = (c: HTMLElement, id: string) => Array.from(c.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`))
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const key = (k: string) => act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
const rowsOf = (c: HTMLElement) => Object.fromEntries(qa(c, 'compare-row').map((r) => [r.dataset.field!, { verdict: r.dataset.verdict, text: r.textContent! }]))
/** Mounts a graded evaluation and waits for the table; with item 1 current, also for the task-profile rows (item 2 is a private task). */
async function mountReady(path = `/evaluations/${EVAL_ID}`) {
  stubApi()
  const c = mountAt(path)
  await waitFor(() => q(c, 'compare-table') !== null, 'the compare table')
  if (!path.includes('item=')) await waitFor(() => qa(c, 'compare-row').some((r) => r.dataset.field === 'time'), 'the task profile rows')
  return c
}

describe('review helpers', () => {
  it('sourceOf: self-declared, imported, run here', () => {
    expect(sourceOf({ resultOrigin: 'self_declared', events: [] })).toBe('self-declared')
    expect(sourceOf({ paymentKind: 'none', events: [] })).toBe('self-declared')
    expect(sourceOf({ events: [{ tMs: 0, tone: 'ok', label: 'Historical evaluation imported', detail: null }] })).toBe('imported')
    expect(sourceOf({ events: [{ tMs: 0, tone: 'ok', label: 'Evaluation queued', detail: null }] })).toBe('run here')
  })
  it('verdictOf: any FAIL fails; all PASS passes; else invalid', () => {
    expect(verdictOf({ pass: 2, fail: 0, invalid: 0 })).toBe('pass')
    expect(verdictOf({ pass: 1, fail: 1, invalid: 0 })).toBe('fail')
    expect(verdictOf({ pass: 0, fail: 0, invalid: 1 })).toBe('invalid')
    expect(verdictOf({ pass: 0, fail: 0, invalid: 0 })).toBeNull()
  })
  it('patchStats counts files, + and − lines (headers excluded); falls back to diff headers', () => {
    expect(patchStats(PATCH_1, ['src/a.ts', 'src/b.ts'])).toEqual({ files: 2, added: 3, removed: 1 })
    expect(patchStats(PATCH_1, [])).toEqual({ files: 2, added: 3, removed: 1 })
    expect(patchStats(null, [])).toEqual({ files: 0, added: 0, removed: 0 })
  })
  it('inputPreview: inline up to 600 characters, else the first line and a link', () => {
    expect(inputPreview('short')).toEqual({ text: 'short', truncated: false })
    const long = `First line of the instruction.\n${'x'.repeat(700)}`
    expect(inputPreview(long)).toEqual({ text: 'First line of the instruction.', truncated: true })
    expect(inputPreview(null)).toBeNull()
  })
  it('compareRows folds more than 10 public cases into one row until showAllPublic', () => {
    const cases = Array.from({ length: 12 }, (_, i) => ({ name: `case ${i + 1}`, file: 'f.ts', passed: i !== 3 }))
    const run = { ...RUN_1, tests: { ...RUN_1.tests, public: { total: 12, passed: 11, failed: 1, cases } } }
    const folded = compareRows({ run: run as never, taskScore: 100, durationMs: 1000, profile: null })
    expect(folded.publicCollapsed).toBe(12)
    expect(folded.rows.filter((r) => r.field.startsWith('public')).map((r) => [r.field, r.agent, r.verdict])).toEqual([['public tests', '11/12', 'close']])
    const all = compareRows({ run: run as never, taskScore: 100, durationMs: 1000, profile: null, showAllPublic: true })
    expect(all.publicCollapsed).toBe(0)
    expect(all.rows.filter((r) => r.field.startsWith('public:'))).toHaveLength(12)
    expect(all.rows.find((r) => r.field === 'public: case 4')!.verdict).toBe('wrong')
    // No profile: no time and no cost row.
    expect(all.rows.map((r) => r.field)).not.toContain('time')
    expect(all.rows.map((r) => r.field)).not.toContain('cost')
  })
  it('mostLost names the broken gate over the partial hidden suite', () => {
    const { rows } = compareRows({ run: RUN_2 as never, taskScore: 0, durationMs: 120_000, profile: null })
    expect(rows.find((r) => r.field === 'hidden checks')!.lost).toBe(40)
    expect(mostLost(rows)!.field).toBe('patch scope')
    expect(mostLost(compareRows({ run: RUN_1 as never, taskScore: 100, durationMs: 1, profile: null }).rows)).toBeNull()
  })
  it('subtitleOf: task names · source · score version · short id', () => {
    const d = evaluationView()
    expect(subtitleOf(d as never, RUN_1 as never)).toBe('Fix the bug, Add feature · run here · score v2 · ev_8d9e905a')
    expect(subtitleOf({ ...d, resultOrigin: 'self_declared' } as never, null)).toBe('Fix the bug, Add feature · self-declared · ev_8d9e905a')
  })
})

describe('evaluation review layout', () => {
  it('score header: the big score, the 90% CI from wilson90 and n, the verdict and the score bar', async () => {
    const c = await mountReady()
    expect(q(c, 'review-score')!.textContent).toBe('50')
    const ci = wilson90(8, 10)!
    expect(q(c, 'review-ci')!.textContent).toBe(`90% CI ${ci.lo}–${ci.hi} · n 10`)
    expect(q(c, 'review-verdict')!.dataset.verdict).toBe('fail')
    expect(q(c, 'review-verdict')!.textContent).toContain('fail')
    expect(q(c, 'review-verdict')!.textContent).toContain('50 below 100')
    expect(q(c, 'review-score-bar')!.getAttribute('aria-label')).toBe(`score 50, 90% CI ${ci.lo}–${ci.hi}, pass line 100`)
    expect(q(c, 'review-items-label')!.textContent).toBe('items · 1 passed')
    // The title is the agent; the subtitle names the tasks, the source and the score version.
    expect(q(c, 'evaluation-title')!.textContent).toBe('codex-agent')
    expect(q(c, 'evaluation-meta')!.textContent).toBe('Fix the bug, Add feature · run here · score v2 · ev_8d9e905a')
    expect(q(c, 'view-agent')!.getAttribute('href')).toBe(`/agents/${AGENT_ID}`)
    expect(q(c, 'rerun')!.getAttribute('href')).toBe(`/agents/${AGENT_ID}/evaluate`)
    // The live pieces are still on the page: the Tasks card, and the stage tracker + event log under a collapsed "Event log".
    expect(qa(c, 'run-row')).toHaveLength(2)
    expect(q(c, 'score-total')!.textContent).toBe('50')
    const live = q(c, 'live-details') as HTMLDetailsElement
    expect(live.open).toBe(false)
    expect(live.querySelector('summary')!.textContent).toBe('Event log')
    expect(live.querySelector('[data-testid="stage-tracker"]')).not.toBeNull()
    expect(live.querySelector('[data-testid="event-log"]')).not.toBeNull()
    expect(q(c, 'artifacts-results')).not.toBeNull()
    expect(q(c, 'cancel-evaluation')).toBeNull()
  })

  it('the verdict names the row with the most lost points of the current item (?item=2 → patch scope)', async () => {
    const c = await mountReady(`/evaluations/${EVAL_ID}?item=2`)
    expect(q(c, 'review-most-lost')!.textContent).toBe('patch scope')
    expect(q(c, 'review-verdict')!.textContent).toContain('Most points lost on patch scope')
    expect(q(c, 'compare-item')!.textContent).toBe('item Add feature · 0/100')
    // Item 1 lost nothing: no "most lost" fragment.
    click(q(c, 'item-prev'))
    await waitFor(() => q(c, 'compare-item')!.textContent === 'item Fix the bug · 100/100', 'item 1')
    expect(q(c, 'review-most-lost')).toBeNull()
  })

  it('navigator: 2 squares, the current outlined, ?item= selects it, next/prev and ← → move it', async () => {
    const c = await mountReady()
    const squares = () => qa(c, 'item-square')
    expect(squares()).toHaveLength(2)
    expect(squares().map((s) => s.dataset.tone)).toEqual(['pass', 'fail'])
    expect(squares().map((s) => s.dataset.current)).toEqual(['true', 'false'])
    expect(squares()[0]!.classList.contains('ev-nav__sq--current')).toBe(true)
    expect(squares()[0]!.getAttribute('aria-selected')).toBe('true')
    expect(q(c, 'compare-card')!.dataset.runId).toBe('r1')
    expect((q(c, 'item-prev') as HTMLButtonElement).disabled).toBe(true)
    expect(q(c, 'item-next')!.textContent).toContain('add-feature')

    click(q(c, 'item-next'))
    await waitFor(() => q(c, 'compare-card')!.dataset.runId === 'r2', 'item 2 by next')
    expect(probe.search).toBe('?item=2')
    expect(squares().map((s) => s.dataset.current)).toEqual(['false', 'true'])
    expect((q(c, 'item-next') as HTMLButtonElement).disabled).toBe(true)
    expect(q(c, 'item-prev')!.textContent).toContain('fix-the-bug')

    key('ArrowLeft')
    await waitFor(() => q(c, 'compare-card')!.dataset.runId === 'r1', 'item 1 by ←')
    expect(probe.search).toBe('?item=1')
    key('ArrowRight')
    await waitFor(() => q(c, 'compare-card')!.dataset.runId === 'r2', 'item 2 by →')
    key('ArrowRight') // no next: stays
    expect(q(c, 'compare-card')!.dataset.runId).toBe('r2')

    click(squares()[0])
    await waitFor(() => q(c, 'compare-card')!.dataset.runId === 'r1', 'item 1 by square')
    expect(probe.search).toBe('?item=1')
  })

  it('an unknown ?item= falls back to the first item', async () => {
    const c = await mountReady(`/evaluations/${EVAL_ID}?item=9`)
    expect(q(c, 'compare-card')!.dataset.runId).toBe('r1')
  })

  it('table rows of the PASS run: verdict words and points; the raw input inline', async () => {
    const c = await mountReady()
    expect(q(c, 'compare-item')!.textContent).toBe('item Fix the bug · 100/100')
    const rows = rowsOf(c)
    expect(Object.keys(rows)).toEqual(['hidden checks', 'public: creates the event', 'public: rejects a duplicate', 'public: keeps the order', 'no regression', 'patch scope', 'patch', 'time', 'cost', 'gate · hidden_measured', 'gate · mcp_state', 'gate · agent_finished'])
    expect(rows['hidden checks']).toMatchObject({ verdict: 'correct' })
    expect(rows['hidden checks']!.text).toContain('5/5 pass')
    expect(rows['hidden checks']!.text).toContain('100/100')
    expect(rows['public: creates the event']!.text).toContain('pass')
    expect(rows['public: creates the event']!.text).toContain('—')
    expect(rows['no regression']!.text).toContain('≥ 3 public pass (baseline)')
    expect(rows['no regression']!.text).toContain('3 after the patch')
    expect(rows['patch scope']!.text).toContain('only src/')
    expect(rows['patch scope']!.text).toContain('inside scope')
    expect(rows['patch']!.text).toContain('2 files changed')
    expect(rows['time']!.text).toContain('≤ 600s')
    expect(rows['time']!.text).toContain('1m 30s')
    expect(rows['cost']!.text).toContain('≤ US$1')
    expect(rows['cost']!.text).toContain('US$0.120')
    expect(rows['gate · mcp_state']).toMatchObject({ verdict: 'missing' })
    expect(rows['gate · mcp_state']!.text).toContain('not applicable')
    for (const f of ['public: creates the event', 'no regression', 'patch scope', 'patch', 'time', 'cost', 'gate · hidden_measured', 'gate · agent_finished']) expect(rows[f]!.verdict).toBe('correct')
    const verdictCell = c.querySelector('[data-testid="compare-row"][data-field="hidden checks"] .ev-table__verdict')!
    expect(verdictCell.textContent!.replace(/\s+/g, ' ').trim()).toBe('✓ correct')
    expect(verdictCell.classList.contains('ev-verdict--correct')).toBe(true)
    // Raw input at hand: short → inline, no link.
    expect(q(c, 'review-input')!.textContent).toContain('Fix the duplicate insert in POST /events.')
    expect(q(c, 'review-input')!.dataset.truncated).toBe('false')
    expect(q(c, 'review-input-link')).toBeNull()
  })

  it('table rows of the FAIL run: close / wrong / missing, 0 points, and no time or cost rows for a private task', async () => {
    const c = await mountReady(`/evaluations/${EVAL_ID}?item=2`)
    const rows = rowsOf(c)
    expect(rows['hidden checks']).toMatchObject({ verdict: 'close' })
    expect(rows['hidden checks']!.text).toContain('3/5')
    expect(rows['hidden checks']!.text).toContain('0/100')
    expect(rows['public: rejects a duplicate']).toMatchObject({ verdict: 'wrong' })
    expect(rows['public: rejects a duplicate']!.text).toContain('fail')
    expect(rows['no regression']).toMatchObject({ verdict: 'wrong' })
    expect(rows['patch scope']).toMatchObject({ verdict: 'wrong' })
    expect(rows['patch scope']!.text).toContain('outside scope')
    expect(rows['patch scope']!.text).toContain('inside the editable paths')
    expect(rows['patch scope']!.text).toContain('0/100')
    expect(rows['patch']!.text).toContain('1 file changed')
    expect(rows['gate · mcp_state']).toMatchObject({ verdict: 'missing' })
    expect(rows['time']).toBeUndefined()
    expect(rows['cost']).toBeUndefined()
    const wrong = c.querySelector('[data-testid="compare-row"][data-field="patch scope"] .ev-table__verdict')!
    expect(wrong.textContent!.replace(/\s+/g, ' ').trim()).toBe('● wrong')
    expect(wrong.classList.contains('ev-verdict--wrong')).toBe(true)
    const missing = c.querySelector('[data-testid="compare-row"][data-field="gate · mcp_state"] .ev-table__verdict')!
    expect(missing.textContent!.replace(/\s+/g, ' ').trim()).toBe('– missing')
    // No profile (404): no input line.
    expect(q(c, 'review-input')).toBeNull()
  })

  it('a long instruction shows its first line and a link to the full input', async () => {
    stubApi({ 'GET /public/tasks/fix-the-bug': () => json(200, taskProfile('fix-the-bug', `Fix POST /events.\n${'detail '.repeat(120)}`)) })
    const c = mountAt(`/evaluations/${EVAL_ID}`)
    await waitFor(() => q(c, 'review-input') !== null, 'input line')
    expect(q(c, 'review-input')!.dataset.truncated).toBe('true')
    expect(q(c, 'review-input')!.textContent).toContain('Fix POST /events.')
    expect(q(c, 'review-input')!.textContent).not.toContain('detail detail')
    expect(q(c, 'review-input-link')!.getAttribute('href')).toBe('/tasks/fix-the-bug?tab=input')
  })

  it('Fields | JSON shows the run record as a JSON tree; "Grader report" opens it too', async () => {
    const c = await mountReady()
    expect(q(c, 'compare-json')).toBeNull()
    click(Array.from(c.querySelectorAll('.tma-segmented__btn')).find((b) => b.textContent === 'JSON')!)
    await waitFor(() => q(c, 'compare-json') !== null, 'json view')
    expect(q(c, 'compare-table')).toBeNull()
    expect(q(c, 'compare-json')!.textContent).toContain('runId')
    click(Array.from(c.querySelectorAll('.tma-segmented__btn')).find((b) => b.textContent === 'Fields')!)
    await waitFor(() => q(c, 'compare-table') !== null, 'fields view')
    click(q(c, 'grader-report'))
    await waitFor(() => q(c, 'compare-json') !== null, 'json via grader report')
  })

  it('more than 10 public cases fold into one row with "Show all"', async () => {
    const cases = Array.from({ length: 12 }, (_, i) => ({ name: `case ${i + 1}`, file: 'f.ts', passed: true }))
    stubApi({ 'GET /runs/r1': () => json(200, { ...RUN_1, tests: { ...RUN_1.tests, public: { total: 12, passed: 12, failed: 0, cases } } }) })
    const c = mountAt(`/evaluations/${EVAL_ID}`)
    await waitFor(() => q(c, 'public-show-all') !== null, 'show all')
    expect(rowsOf(c)['public tests']!.text).toContain('12/12')
    expect(qa(c, 'compare-row').filter((r) => r.dataset.field!.startsWith('public:'))).toHaveLength(0)
    click(q(c, 'public-show-all'))
    await waitFor(() => qa(c, 'compare-row').filter((r) => r.dataset.field!.startsWith('public:')).length === 12, 'all cases')
    expect(q(c, 'public-show-all')).toBeNull()
  })

  it('artifacts card of a hosted run: patch summary, counts and the link to the run artifacts page', async () => {
    const c = await mountReady()
    expect(q(c, 'artifacts-card')!.dataset.state).toBe('files')
    expect(q(c, 'artifacts-patch')!.textContent).toBe('patch.diff · 2 files · +3 −1')
    expect(q(c, 'artifacts-counts')!.textContent).toBe('tests 8 · tool calls 42')
    expect(q(c, 'open-artifacts')!.getAttribute('href')).toBe(`/evaluations/${EVAL_ID}/runs/r1`)
    expect(q(c, 'artifacts-empty')).toBeNull()
    click(q(c, 'item-next'))
    await waitFor(() => q(c, 'open-artifacts')?.getAttribute('href') === `/evaluations/${EVAL_ID}/runs/r2`, 'run 2 link')
    expect(q(c, 'artifacts-patch')!.textContent).toBe('patch.diff · 1 file · +1 −0')
  })

  it('artifacts card of a self-declared evaluation: "No files stored", numbers only; no Re-run', async () => {
    const selfRun = { runId: 'r1', status: 'fail', phase: 'done', scoreTotal: 60, tests: null, patchScope: null, patch: null, actionsCount: 0, errors: [], proof: null, result: { state: 'finished', verdict: 'FAIL', scored: true }, resultOrigin: 'self_declared', score: { parts: null, version: 2 } }
    stubApi({
      [`GET /evaluations/${EVAL_ID}`]: () => json(200, evaluationView({ paymentKind: 'none', resultOrigin: 'self_declared', score: 60, testsPassed: 0, testsTotal: 0, counts: { pass: 0, fail: 1, invalid: 0 }, events: [{ tMs: 0, tone: 'ok', label: 'Self-declared result imported', detail: null }], tasks: [{ runId: 'r1', slotRunId: 'r1', seq: 1, attempts: 1, taskId: T1, name: 'Fix the bug', slug: 'fix-the-bug', stage: 'graded', status: 'fail', phase: 'done', outcome: 'FAIL', score: 60, testsPassed: null, testsTotal: null, durationMs: null }] })),
      'GET /runs/r1': () => json(200, selfRun),
    })
    const c = mountAt(`/evaluations/${EVAL_ID}`)
    await waitFor(() => q(c, 'artifacts-empty') !== null, 'empty artifacts')
    expect(q(c, 'evaluation-review')!.dataset.source).toBe('self-declared')
    expect(q(c, 'artifacts-empty')!.textContent).toContain('No files stored')
    expect(q(c, 'artifacts-empty')!.textContent).toContain('Self-declared run: TestMyAgent stores numbers only.')
    expect(q(c, 'open-artifacts')).toBeNull()
    expect(q(c, 'rerun')).toBeNull()
    expect(q(c, 'review-ci')!.textContent).toBe('n 0 · no CI')
    expect(q(c, 'review-score')!.textContent).toBe('60')
    // The hidden row is "missing" (no graded suite); the score still shows its points.
    expect(rowsOf(c)['hidden checks']).toMatchObject({ verdict: 'missing' })
    expect(rowsOf(c)['hidden checks']!.text).toContain('60/100')
  })

  it('artifacts card of a historical (imported) evaluation: "No files stored", legacy note; no Re-run', async () => {
    const legacyRun = { runId: 'r1', status: 'pass', phase: 'done', scoreTotal: 100, tests: { public: { total: 2, passed: 2 }, publicBaseline: { total: 2, passed: 2 }, hidden: { total: 4, passed: 4 } }, patchScope: { changedFiles: [], allowed: true }, patch: null, actionsCount: 0, errors: [], proof: null, result: { state: 'finished', verdict: 'PASS', scored: true }, score: { parts: null, version: 1 } }
    stubApi({
      [`GET /evaluations/${EVAL_ID}`]: () => json(200, evaluationView({ score: 100, testsPassed: 4, testsTotal: 4, counts: { pass: 1, fail: 0, invalid: 0 }, events: [{ tMs: 0, tone: 'ok', label: 'Historical evaluation imported', detail: '1 run · original result · no new run' }], tasks: [{ runId: 'r1', slotRunId: 'r1', seq: 1, attempts: 1, taskId: T1, name: 'Fix the bug', slug: 'fix-the-bug', stage: 'graded', status: 'pass', phase: 'done', outcome: 'PASS', score: 100, testsPassed: 4, testsTotal: 4, durationMs: null }] })),
      'GET /runs/r1': () => json(200, legacyRun),
    })
    const c = mountAt(`/evaluations/${EVAL_ID}`)
    await waitFor(() => q(c, 'artifacts-empty') !== null, 'empty artifacts')
    expect(q(c, 'evaluation-review')!.dataset.source).toBe('imported')
    expect(q(c, 'artifacts-empty')!.textContent).toContain('Imported legacy run. Only the score and the grader result were kept.')
    expect(q(c, 'rerun')).toBeNull()
    expect(q(c, 'review-verdict')!.dataset.verdict).toBe('pass')
    expect(q(c, 'review-verdict')!.textContent).not.toContain('below')
    expect(q(c, 'evaluation-meta')!.textContent).toBe('Fix the bug · imported · score v1 · ev_8d9e905a')
  })

  it('a non-terminal evaluation keeps the live layout and no review layout', async () => {
    stubApi({ [`GET /evaluations/${EVAL_ID}`]: () => json(200, evaluationView({ status: 'in_progress' })) })
    const c = mountAt(`/evaluations/${EVAL_ID}`, 60_000)
    await waitFor(() => q(c, 'evaluation-status') !== null, 'status')
    expect(q(c, 'evaluation-status')!.dataset.status).toBe('in_progress')
    expect(q(c, 'evaluation-review')).toBeNull()
    expect(q(c, 'live-details')).toBeNull()
    expect(q(c, 'stage-tracker')).not.toBeNull()
    expect(q(c, 'event-log')).not.toBeNull()
    expect(qa(c, 'run-row')).toHaveLength(2)
    expect(q(c, 'cancel-evaluation')).not.toBeNull()
    expect(q(c, 'rerun')).toBeNull()
    expect(q(c, 'evaluation-title')!.textContent).toBe('Evaluation')
    expect(q(c, 'evaluation-meta')!.textContent).toContain('ev_8d9e905a · codex-agent abc1234 · 2 tasks')
  })
})

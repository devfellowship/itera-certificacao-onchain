// @vitest-environment jsdom
/** L14a: the public task page with tabs. Every fetch is mocked; no network. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionProvider } from './auth/session'
import type { PublicEvaluation, RunActionsResponse, TaskProfile } from './lib/api/types'
import { TaskProfilePage } from './pages/TaskProfilePage'
import { clearEvaluationCache } from './pages/task-profile/evaluation-cache'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  clearEvaluationCache()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
// Two macrotasks: the task fetch, then the lazy evaluation and actions fetches that follow it.
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
const click = (el: Element | null | undefined) => act(() => el!.dispatchEvent(new MouseEvent('click', { bubbles: true })))

function mount(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(node))
  return container
}

const INSTRUCTION = 'Fix POST /events. Verify the HMAC-SHA256 signature over the raw request body.\nProcess each event ID at most once.\n  Keep the indentation.'

const board = [
  { rank: 1, agentName: 'Demo agent', agentSlug: 'demo-8eed', ownerWallet: 'W1', ownerProfile: { wallet: 'W1', username: 'tainan', displayName: null, avatarUrl: null }, agentAvatarUrl: null, modelLabel: 'Claude Haiku 4.5', score: 100, outcome: 'PASS' as const, date: '2026-10-15T03:53:31.892Z', evaluationSlug: 'demo-8eed-d9e2' },
  { rank: 2, agentName: 'Other agent', agentSlug: 'other-1111', ownerWallet: null, modelLabel: null, score: 60, outcome: 'FAIL' as const, date: '2026-10-14T03:53:31.892Z', evaluationSlug: 'other-1111-aaaa' },
]
const results = { agentsEvaluated: 2, runs: 2, passRate: 0.5, medianScore: 80, medianDurationMs: 60000, outcomes: { pass: 1, fail: 1, invalid: 0 }, leaderboard: board }

const task: TaskProfile = {
  id: 'task-1',
  slug: 'x',
  name: 'Duplicate settlement webhook',
  description: 'Make the settlement webhook safe to deliver twice.',
  tags: [{ id: 'backend', name: 'Backend', kind: 'concept' }],
  curatedByItera: true,
  runnable: true,
  estMinutes: 8,
  price: { usdPerRun: 0, currency: 'USD', paidIn: 'SOL', network: 'devnet' },
  tests: { label: 'sealed', hiddenCount: 5, publicCount: 3 },
  version: {
    number: 1, latest: 1, isLatest: true, createdAt: '2026-10-12T10:00:00.000Z', commit: 'abc123', repoUrl: 'https://github.com/devfellowship/itera-certificacao-onchain', digest: 'sha-digest-0000',
    digests: { contract: 'c'.repeat(64), environment: 'e'.repeat(64), mcpSchema: null, fixture: null, hidden: null, seeds: [] },
    history: [{ version: 1, createdAt: '2026-10-12T10:00:00.000Z', changed: [] }],
  },
  goal: { text: 'Make the settlement webhook safe to deliver twice.', doneWhen: ['A delivery with a wrong signature is rejected.', 'A second delivery of the same event id changes nothing.'] },
  input: { instruction: { text: INSTRUCTION, truncated: false }, repository: { repo: 'devfellowship/itera-certificacao-onchain', path: 'benchmarks/webhook-ledger/environment', commit: null }, editablePaths: ['src/**'], protectedPaths: ['tests/**', 'package.json'] },
  output: { summary: 'A patch to the editable paths.', checkedBy: 'npx vitest run --reporter=json', separateContainer: true, hiddenCount: 5 },
  tools: [{ id: 'read', name: 'read', description: 'Read a file', allowed: true }, { id: 'web', name: 'webfetch', description: 'Fetch a URL', allowed: false }],
  mcp: { servers: [], scorerReads: [], snapshotDigest: null },
  limits: { runTimeoutSec: 600, estMinutes: 8, costCapUsd: 0.5, resources: { cpus: 2, memoryMb: 2048, pids: null }, network: 'model-gateway', secrets: [], mcpBootTimeoutSec: null, editablePaths: ['src/**'], protectedPaths: ['tests/**'] },
  scoring: { parts: [{ key: 'hidden_behavior', label: 'Hidden', points: 100, description: 'Share of the hidden checks that pass, × 100.' }], gates: ['The patch is not empty.', 'The patch touches only the editable paths.'], version: 2, total: 100 },
  reputation: { distinctWallets: 3, runs: 3, feedbackCount: 0, feedbackYesRate: null, weight: 1, curatedByItera: true },
  results,
  resultsAll: { ...results, runs: 3, outcomes: { pass: 1, fail: 2, invalid: 0 } },
  links: { web: 'https://testmyagent.dev/tasks/x', api: 'https://api/public/tasks/x' },
}

const evaluation = (slug: string, passed: number, total: number, runId: string): PublicEvaluation =>
  ({
    slug, hash: 'h', issuedAt: null, agent: { name: 'Demo agent', slug: 'demo-8eed', initials: 'DA', authorName: 'tainan', modelLabel: 'Claude Haiku 4.5', commit: 'abc', description: '' },
    tags: [], score: 100, counts: { pass: 1, fail: 0, invalid: 0 }, testsPassed: passed, testsTotal: total,
    tasks: [{ name: task.name, slug: 'x', description: '', tags: [], outcome: passed === total ? 'PASS' : 'FAIL', testResults: [], testsPassed: passed, testsTotal: total, durationMs: 1000, runId }],
    record: { network: 'devnet', status: 'Pending', issuedAt: null, proofs: [] }, disclaimer: '',
  }) as PublicEvaluation

const actions: RunActionsResponse = {
  runId: 'run-1', afterSeq: 0, hasMore: false, nextAfterSeq: 3,
  actions: [
    { seq: 1, tool: 'read', target: 'src/app.ts', ok: true, occurredAt: '2026-10-15T03:52:12.893Z' },
    { seq: 2, tool: 'bash', target: 'npm test', ok: false, occurredAt: '2026-10-15T03:52:13.893Z' },
    { seq: 3, tool: 'todowrite', target: null, ok: true, occurredAt: '2026-10-15T03:52:14.893Z' },
  ],
}

function stubFetch() {
  const fetchMock = vi.fn(async (input: string) => {
    const path = new URL(input).pathname
    if (path === '/public/tasks/x') return json(200, task)
    if (path === '/public/evaluations/demo-8eed-d9e2') return json(200, evaluation('demo-8eed-d9e2', 5, 5, 'run-1'))
    if (path === '/public/evaluations/other-1111-aaaa') return json(200, evaluation('other-1111-aaaa', 3, 5, 'run-2'))
    if (path === '/runs/run-1/actions') return json(200, actions)
    return json(404, { error: 'not found' })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function mountPage(url: string) {
  return mount(
    <MemoryRouter initialEntries={[url]}>
      <SessionProvider>
        <Routes>
          <Route path="/tasks/:slug" element={<TaskProfilePage />} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  )
}
const tabs = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[data-testid="task-tabs"] [role="tab"]')]
const tabByLabel = (c: HTMLElement, label: string) => tabs(c).find((t) => t.textContent?.startsWith(label))
const segButton = (c: HTMLElement, label: string) => [...c.querySelectorAll<HTMLElement>('.tma-segmented__btn')].find((b) => b.textContent === label)

it('shows the five tabs with the real counts, the chat view, the raw text and the runs table with CI bands', async () => {
  const fetchMock = stubFetch()
  const c = mountPage('/tasks/x')
  await flush()
  expect(c.querySelector('[data-testid="task-profile"]')).not.toBeNull()
  // Tabs: Input (instruction + repository = 2), Runs (resultsAll.runs = 3); no count on the others.
  expect(tabs(c).map((t) => t.textContent)).toEqual(['Overview', 'Input2', 'Expected output', 'Rubric', 'Runs3'])
  expect(c.querySelector('[data-testid="task-tabs"]')!.getAttribute('data-tab')).toBe('overview')
  expect(c.querySelector('[data-testid="task-subtitle"]')!.textContent).toBe('x@v1 · 5 hidden checks · score v2 · pass = all hidden checks · 3 runs')
  expect(c.querySelector('[data-testid="task-visibility-chip"]')!.textContent).toBe('CATALOG')

  // Chat view: m1 = the instruction; the tool calls of the top run; the grader note with the evidence bar.
  await flush()
  const chat = c.querySelector('[data-testid="chat-view"]')!
  const msgs = [...chat.querySelectorAll('[data-testid="chat-msg"]')]
  expect(msgs[0]!.getAttribute('data-role')).toBe('user')
  expect(msgs[0]!.textContent).toContain('m1')
  expect(msgs[0]!.textContent).toContain('Fix POST /events.')
  expect(msgs[1]!.getAttribute('data-role')).toBe('agent')
  expect(msgs[1]!.textContent).toContain('Demo agent')
  expect(msgs[1]!.textContent).toContain('3 tool calls')
  const tools = [...chat.querySelectorAll('[data-testid="chat-tool"]')]
  expect(tools.map((t) => t.textContent)).toEqual(['read src/app.ts', 'bash npm test', 'todowrite'])
  expect(tools[1]!.className).toContain('dt-chat__tool--bad')
  const grader = msgs[msgs.length - 1]!
  expect(grader.getAttribute('data-role')).toBe('grader')
  expect(grader.className).toContain('dt-chat__msg--evidence')
  expect(grader.textContent).toContain('evidence')
  expect(grader.textContent).toContain('A second delivery of the same event id changes nothing.')
  expect(c.querySelector('[data-testid="overview-input"]')!.textContent).toContain('instruction · 6 messages')

  // Raw: the exact text, with a Copy button.
  click(segButton(c, 'Raw'))
  expect(c.querySelector('[data-testid="input-raw"]')!.textContent).toBe(INSTRUCTION)
  expect(c.querySelector('[data-testid="overview-input"]')!.textContent).toContain('Copy')
  expect(c.querySelector('[data-testid="input-full-link"]')).toBeNull()

  // Expected output: the field table, then the JSON tree.
  const fieldRows = [...c.querySelectorAll('[data-testid="overview-expected"] [data-testid="field-row"]')]
  expect(fieldRows.map((r) => r.querySelector('.dt-fields__f')!.textContent)).toEqual(['patch', 'hidden checks', 'public tests', 'gate', 'gate'])
  expect(fieldRows[1]!.textContent).toContain('tests ×5')
  expect(fieldRows[1]!.textContent).toContain('npx vitest run --reporter=json')
  expect(fieldRows[1]!.querySelector('.dt-fields__w')!.textContent).toBe('100')
  expect(fieldRows[2]!.querySelector('.dt-fields__w')!.textContent).toBe('0')
  click(segButton(c, 'JSON'))
  expect(c.querySelector('[data-testid="overview-expected"] [data-testid="json-tree"]')!.textContent).toContain('object · 3 keys')

  // Runs table: one row per leaderboard entry; the CI band appears after the per-run fetch.
  expect(c.querySelector('[data-testid="runs-summary"]')!.textContent).toBe('1 of 2 passed · best 100')
  const rows = [...c.querySelectorAll('[data-testid="runs-table-row"]')]
  expect(rows).toHaveLength(board.length)
  const bars = rows.map((r) => r.querySelector('[data-testid="score-bar"]')!)
  expect(bars[0]!.getAttribute('aria-label')).toBe('score 100, 90% CI 64.9–100, pass line 100')
  expect(bars[0]!.querySelector('[data-testid="score-bar-band"]')).not.toBeNull()
  expect(bars[1]!.getAttribute('aria-label')).toBe('score 60, 90% CI 27.2–85.7, pass line 100')
  expect(rows.map((r) => r.querySelector('[data-testid="run-score"]')!.textContent)).toEqual(['100 ±17.5', '60 ±29.3']) // (100−64.9)/2 = 17.55 → 17.5 in float; (85.7−27.2)/2 = 29.25 → 29.3
  expect(rows.map((r) => r.querySelector('[data-testid="run-checks"]')!.textContent)).toEqual(['5/5', '3/5'])
  expect(rows.map((r) => r.querySelector('[data-testid="result-dot"]')!.textContent)).toEqual(['pass', 'fail'])
  expect(rows.map((r) => r.querySelector('[data-testid="run-source"]')!.textContent)).toEqual(['run here', 'run here'])
  expect(rows[0]!.querySelector('[data-testid="run-link"]')!.getAttribute('href')).toBe('/e/demo-8eed-d9e2')
  // The evaluation of the top run is read once: the chat and the runs table share the cache.
  const evalCalls = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname).filter((p) => p.startsWith('/public/evaluations/'))
  expect(evalCalls.sort()).toEqual(['/public/evaluations/demo-8eed-d9e2', '/public/evaluations/other-1111-aaaa'])
  // The old sections of the overview.
  expect(c.querySelector('[data-testid="section-goal"]')).not.toBeNull()
  expect(c.querySelector('[data-testid="section-inject"]')).not.toBeNull()
  expect(c.querySelector('[data-testid="rail-card"]')).not.toBeNull()
})

it('opens the Runs tab from ?tab=runs and shows the results section there', async () => {
  stubFetch()
  const c = mountPage('/tasks/x?tab=runs')
  await flush()
  expect(c.querySelector('[data-testid="task-tabs"]')!.getAttribute('data-tab')).toBe('runs')
  expect(c.querySelector('[data-testid="tab-runs"]')).not.toBeNull()
  expect(c.querySelector('[data-testid="tab-overview"]')).toBeNull()
  expect(c.querySelector('[data-testid="section-results"]')).not.toBeNull()
  expect(c.querySelectorAll('[data-testid="runs-table-row"]')).toHaveLength(2)
  // "All versions" reads resultsAll.
  click(segButton(c, 'All versions'))
  expect(c.querySelector('[data-testid="runs-summary"]')!.textContent).toBe('1 of 3 passed · best 100')
})

it('shows Overview for an unknown ?tab= and keeps ?v= when a tab changes', async () => {
  stubFetch()
  const c = mountPage('/tasks/x?v=1&tab=nope')
  await flush()
  expect(c.querySelector('[data-testid="task-tabs"]')!.getAttribute('data-tab')).toBe('overview')
  click(tabByLabel(c, 'Rubric'))
  expect(c.querySelector('[data-testid="task-tabs"]')!.getAttribute('data-tab')).toBe('rubric')
  expect(c.querySelector('[data-testid="pass-rule"]')!.textContent).toContain('every hidden check passes')
})

it('keeps every old section reachable in its tab', async () => {
  stubFetch()
  const c = mountPage('/tasks/x')
  await flush()
  const has = (id: string) => c.querySelector(`[data-testid="section-${id}"]`) !== null
  expect(has('goal') && has('inject')).toBe(true)
  click(tabByLabel(c, 'Input'))
  expect(['io', 'tools', 'mcp', 'limits'].every(has)).toBe(true)
  expect(c.querySelector('[data-testid="instruction"]')!.textContent).toBe(INSTRUCTION)
  expect(c.querySelector('[data-testid="repository-link"]')!.getAttribute('href')).toBe('https://github.com/devfellowship/itera-certificacao-onchain/tree/main/benchmarks/webhook-ledger/environment')
  click(tabByLabel(c, 'Expected output'))
  expect(c.querySelector('[data-testid="expected-full"]')).not.toBeNull()
  click(tabByLabel(c, 'Rubric'))
  expect(['scoring', 'version'].every(has)).toBe(true)
  click(tabByLabel(c, 'Runs'))
  await flush() // the runs panel of this tab reads the cached evaluations
  expect(has('results')).toBe(true)
  // The "All runs" link of the overview opens the Runs tab.
  click(tabByLabel(c, 'Overview'))
  await flush()
  click(c.querySelector('[data-testid="runs-all-link"]'))
  await flush()
  expect(c.querySelector('[data-testid="task-tabs"]')!.getAttribute('data-tab')).toBe('runs')
})

it('shows only the instruction and the grader note when the task has no run', async () => {
  const empty = { ...results, runs: 0, outcomes: { pass: 0, fail: 0, invalid: 0 }, leaderboard: [] }
  const fetchMock = vi.fn(async (input: string) => (new URL(input).pathname === '/public/tasks/x' ? json(200, { ...task, results: empty, resultsAll: empty }) : json(404, {})))
  vi.stubGlobal('fetch', fetchMock)
  const c = mountPage('/tasks/x')
  await flush()
  await flush()
  const chat = c.querySelector('[data-testid="chat-view"]')!
  expect([...chat.querySelectorAll('[data-testid="chat-msg"]')].map((m) => m.getAttribute('data-role'))).toEqual(['user', 'grader'])
  expect(chat.querySelectorAll('[data-testid="chat-tool"]')).toHaveLength(0)
  expect(tabByLabel(c, 'Runs')!.textContent).toBe('Runs0')
  expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).pathname.includes('/actions'))).toBe(false)
})

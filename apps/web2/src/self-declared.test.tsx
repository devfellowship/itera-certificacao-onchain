// @vitest-environment jsdom
// Self-declared results in web2 (plan 20261026-tma-local-runner-and-self-declared-results, L11; Q4 = C):
// the badge on evaluation rows, the evaluation page without proof/share/actions, the local agent page,
// and the hosted-only ranking with the owner's "Local agents" section.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionProvider } from './auth/session'
import { saveSession } from './auth/sessionStorage'
import { AgentDetailPage } from './pages/AgentDetailPage'
import { AgentsPage } from './pages/AgentsPage'
import { MyEvaluationsPage } from './pages/MyEvaluationsPage'
import { RunningEvaluationPage } from './pages/RunningEvaluationPage'
import { isLocalAgent, isSelfDeclared, tipShift } from './tma/ui'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = { token: 'tma-session-token', user: { id: 'dfl:1', email: 'ana@example.com' } }
const EVAL_ID = '11111111-2222-4333-8444-555555555555'
const LOCAL_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const TASK_ID = 'tttttttt-0000-4000-8000-000000000001'

let root: Root | undefined
beforeEach(() => {
  ;(['log', 'info', 'warn', 'error', 'debug'] as const).forEach((m) => vi.spyOn(console, m).mockImplementation(() => {}))
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
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}
const settle = () => waitFor(() => false, 'settle', 60).catch(() => undefined)

type Handler = (url: URL, init: RequestInit) => Response
function mountAt(path: string, handler: Handler, signedIn = true) {
  if (signedIn) saveSession(SESSION)
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === '/me') return json(200, { wallet: 'dfl:1', username: 'ana', displayName: 'Ana', handle: null, avatarUrl: null, initials: 'AN' })
    return handler(url, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<SessionProvider><Outlet /></SessionProvider>}>
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/agents/:aid" element={<AgentDetailPage />} />
            <Route path="/evaluations" element={<MyEvaluationsPage />} />
            <Route path="/evaluations/:eid" element={<RunningEvaluationPage pollMs={10} />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    ),
  )
  return { c, fetchMock }
}
const calls = (m: ReturnType<typeof vi.fn>) => (m.mock.calls as unknown as Array<[string, RequestInit | undefined]>).map(([u, i]) => `${i?.method ?? 'GET'} ${new URL(u).pathname}${new URL(u).search}`)

const listItem = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  shortId: id.slice(0, 8),
  slug: null,
  agent: { id: LOCAL_ID, name: 'Local one', initials: 'LO', authorName: 'Ana', isMine: true },
  createdAt: '2026-10-26T10:00:00.000Z',
  feeSol: '0',
  tasks: [{ id: TASK_ID, name: 'Fix the bug' }],
  counts: { pass: 1, fail: 0, invalid: 0 },
  score: 90,
  status: 'graded',
  share: { kind: 'none', url: null },
  ...extra,
})

function evaluationView(extra: Record<string, unknown> = {}) {
  return {
    id: EVAL_ID,
    shortId: '11111111',
    slug: null,
    status: 'graded',
    uiState: 'graded',
    createdAt: '2026-10-26T10:00:00.000Z',
    elapsedMs: 1000,
    agent: { id: LOCAL_ID, name: 'Local one', initials: 'LO', repo: null, commit: null, authorWallet: 'dfl:1' },
    model: { id: 'deepseek/deepseek-v4.1-flash', release: null },
    taskCount: 1,
    tasks: [{ runId: 'r1', seq: 1, attempts: 1, taskId: TASK_ID, name: 'Fix the bug', slug: 'fix-the-bug', stage: 'graded', status: 'pass', phase: 'done', outcome: 'PASS', score: 90, testsPassed: 4, testsTotal: 5 }],
    stages: [
      { key: 'contract', state: 'done', detail: null },
      { key: 'agent_calls', state: 'done', detail: null },
      { key: 'grading', state: 'done', detail: null },
    ],
    events: [{ tMs: 0, tone: 'ok', label: 'Evaluation created', detail: null }],
    proofs: [],
    isPublic: false,
    shareUrl: null,
    score: 90,
    counts: { pass: 1, fail: 0, invalid: 0 },
    ...extra,
  }
}

const run = { id: 'r1', status: 'pass', phase: 'done', scoreTotal: 90, modelCostUsd: 0.01, actionsCount: 3, patch: 'diff --git a b', patchScope: { allowed: true, changedFiles: ['a.ts'] }, tests: { public: { passed: 1, total: 1 }, hidden: { passed: 4, total: 5 } } }

const localAgent = {
  id: LOCAL_ID,
  name: 'Local one',
  slug: 'local-one',
  description: 'Runs on my laptop.',
  visibility: 'private',
  status: 'active',
  connector: 'local',
  model: 'acme/mystery-7b',
  providerKey: 'deepseek',
  routeKey: 'ollama',
  harness: 'opencode 1.18.31',
  requires: [],
  latestVersion: null,
  createdAt: '2026-10-26T09:00:00.000Z',
  repoFullName: null,
}

const rankingRow = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  rank: null, id, slug: null, name, initials: name.slice(0, 2).toUpperCase(), authorName: 'Ana', isMine: true, when: '2026-10-14T10:00:00.000Z',
  description: null, modelLabel: 'Some model', draft: false, score: 50, taskCount: 1, coverage: null, runCostUsd: null, runCostLamports: null, runCostSol: null, ...extra,
})

describe('isSelfDeclared / isLocalAgent', () => {
  it('are true only for the exact values and never throw on odd input', () => {
    expect(isSelfDeclared({ resultOrigin: 'self_declared' })).toBe(true)
    expect(isSelfDeclared({ resultOrigin: 'hosted' })).toBe(false)
    expect(isSelfDeclared({})).toBe(false)
    expect(isSelfDeclared({ resultOrigin: 'weird' })).toBe(false)
    expect(isSelfDeclared(null)).toBe(false)
    expect(isSelfDeclared(undefined)).toBe(false)
    expect(isLocalAgent({ connector: 'local' })).toBe(true)
    expect(isLocalAgent({ connector: 'github' })).toBe(false)
    expect(isLocalAgent(undefined)).toBe(false)
  })

  it('tipShift keeps the bubble inside a 375 px viewport', () => {
    expect(tipShift(40, 375)).toBe(0) // fits: no shift
    expect(tipShift(300, 375)).toBe(375 - 16 - 260 - 300) // near the right edge: pulled left
    expect(tipShift(4, 375)).toBe(12) // near the left edge: pushed to the 16 px margin
    expect(tipShift(200, 1280)).toBe(0)
  })
})

describe('My evaluations rows', () => {
  it('shows the badge on a self-declared row only; absent, hosted and unknown origins show none', async () => {
    const { c } = mountAt('/evaluations', (url) => {
      if (url.pathname === '/evaluations') {
        return json(200, {
          evaluations: [
            listItem('e1000000-0000-4000-8000-000000000001', { resultOrigin: 'self_declared' }),
            listItem('e2000000-0000-4000-8000-000000000002', { resultOrigin: 'hosted', share: { kind: 'link', url: '/e/abc' } }),
            listItem('e3000000-0000-4000-8000-000000000003'),
            listItem('e4000000-0000-4000-8000-000000000004', { resultOrigin: 'weird' }),
          ],
          totals: { spentLamports: 0, spentSol: '0', usd: 0, counts: { all: 4, myAgents: 4, others: 0 } },
        })
      }
      return json(200, { agents: [], tasks: [], tags: [] })
    })
    // The skeleton also uses .tma-table__row: wait for the data of the last row.
    await waitFor(() => c.textContent!.includes('ev_e4000000'), 'rows')
    const badges = c.querySelectorAll('[data-origin="self_declared"]')
    expect(badges).toHaveLength(1)
    expect(badges[0].textContent).toBe('Self-declared')
    const row = badges[0].closest('.tma-table__row')!
    expect(row.textContent).toContain('ev_e1000000')
    expect(row.querySelector('[data-testid="copy-link"]')).toBeNull()
    // Tooltip: text, reachable by keyboard, linked by aria-describedby.
    const tip = badges[0].closest('.tma-tip')!
    expect(tip.getAttribute('tabindex')).toBe('0')
    const bubble = document.getElementById(tip.getAttribute('aria-describedby')!)!
    expect(bubble.getAttribute('role')).toBe('tooltip')
    expect(bubble.textContent).toBe('TestMyAgent did not run or verify this result')
    // The other three rows rendered without a badge and without an error.
    expect(c.textContent).toContain('ev_e4000000')
    expect(c.querySelectorAll('.tma-table__row').length).toBe(4)
  })
})

describe('Evaluation page', () => {
  it('self-declared: badge + note, no proof, no share, no actions feed, no artifacts, no run actions fetched', async () => {
    const { c, fetchMock } = mountAt(`/evaluations/${EVAL_ID}`, (url) => {
      if (url.pathname === `/evaluations/${EVAL_ID}`) return json(200, evaluationView({ resultOrigin: 'self_declared', paymentKind: 'none' }))
      if (url.pathname === '/runs/r1') return json(200, { ...run, resultOrigin: 'self_declared', patch: null, patchScope: null, actionsCount: 0 })
      if (url.pathname === '/runs/r1/actions') return json(404, { error: 'not_found' })
      if (url.pathname === '/models') return json(200, { default: 'x', models: [] })
      return json(200, { tasks: [], tags: [] })
    })
    await waitFor(() => c.querySelector('[data-testid="evaluation-status"]') !== null, 'status')
    await settle()
    expect(c.querySelector('[data-testid="evaluation-self-declared"]')?.textContent).toBe('Self-declared')
    expect(c.querySelector('[data-testid="self-declared-note"]')?.textContent).toContain("Run on the owner's machine. TestMyAgent did not run or verify it.")
    expect(c.querySelector('[data-testid="event-log"]')).toBeNull()
    expect(c.querySelector('[data-testid="artifacts-results"]')).toBeNull()
    expect(c.querySelector('a[href^="/e/"]')).toBeNull()
    expect(c.textContent).not.toMatch(/proof|certificate|share publicly|copy link/i)
    expect(calls(fetchMock).some((k) => k.includes('/runs/r1/actions'))).toBe(false)
    // The result itself is still shown to the owner.
    expect(c.querySelector('[data-testid="run-score"]')?.textContent).toBe('90')
    expect(c.querySelector('[data-testid="evaluation-status"]')?.textContent).toBe('Graded')
    expect(c.querySelector('[data-testid="running-evaluation-page"]')?.getAttribute('data-origin')).toBe('self_declared')
  })

  it('hosted: unchanged — no badge, the event log and the stored evidence are present, the actions are fetched', async () => {
    const { c, fetchMock } = mountAt(`/evaluations/${EVAL_ID}`, (url) => {
      if (url.pathname === `/evaluations/${EVAL_ID}`) return json(200, evaluationView({ resultOrigin: 'hosted' }))
      if (url.pathname === '/runs/r1') return json(200, run)
      if (url.pathname === '/runs/r1/actions') return json(200, { runId: 'r1', rows: [], hasMore: false })
      if (url.pathname === '/models') return json(200, { default: 'x', models: [] })
      return json(200, { tasks: [], tags: [] })
    })
    await waitFor(() => c.querySelector('[data-testid="artifacts-results"]') !== null, 'artifacts')
    expect(c.querySelector('[data-testid="evaluation-self-declared"]')).toBeNull()
    expect(c.querySelector('[data-testid="self-declared-note"]')).toBeNull()
    expect(c.querySelector('[data-testid="event-log"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="running-evaluation-page"]')?.getAttribute('data-origin')).toBe('hosted')
    await waitFor(() => calls(fetchMock).some((k) => k.includes('/runs/r1/actions')), 'actions fetched')
  })
})

describe('Agent page of a local agent', () => {
  const handler = (agentsAnswer: () => Response, evaluationsAnswer: () => Response = () => json(200, { evaluations: [], totals: {} })): Handler => (url) => {
    if (url.pathname === `/agents/${LOCAL_ID}/profile`) return json(404, { error: 'agent_not_found' })
    if (url.pathname === `/agents/${LOCAL_ID}`) return agentsAnswer()
    if (url.pathname === '/evaluations') return evaluationsAnswer()
    return json(200, { tasks: [], tags: [] })
  }

  it('signed in: pill, the logo from providerKey, route, harness, and the badge on its self-declared row', async () => {
    const { c, fetchMock } = mountAt(
      `/agents/${LOCAL_ID}`,
      handler(
        () => json(200, { agent: localAgent }),
        () =>
          json(200, {
            evaluations: [
              listItem('e1000000-0000-4000-8000-000000000001', { resultOrigin: 'self_declared' }),
              listItem('e2000000-0000-4000-8000-000000000002', { resultOrigin: 'hosted', agent: { id: 'other-agent', name: 'Other', initials: 'OT', authorName: 'Ana', isMine: true } }),
            ],
            totals: {},
          }),
      ),
    )
    await waitFor(() => c.querySelector('[data-testid="local-agent-detail"]') !== null, 'local view')
    expect(c.querySelector('[data-testid="agent-name"]')?.textContent).toBe('Local one')
    expect(c.querySelector('[data-testid="agent-origin-pill"]')?.textContent).toBe('Local agent')
    // Plan Verification row 8: the declared provider wins over the guess from the model id.
    expect(c.querySelector('[data-testid="local-agent-model"] [data-lab="deepseek"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="local-agent-model"]')?.textContent).toContain('acme/mystery-7b')
    expect(c.querySelector('[data-testid="agent-model-route"]')?.textContent).toBe('via local Ollama')
    expect(c.querySelector('[data-testid="agent-harness"]')?.textContent).toContain('opencode 1.18.31')
    expect(c.textContent).toContain('Runs on my laptop.')
    await waitFor(() => c.querySelectorAll('[data-testid="self-declared-table-row"]').length === 1, 'one row of this agent')
    expect(c.querySelector('[data-testid="self-declared-table-row"] [data-origin="self_declared"]')).not.toBeNull()
    expect(c.textContent).not.toContain('Other')
    expect(c.querySelector('[data-testid="tma-cli-steps"]')?.textContent).toContain(`--agent ${LOCAL_ID}`)
    expect(calls(fetchMock)).toContain('GET /evaluations?scope=my_agents')
  })

  it('signed in, GET /agents/:id answers a GitHub agent: not found', async () => {
    const { c } = mountAt(`/agents/${LOCAL_ID}`, handler(() => json(200, { agent: { ...localAgent, connector: 'github' } })))
    await waitFor(() => c.querySelector('[data-testid="agent-detail-notfound"]') !== null, 'not found')
    expect(c.querySelector('[data-testid="local-agent-detail"]')).toBeNull()
  })

  it('logged out: not found, and GET /agents/:id is never called', async () => {
    const { c, fetchMock } = mountAt(`/agents/${LOCAL_ID}`, handler(() => json(200, { agent: localAgent })), false)
    await waitFor(() => c.querySelector('[data-testid="agent-detail-notfound"]') !== null, 'not found')
    expect(calls(fetchMock)).not.toContain(`GET /agents/${LOCAL_ID}`)
    expect(c.querySelector('[data-testid="agent-origin-pill"]')).toBeNull()
  })
})

describe('Agents page', () => {
  const ranking = (rows: unknown[]) => json(200, { rows, counts: { all: rows.length, mine: rows.length }, price: { usdPerRun: 0.1, solUsdRate: null, priceSource: null } })

  it('hides a ranking row with connector local or resultOrigin self_declared, and lists the local agents of a signed-in viewer', async () => {
    const { c, fetchMock } = mountAt('/agents', (url) => {
      if (url.pathname === '/agents/ranking') return ranking([rankingRow('h1', 'Hosted Agent'), rankingRow('l1', 'Leaky Local', { connector: 'local' }), rankingRow('s1', 'Leaky Declared', { resultOrigin: 'self_declared' })])
      if (url.pathname === '/agents') {
        expect(url.searchParams.get('include')).toBe('local')
        return json(200, { agents: [{ id: 'gh-1', name: 'GitHub Agent', connector: 'github', model: 'openai/gpt-5-mini' }, localAgent] })
      }
      return json(200, { tasks: [], tags: [] })
    })
    await waitFor(() => c.textContent!.includes('Hosted Agent'), 'ranking')
    await waitFor(() => c.querySelector('[data-testid="local-agents"]') !== null, 'local agents section')
    expect(c.querySelector('[data-testid="agents-table"]')?.textContent).not.toContain('Leaky Local')
    expect(c.querySelector('[data-testid="agents-table"]')?.textContent).not.toContain('Leaky Declared')
    const rows = c.querySelectorAll('[data-testid="local-agent-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Local one')
    expect(rows[0].textContent).not.toContain('GitHub Agent')
    expect(rows[0].querySelector('a')?.getAttribute('href')).toBe(`/agents/${LOCAL_ID}`)
    expect(rows[0].querySelector('[data-lab="deepseek"]')).not.toBeNull()
    expect(rows[0].querySelector('[data-route="ollama"]')?.textContent).toBe('via local Ollama')
    expect(calls(fetchMock)).toContain('GET /agents?include=local')
  })

  it('no local agent: the section is absent', async () => {
    const { c } = mountAt('/agents', (url) => {
      if (url.pathname === '/agents/ranking') return ranking([rankingRow('h1', 'Hosted Agent')])
      if (url.pathname === '/agents') return json(200, { agents: [{ id: 'gh-1', name: 'GitHub Agent', connector: 'github' }] })
      return json(200, { tasks: [], tags: [] })
    })
    await waitFor(() => c.textContent!.includes('Hosted Agent'), 'ranking')
    await settle()
    expect(c.querySelector('[data-testid="local-agents"]')).toBeNull()
  })

  it('signed out: the section is absent and /agents?include=local is never called', async () => {
    const { c, fetchMock } = mountAt(
      '/agents',
      (url) => {
        if (url.pathname === '/agents/ranking') return ranking([rankingRow('h1', 'Hosted Agent', { isMine: false })])
        return json(200, { tasks: [], tags: [] })
      },
      false,
    )
    await waitFor(() => c.textContent!.includes('Hosted Agent'), 'ranking')
    await settle()
    expect(c.querySelector('[data-testid="local-agents"]')).toBeNull()
    expect(calls(fetchMock).some((k) => k.startsWith('GET /agents?'))).toBe(false)
  })
})

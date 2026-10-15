// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { DEFAULT_API_URL } from './config'
import { apiErrorMessage, UPGRADING_MESSAGE } from './lib/errors'
import { AppLayout } from './pages/AppLayout'
import { EvaluationPage } from './pages/EvaluationPage'
import { MyEvaluationsPage } from './pages/MyEvaluationsPage'
import { NewEvaluationPage } from './pages/NewEvaluationPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEY = 'sk-or-v1-T9SECRETKEYPART000000000000'
const SESSION = { token: 'tma-session-token', user: { id: 'dfl:1', email: 'ana@example.com' } }
const EVAL_ID = '11111111-2222-4333-8444-555555555555'
const AGENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const TASK_ID = 'tttttttt-0000-4000-8000-000000000001'

let root: Root | undefined
let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = []

beforeEach(() => {
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
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
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })

async function waitFor(check: () => boolean, label: string, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

function evaluationView(status: string, runStatus: string, score: number | null) {
  return {
    id: EVAL_ID,
    shortId: '11111111',
    slug: null,
    status,
    uiState: status === 'graded' ? 'graded' : 'running',
    paymentKind: 'free_byok',
    createdAt: '2026-10-15T10:00:00.000Z',
    elapsedMs: 1000,
    agent: { id: AGENT_ID, name: 'testmyagent-demo-agent', repo: 'devfellowship/testmyagent-demo-agent', commit: 'abc1234' },
    model: { id: 'openai/gpt-5-mini', release: null },
    taskCount: 1,
    tasks: [
      { runId: 'r1', slotRunId: 'r1', seq: 1, attempts: 1, taskId: TASK_ID, name: 'Fix the bug', slug: 'fix-the-bug', stage: 'graded', status: runStatus, phase: null, outcome: runStatus === 'pass' ? 'PASS' : null, score, testsPassed: score === null ? null : 4, testsTotal: score === null ? null : 5 },
    ],
    events: [],
    proofs: [],
    score,
    counts: { pass: runStatus === 'pass' ? 1 : 0, fail: 0, invalid: 0, review: 0, cancelled: 0, queued: 0, running: runStatus === 'running' ? 1 : 0 },
  }
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

function stubApi(overrides: Record<string, Handler> = {}) {
  let evalPolls = 0
  const routes: Record<string, Handler> = {
    'GET /github/sample-repos': () => json(200, { agents: ['devfellowship/testmyagent-demo-agent'], tasks: [] }),
    'GET /agents': () => json(200, { agents: [] }),
    'GET /tasks': () => json(200, { tasks: [{ id: TASK_ID, slug: 'fix-the-bug', name: 'Fix the bug', description: 'A bug fix task.', runnable: true, estMinutes: 5 }] }),
    'GET /models': () => json(200, { default: 'openai/gpt-5-mini', models: [{ id: 'openai/gpt-5-mini', label: 'GPT-5 mini' }, { id: 'anthropic/claude-x', label: null }] }),
    'POST /agents': () => json(201, { agent: { id: AGENT_ID, name: 'testmyagent-demo-agent', repoFullName: 'devfellowship/testmyagent-demo-agent', agentPath: '.', model: 'openai/gpt-5-mini', source: 'sample' } }),
    'POST /evaluations': () => json(202, { evaluationId: EVAL_ID, status: 'pending', paymentKind: 'free_byok', runs: [{ id: 'r1', taskId: TASK_ID, seq: 1 }] }),
    [`GET /evaluations/${EVAL_ID}`]: () => {
      evalPolls++
      return evalPolls < 2 ? json(200, evaluationView('in_progress', 'running', null)) : json(200, evaluationView('graded', 'pass', 87.5))
    },
    'GET /evaluations': () => json(200, { evaluations: [{ id: EVAL_ID, shortId: '11111111', agent: { id: AGENT_ID, name: 'demo' }, createdAt: '2026-10-15T10:00:00.000Z', tasks: [{ id: TASK_ID, slug: 'fix-the-bug', name: 'Fix the bug' }], counts: { pass: 1, fail: 0, invalid: 0 }, score: 87.5, status: 'graded', share: { kind: 'none', url: null } }] }),
    ...overrides,
  }
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    const key = `${init.method ?? 'GET'} ${url.pathname}`
    const handler = routes[key]
    if (!handler) return json(404, { error: `no mock for ${key}` })
    return handler(input, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// MemoryRouter, not a data router: the data router builds a fetch `Request`, which jsdom's AbortSignal breaks.
const probe = { pathname: '' }
function LocationProbe() {
  probe.pathname = useLocation().pathname
  return null
}

function mountAt(path: string, signedIn = true) {
  if (signedIn) saveSession(SESSION)
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/evaluate" element={<NewEvaluationPage />} />
            <Route path="/evaluations" element={<MyEvaluationsPage />} />
            <Route path="/evaluations/:id" element={<EvaluationPage pollMs={10} />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    ),
  )
  return { c }
}

const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`)

function typeKey(c: HTMLElement, value: string) {
  const input = c.querySelector<HTMLInputElement>('[data-testid="model-key-input"]')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function fillForm(c: HTMLElement) {
  await waitFor(() => q(c, 'agent-option') !== null, 'agent options')
  act(() => q(c, 'agent-option')!.click())
  act(() => q(c, 'task-option')!.click())
  typeKey(c, KEY)
}

function assertKeyNeverLogged() {
  for (const spy of consoleSpies) {
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain('T9SECRET')
  }
}

describe('web2 evaluation flow', () => {
  it('happy path: sample agent → task → key → start → running → graded with the score and no proof link', async () => {
    const fetchMock = stubApi()
    const { c } = mountAt('/evaluate')
    expect(q(c, 'login-dfl')).toBeNull()
    await fillForm(c)
    const start = c.querySelector<HTMLButtonElement>('[data-testid="start-evaluation"]')!
    expect(start.disabled).toBe(false)
    act(() => start.click())
    await waitFor(() => probe.pathname === `/evaluations/${EVAL_ID}`, 'navigation to the evaluation')

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit | undefined]>
    const agentCall = calls.find(([u, i]) => u === `${DEFAULT_API_URL}/agents` && i?.method === 'POST')!
    expect(JSON.parse(agentCall[1]!.body as string)).toMatchObject({ repoFullName: 'devfellowship/testmyagent-demo-agent', agentPath: '.', model: 'openai/gpt-5-mini', source: 'sample' })
    const evalCall = calls.find(([u, i]) => u === `${DEFAULT_API_URL}/evaluations` && i?.method === 'POST')!
    expect(JSON.parse(evalCall[1]!.body as string)).toEqual({ agentId: AGENT_ID, taskIds: [TASK_ID], modelApiKey: KEY })
    expect(new Headers(evalCall[1]!.headers).get('Authorization')).toBe(`Bearer ${SESSION.token}`)

    await waitFor(() => q(c, 'evaluation-status')?.dataset.status === 'graded', 'graded')
    expect(q(c, 'score-total')!.textContent).toBe('87.5')
    expect(q(c, 'run-score')!.textContent).toBe('87.5')
    expect(q(c, 'run-status')!.textContent).toBe('Pass')
    expect(q(c, 'cancel-evaluation')).toBeNull()
    const text = c.textContent!.toLowerCase()
    for (const word of ['proof', 'verify', 'nft', 'attestation', 'solana']) expect(text).not.toContain(word)
    for (const a of Array.from(c.querySelectorAll('a'))) expect(a.getAttribute('href')).not.toMatch(/proof|verify|nft|\/e\//)
    // The key is not in the page, the storage or the console.
    expect(c.textContent).not.toContain('T9SECRET')
    expect(JSON.stringify({ ...localStorage })).not.toContain('T9SECRET')
    assertKeyNeverLogged()
  })

  it('shows the running state with per-run status before the end, and stops polling at graded', async () => {
    const fetchMock = stubApi()
    const { c } = mountAt(`/evaluations/${EVAL_ID}`)
    await waitFor(() => q(c, 'evaluation-status') !== null, 'status')
    expect(q(c, 'evaluation-status')!.dataset.status).toBe('in_progress')
    expect(q(c, 'run-status')!.textContent).toBe('Running')
    expect(q(c, 'score-total')).toBeNull()
    expect(q(c, 'cancel-evaluation')).not.toBeNull()
    await waitFor(() => q(c, 'evaluation-status')?.dataset.status === 'graded', 'graded')
    const polls = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith(`/evaluations/${EVAL_ID}`)).length
    const n = polls()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60))
    })
    expect(polls()).toBe(n)
  })

  it('cancel posts to the cancel route for the owner', async () => {
    let cancelled = false
    const fetchMock = stubApi({
      [`GET /evaluations/${EVAL_ID}`]: () => json(200, cancelled ? evaluationView('cancelled', 'cancelled', null) : evaluationView('pending', 'queued', null)),
      [`POST /evaluations/${EVAL_ID}/cancel`]: () => {
        cancelled = true
        return json(200, { evaluationId: EVAL_ID, status: 'cancelled', cancelledRuns: 1, refund: null })
      },
    })
    const { c } = mountAt(`/evaluations/${EVAL_ID}`)
    await waitFor(() => q(c, 'cancel-evaluation') !== null, 'cancel button')
    act(() => q(c, 'cancel-evaluation')!.click())
    await waitFor(() => q(c, 'evaluation-status')?.dataset.status === 'cancelled', 'cancelled')
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/cancel') && (i as RequestInit).method === 'POST')).toBe(true)
  })

  const errorCases: Array<[string, number, Record<string, unknown>, string]> = [
    ['model_key_invalid', 422, { error: 'bad key', code: 'model_key_invalid' }, 'OpenRouter does not accept this key'],
    ['model_key_no_credit', 422, { error: 'no credit', code: 'model_key_no_credit' }, 'This key has no credit left'],
    ['model_key_required', 422, { error: 'required', code: 'model_key_required' }, 'Enter your OpenRouter API key'],
    ['quota_exceeded', 429, { error: 'quota_exceeded', code: 'quota_exceeded', resetAt: '2026-10-16T10:00:00.000Z', limit: 10, used: 10 }, 'You used your daily evaluation quota'],
    ['too_many_queued', 429, { error: 'too many', code: 'too_many_queued' }, 'maximum number of runs queued or running'],
    ['account_disabled', 403, { error: 'account_disabled' }, 'Your account is disabled'],
    ['schema_not_ready', 503, { error: 'database schema is not migrated yet (needs db/migrations/0019_x.sql)' }, 'Service is being upgraded'],
  ]

  for (const [name, status, body, message] of errorCases) {
    it(`renders the message for ${status} ${name} and keeps the key out of the console`, async () => {
      stubApi({ 'POST /evaluations': () => json(status, body) })
      const { c } = mountAt('/evaluate')
      await fillForm(c)
      act(() => c.querySelector<HTMLButtonElement>('[data-testid="start-evaluation"]')!.click())
      await waitFor(() => q(c, 'evaluation-error') !== null, 'error message')
      expect(q(c, 'evaluation-error')!.textContent).toContain(message)
      expect(probe.pathname).toBe('/evaluate')
      expect(c.textContent).not.toContain('T9SECRET')
      assertKeyNeverLogged()
    })
  }

  it('quota_exceeded shows the reset time', () => {
    const resetAt = '2026-10-16T10:00:00.000Z'
    expect(apiErrorMessage(429, { code: 'quota_exceeded', resetAt })).toContain(new Date(resetAt).toLocaleString())
    expect(apiErrorMessage(503, { error: 'schema_not_ready' })).toBe(UPGRADING_MESSAGE)
  })

  it('shows the upgrade message when the page data is not ready (503)', async () => {
    stubApi({ 'GET /tasks': () => json(503, { error: 'database schema is not migrated yet' }) })
    const { c } = mountAt('/evaluate')
    await waitFor(() => q(c, 'evaluation-error') !== null, 'error')
    expect(q(c, 'evaluation-error')!.textContent).toBe(UPGRADING_MESSAGE)
  })

  it('lists my evaluations with links to each one and no share link', async () => {
    stubApi()
    const { c } = mountAt('/evaluations')
    await waitFor(() => q(c, 'evaluation-row') !== null, 'rows')
    const link = q(c, 'evaluation-row')!.querySelector('a')!
    expect(link.getAttribute('href')).toBe(`/evaluations/${EVAL_ID}`)
    expect(q(c, 'evaluation-row')!.textContent).toContain('87.5')
    expect(c.textContent!.toLowerCase()).not.toContain('proof')
  })

  it('asks a signed-out user to log in, with one login button', () => {
    stubApi()
    const { c } = mountAt('/evaluate', false)
    expect(c.querySelectorAll('[data-testid="login-dfl"]')).toHaveLength(1)
    expect(q(c, 'start-evaluation')).toBeNull()
  })

  it('the start button stays disabled until an agent, a task and a key are set', async () => {
    stubApi()
    const { c } = mountAt('/evaluate')
    await waitFor(() => q(c, 'agent-option') !== null, 'agent options')
    const start = () => c.querySelector<HTMLButtonElement>('[data-testid="start-evaluation"]')!
    expect(start().disabled).toBe(true)
    act(() => q(c, 'agent-option')!.click())
    act(() => q(c, 'task-option')!.click())
    expect(start().disabled).toBe(true)
    typeKey(c, KEY)
    expect(start().disabled).toBe(false)
    await flush()
  })
})

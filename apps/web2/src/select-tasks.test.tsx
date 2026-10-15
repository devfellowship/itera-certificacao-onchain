// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { DEFAULT_API_URL } from './config'
import { SessionProvider } from './auth/session'
import { SelectTasksPage } from './pages/SelectTasksPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEY = 'sk-or-v1-UI5SECRETKEYPART000000000000'
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
async function waitFor(check: () => boolean, label: string, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

const TASK = {
  id: TASK_ID,
  slug: 'fix-the-bug',
  name: 'Fix the bug',
  description: 'A bug fix task.',
  tags: [],
  kind: 'curated',
  visibility: 'public',
  status: 'ready',
  runnable: true,
  hiddenTestsCount: 4,
  estMinutes: 5,
  mine: false,
  agentsRunCount: 0,
}

function stubApi(overrides: Record<string, (init: RequestInit) => Response> = {}) {
  const routes: Record<string, (init: RequestInit) => Response> = {
    [`GET /agents/${AGENT_ID}`]: () => json(200, { agent: { id: AGENT_ID, name: 'demo-agent', repoFullName: 'devfellowship/demo-agent', model: 'openai/gpt-5-mini', pinnedCommit: 'abc1234def' } }),
    'GET /tasks': () => json(200, { tasks: [TASK], counts: { all: 1, public: 1, mine: 0 } }),
    'GET /models': () =>
      json(200, { default: 'openai/gpt-5-mini', models: [{ id: 'openai/gpt-5-mini', label: 'GPT-5 mini', provider: 'openai', enabled: true, supportsTools: true, releases: [] }] }),
    'POST /models/access': () => json(200, { label: 'e2e key', limitRemaining: 5, isFreeTier: false }),
    'POST /evaluations': () => json(202, { evaluationId: EVAL_ID, status: 'pending', paymentKind: 'free_byok', runs: [{ id: 'r1', taskId: TASK_ID, seq: 1 }] }),
    ...overrides,
  }
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${new URL(input).pathname}`
    const handler = routes[key]
    if (!handler) return json(404, { error: `no mock for ${key}` })
    return handler(init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const probe = { pathname: '' }
function LocationProbe() {
  probe.pathname = useLocation().pathname
  return null
}

function mount() {
  saveSession(SESSION)
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={[`/agents/${AGENT_ID}/evaluate`]}>
        <LocationProbe />
        <Routes>
          <Route element={<SessionProvider><Outlet /></SessionProvider>}>
            <Route path="/agents/:aid/evaluate" element={<SelectTasksPage />} />
            <Route path="/evaluations/:eid" element={<div data-testid="running-stub" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    ),
  )
  return c
}

const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`)

function typeKey(c: HTMLElement, value: string) {
  const input = q(c, 'model-key-input') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('SelectTasksPage (web2)', () => {
  it('shows tasks, the model select and the key field; the text has no SOL, wallet or quote', async () => {
    stubApi()
    const c = mount()
    await waitFor(() => q(c, 'task-option') !== null, 'task option')
    expect(c.querySelectorAll('[data-testid="task-option"]').length).toBeGreaterThanOrEqual(1)
    expect(c.querySelectorAll('[data-testid="model-select"]')).toHaveLength(1)
    expect(c.querySelectorAll('[data-testid="model-key-field"]')).toHaveLength(1)
    await waitFor(() => (q(c, 'summary-minutes')?.textContent ?? '').includes('5 min'), 'estimated minutes')
    expect(c.textContent).toContain('Free. Your OpenRouter key pays the model; it is sent once and never stored.')
    expect(c.textContent).not.toMatch(/SOL|wallet|quote/i)
  })

  it('start stays disabled until the key is checked OK, then POSTs exactly the free body and opens the evaluation', async () => {
    const fetchMock = stubApi()
    const c = mount()
    await waitFor(() => (q(c, 'summary-minutes')?.textContent ?? '').includes('5 min'), 'selection')
    const start = () => q(c, 'start-evaluation') as HTMLButtonElement
    expect(start().disabled).toBe(true)
    typeKey(c, KEY)
    expect(start().disabled).toBe(true)
    act(() => q(c, 'model-key-check')!.click())
    await waitFor(() => q(c, 'model-key-ok') !== null, 'key ok')
    await waitFor(() => !start().disabled, 'start enabled')
    // Editing the key again drops the OK.
    typeKey(c, KEY + 'x')
    expect(start().disabled).toBe(true)
    typeKey(c, KEY)
    act(() => q(c, 'model-key-check')!.click())
    await waitFor(() => !start().disabled, 'start enabled again')

    act(() => start().click())
    await waitFor(() => probe.pathname === `/evaluations/${EVAL_ID}`, 'navigation to the evaluation')
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit | undefined]>
    const evalCall = calls.find(([u, i]) => u === `${DEFAULT_API_URL}/evaluations` && i?.method === 'POST')!
    expect(JSON.parse(evalCall[1]!.body as string)).toEqual({ agentId: AGENT_ID, taskIds: [TASK_ID], modelApiKey: KEY })
    expect(probe.pathname).not.toContain('sk-or')
    expect(JSON.stringify({ ...localStorage })).not.toContain('UI5SECRET')
    for (const spy of consoleSpies) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain('UI5SECRET')
  })

  it('shows the API refusal message and stays on the page', async () => {
    stubApi({ 'POST /evaluations': () => json(429, { error: 'quota_exceeded', code: 'quota_exceeded', resetAt: '2026-10-16T10:00:00.000Z' }) })
    const c = mount()
    await waitFor(() => (q(c, 'summary-minutes')?.textContent ?? '').includes('5 min'), 'selection')
    typeKey(c, KEY)
    act(() => q(c, 'model-key-check')!.click())
    await waitFor(() => q(c, 'model-key-ok') !== null, 'key ok')
    await waitFor(() => !(q(c, 'start-evaluation') as HTMLButtonElement).disabled, 'start enabled')
    act(() => q(c, 'start-evaluation')!.click())
    await waitFor(() => q(c, 'evaluation-error') !== null, 'error')
    expect(q(c, 'evaluation-error')!.textContent).toContain('You used your daily evaluation quota')
    expect(probe.pathname).toBe(`/agents/${AGENT_ID}/evaluate`)
    expect(c.textContent).not.toContain('UI5SECRET')
  })
})

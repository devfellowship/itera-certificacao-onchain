// @vitest-environment jsdom
/**
 * L15b (plan TMA L15): web2 = ingested only for now (Tainan TG 23889). With HOSTED_RUNS_ENABLED off (the default,
 * no mock here) every hosted-start surface shows the local-runner hint: no key input, no start button, and no
 * POST /evaluations leaves the client. The hosted path itself stays tested by select-tasks.test.tsx,
 * evaluation.test.tsx, evaluation-review.test.tsx and agents.test.tsx, which mock the switch ON.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { SessionProvider } from './auth/session'
import { HOSTED_RUNS_ENABLED } from './config'
import { HOSTED_NOT_AVAILABLE_MESSAGE, apiErrorMessage } from './lib/errors'
import { AgentDetailPage } from './pages/AgentDetailPage'
import { AgentsPage } from './pages/AgentsPage'
import { MyEvaluationsPage } from './pages/MyEvaluationsPage'
import { NewEvaluationPage } from './pages/NewEvaluationPage'
import { SelectTasksPage } from './pages/SelectTasksPage'
import { RunButton } from './pages/task-profile/RailCard'
import { LOCAL_RUNNER_HINT_HASH, firstTaskSlugOf } from './tma/ui'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = { token: 'tma-session-token', user: { id: 'dfl:1', email: 'ana@example.com' } }
const AGENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const TASK_ID = 'tttttttt-0000-4000-8000-000000000001'
const TASK = { id: TASK_ID, slug: 'fix-the-bug', name: 'Fix the bug', description: 'A bug fix task.', tags: [], kind: 'curated', visibility: 'public', status: 'ready', runnable: true, hiddenTestsCount: 4, estMinutes: 5, mine: false, agentsRunCount: 0 }
const GITHUB_AGENT = { id: AGENT_ID, name: 'demo-agent', repoFullName: 'devfellowship/demo-agent', model: 'openai/gpt-5-mini', pinnedCommit: 'abc1234def' }
const LOCAL_AGENT = { id: AGENT_ID, name: 'my-local-agent', connector: 'local', model: 'ollama/gemma4:12b', providerKey: 'google', routeKey: 'ollama' }

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
const q = <T extends Element = HTMLElement>(c: Element, id: string) => c.querySelector<T>(`[data-testid="${id}"]`)

async function waitFor(check: () => boolean, label: string, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)) })

type Handler = (init: RequestInit) => Response
function stubApi(routes: Record<string, Handler>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const key = `${init.method ?? 'GET'} ${url.pathname}`
    const handler = routes[key]
    if (!handler) return json(404, { error: `no mock for ${key}` })
    return handler(init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
/** Every request the client made, as "METHOD /path". */
const calls = (fetchMock: ReturnType<typeof stubApi>) => fetchMock.mock.calls.map(([input, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${new URL(typeof input === 'string' ? input : (input as URL | Request) instanceof URL ? (input as URL).href : (input as Request).url).pathname}`)

const ME = { wallet: 'dfl:1', username: 'ana', displayName: 'Ana', handle: null, avatarUrl: null, initials: 'AN' }
const COMMON: Record<string, Handler> = {
  'GET /me': () => json(200, ME),
  'GET /tasks': () => json(200, { tasks: [TASK], counts: { all: 1, public: 1, mine: 0 } }),
  'GET /tags': () => json(200, { tags: [] }),
  'GET /models': () => json(200, { default: 'openai/gpt-5-mini', models: [{ id: 'openai/gpt-5-mini', label: 'GPT-5 mini', provider: 'openai', enabled: true, supportsTools: true, releases: [] }] }),
  'GET /github/sample-repos': () => json(200, { agents: ['devfellowship/testmyagent-demo-agent'], tasks: [] }),
  'GET /agents': () => json(200, { agents: [GITHUB_AGENT] }),
  'POST /evaluations': () => json(202, { evaluationId: 'never', status: 'pending', paymentKind: 'free_byok', runs: [] }),
}

function mountAt(path: string, routes: Record<string, Handler> = {}, signedIn = true) {
  if (signedIn) saveSession(SESSION)
  const fetchMock = stubApi({ ...COMMON, ...routes })
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<SessionProvider><Outlet /></SessionProvider>}>
            <Route path="/evaluate" element={<NewEvaluationPage />} />
            <Route path="/evaluations" element={<MyEvaluationsPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/agents/:aid" element={<AgentDetailPage />} />
            <Route path="/agents/:aid/evaluate" element={<SelectTasksPage />} />
            <Route path="/tasks/:slug" element={<RunButton task={{ ...TASK, price: { usdPerRun: 0 } } as never} testId="cta-run" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    ),
  )
  return { c, fetchMock }
}

function expectHintOnly(c: Element, fetchMock: ReturnType<typeof stubApi>) {
  const hint = q(c, 'local-runner-hint')
  expect(hint).not.toBeNull()
  expect(hint!.textContent).toContain('Run it on your machine')
  expect(hint!.textContent).toContain('Hosted runs are not available for a DFL login for now.')
  expect(hint!.textContent).toContain('self-declared')
  expect(q(c, 'tma-cli-steps')).not.toBeNull()
  expect(hint!.textContent).toContain('tma upload result.json')
  expect(q(c, 'model-key-input')).toBeNull()
  expect(q(c, 'model-key-field')).toBeNull()
  expect(q(c, 'start-evaluation')).toBeNull()
  expect(calls(fetchMock).filter((k) => k.startsWith('POST /evaluations'))).toEqual([])
}

describe('the switch', () => {
  it('is OFF by default (no VITE_TMA_WEB2_HOSTED in the test env)', () => {
    expect(HOSTED_RUNS_ENABLED).toBe(false)
  })
})

describe('/evaluate (NewEvaluationPage) with hosted runs off', () => {
  it('shows the title and the generic hint: no form, no key input, no start, no POST /evaluations', async () => {
    const { c, fetchMock } = mountAt('/evaluate')
    await waitFor(() => q(c, 'local-runner-hint') !== null, 'hint')
    await settle()
    expect(c.querySelector('h1')!.textContent).toBe('New evaluation')
    expectHintOnly(c, fetchMock)
    expect(q(c, 'agent-option')).toBeNull()
    expect(q(c, 'model-select')).toBeNull()
    // Generic: placeholders and the "New local agent" link.
    expect(q(c, 'tma-cli-run')!.textContent).toContain('--task <task slug> --agent <agent id>')
    expect(q(c, 'local-runner-hint-new-agent')!.getAttribute('href')).toBe('/agents/new?source=local')
    expect(q(c, 'local-runner-hint')!.getAttribute('data-agent')).toBe('generic')
  })

  it('?tasks=<slug> (a task profile CTA) fills the tma run --task line', async () => {
    const { c } = mountAt('/evaluate?tasks=fix-the-bug')
    await waitFor(() => q(c, 'local-runner-hint') !== null, 'hint')
    expect(q(c, 'tma-cli-run')!.textContent).toContain('tma run --task fix-the-bug --agent <agent id>')
  })

  it('still asks a signed-out user to log in first', () => {
    const { c } = mountAt('/evaluate', {}, false)
    expect(q(c, 'login-dfl')).not.toBeNull()
    expect(q(c, 'local-runner-hint')).toBeNull()
  })
})

describe('/agents/:aid/evaluate (SelectTasksPage) with hosted runs off', () => {
  it('a GitHub agent: title, breadcrumb with the agent name, generic hint, no key input, no start, no POST', async () => {
    const { c, fetchMock } = mountAt(`/agents/${AGENT_ID}/evaluate`, { [`GET /agents/${AGENT_ID}`]: () => json(200, { agent: GITHUB_AGENT }) })
    await waitFor(() => c.textContent!.includes('demo-agent'), 'agent name')
    await settle()
    expect(q(c, 'select-tasks-page')!.getAttribute('data-hosted')).toBe('off')
    expect(c.querySelector('h1')!.textContent).toBe('Select tasks')
    expectHintOnly(c, fetchMock)
    expect(q(c, 'evaluation-summary')).toBeNull()
    expect(q(c, 'local-runner-hint')!.getAttribute('data-agent')).toBe('generic')
    expect(q(c, 'local-runner-hint-new-agent')).not.toBeNull()
  })

  it('?tasks=<catalog id> resolves to the slug in the tma run line', async () => {
    const { c } = mountAt(`/agents/${AGENT_ID}/evaluate?tasks=${TASK_ID}`, { [`GET /agents/${AGENT_ID}`]: () => json(200, { agent: GITHUB_AGENT }) })
    await waitFor(() => (q(c, 'tma-cli-run')?.textContent ?? '').includes('--task fix-the-bug'), 'slug from the catalog')
  })

  it('a LOCAL agent fills its own steps (agent id and model) and shows no "New local agent" link', async () => {
    const { c, fetchMock } = mountAt(`/agents/${AGENT_ID}/evaluate?tasks=fix-the-bug`, { [`GET /agents/${AGENT_ID}`]: () => json(200, { agent: LOCAL_AGENT }) })
    await waitFor(() => q(c, 'local-runner-hint')?.getAttribute('data-agent') === 'local', 'local steps')
    await settle()
    expectHintOnly(c, fetchMock)
    expect(q(c, 'tma-cli-run')!.textContent).toContain(`tma run --task fix-the-bug --agent ${AGENT_ID} --agent-dir ./my-agent --model ollama/gemma4:12b`)
    expect(q(c, 'local-runner-hint-new-agent')).toBeNull()
  })
})

const row = (id: string, name: string, coverage: unknown) => ({
  rank: null, id, slug: null, name, initials: name.slice(0, 2).toUpperCase(), authorName: 'Ana', isMine: false, when: '2026-10-14T10:00:00.000Z',
  description: null, model: 'openai/gpt-5-mini', modelLabel: 'GPT-5 mini', draft: false, score: null, taskCount: 0, coverage, runCostUsd: 0, runCostLamports: 0, runCostSol: '0',
})

describe('/agents (AgentsPage) with hosted runs off', () => {
  it('a ranking row that could run (coverage 0 of 1) shows no "Run ·" button; the note names the local runner', async () => {
    const { c } = mountAt(`/agents?tasks=${TASK_ID}`, {
      'GET /agents/ranking': () => json(200, { rows: [row('a1', 'Alpha Agent', { k: 0, n: 1, perTask: [false] })], counts: { all: 1, mine: 0 }, price: { usdPerRun: 0.1, solUsdRate: null, priceSource: null } }),
    }, false)
    await waitFor(() => c.textContent!.includes('Alpha Agent') && q(c, 'ranked-on') !== null, 'ranking row on the selected task')
    await settle()
    expect(c.textContent).toContain('0 / 1')
    expect(q(c, 'agent-run')).toBeNull()
    expect(c.textContent).not.toContain('Run ·')
    expect(c.textContent).not.toContain('your OpenRouter key')
    expect(c.textContent).toContain('Run missing tasks on your machine with the tma local runner.')
  })
})

const profile = (isMine: boolean) => ({
  agent: { id: 'agent-1', slug: null, name: 'Profile Agent', initials: 'PA', description: 'An agent.', authorName: 'Ana', authorWallet: 'dfl:1', isMine, listedAt: '2026-10-14T10:00:00.000Z', visibility: 'public', draft: false },
  source: { repoFullName: 'ana/agent', branch: 'main', agentPath: 'agent', commit: 'abc1234abc', commitShort: 'abc1234' },
  model: { id: 'openai/gpt-5-mini', label: 'GPT-5 mini', release: null },
  stats: { score: null, tasksEvaluated: 0, evaluations: 0, lastVerifiedAt: null },
  tags: [],
  evidence: [],
  latestAttestation: null,
  evaluations: [],
  history: [],
  price: { usdPerRun: 0.1, solUsdRate: 150, priceSource: 'x', runCostLamports: 1000, runCostSol: '0.00092', indicative: true },
})

describe('/agents/:aid (AgentDetailPage) with hosted runs off', () => {
  it('own GitHub agent: the hint replaces the run card; "Run on more tasks" and "Choose tasks →" point at the hint; the empty text names the local runner', async () => {
    const { c, fetchMock } = mountAt('/agents/agent-1', {
      'GET /agents/agent-1/profile': () => json(200, profile(true)),
      'GET /agents/agent-1/my-results': () => json(200, { results: [] }),
    })
    await waitFor(() => q(c, 'agent-detail') !== null, 'profile')
    await waitFor(() => q(c, 'my-results-table') !== null || q(c, 'on-your-tasks-error') !== null, 'my results')
    expect(q(c, 'run-card')).toBeNull()
    expect(q(c, 'choose-tasks')).toBeNull()
    expect(c.textContent).not.toContain('Free. Bring your own OpenRouter key.')
    const hint = q(c, 'local-runner-hint')!
    expect(hint).not.toBeNull()
    expect(hint.id).toBe('local-runner')
    expect(q(c, 'local-runner-hint-new-agent')!.getAttribute('href')).toBe('/agents/new?source=local')
    const links = Array.from(c.querySelectorAll('a')).filter((a) => /Run on more tasks|Choose tasks/.test(a.textContent ?? ''))
    expect(links.length).toBeGreaterThanOrEqual(2)
    // A router <Link to="#local-runner"> renders the current path plus the hash; a plain <a> renders the hash alone.
    for (const a of links) expect(a.getAttribute('href')!.endsWith(LOCAL_RUNNER_HINT_HASH)).toBe(true)
    expect(Array.from(c.querySelectorAll('a')).some((a) => (a.getAttribute('href') ?? '').endsWith('/evaluate'))).toBe(false)
    expect(q(c, 'public-evidence')!.textContent).toContain('Run a task on your machine with the tma local runner')
    expect(calls(fetchMock).filter((k) => k.startsWith('POST /evaluations'))).toEqual([])
  })
})

describe('other start links with hosted runs off', () => {
  it('the task profile CTA (signed in) opens /evaluate?tasks=<slug>, not the hosted flow', async () => {
    const { c } = mountAt('/tasks/fix-the-bug')
    await waitFor(() => q(c, 'cta-run') !== null, 'cta')
    expect(q(c, 'cta-run')!.getAttribute('href')).toBe('/evaluate?tasks=fix-the-bug')
  })

  it('My evaluations: "New evaluation" lands on /evaluate (the hint)', async () => {
    const { c } = mountAt('/evaluations', {
      'GET /evaluations': () => json(200, { evaluations: [], totals: { spentLamports: 0, spentSol: '0', usd: 0, counts: { all: 0, myAgents: 0, others: 0 } } }),
    })
    await waitFor(() => q(c, 'new-evaluation') !== null, 'button')
    await settle()
    expect(q(c, 'new-evaluation')!.getAttribute('href')).toBe('/evaluate')
  })
})

describe('apiErrorMessage: hosted_not_available_web2', () => {
  it('returns the API message when it is there', () => {
    const m = apiErrorMessage(403, { error: 'hosted_not_available_web2', message: 'X local runner self-declared' })
    expect(m).toBe('X local runner self-declared')
  })
  it('falls back to the fixed API sentence (local runner + self-declared) without a message', () => {
    const m = apiErrorMessage(403, { error: 'hosted_not_available_web2' })
    expect(m).toBe(HOSTED_NOT_AVAILABLE_MESSAGE)
    expect(m).toContain('tma local runner')
    expect(m).toContain('/self-declared-results')
  })
})

describe('firstTaskSlugOf', () => {
  it('resolves an id through the catalog, keeps a slug, drops an unknown UUID, and reads the first entry', () => {
    expect(firstTaskSlugOf(TASK_ID, [TASK])).toBe('fix-the-bug')
    expect(firstTaskSlugOf('fix-the-bug', [TASK])).toBe('fix-the-bug')
    expect(firstTaskSlugOf('fix-the-bug')).toBe('fix-the-bug')
    expect(firstTaskSlugOf(TASK_ID)).toBeNull()
    expect(firstTaskSlugOf('a-slug,b-slug')).toBe('a-slug')
    expect(firstTaskSlugOf('')).toBeNull()
    expect(firstTaskSlugOf(null)).toBeNull()
  })
})

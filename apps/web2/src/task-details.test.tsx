// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionProvider } from './auth/session'
import { saveSession } from './auth/sessionStorage'
import type { Task, TaskHistoryResponse } from './lib/api'
import { TaskProfilePage } from './pages/TaskProfilePage'
import { TasksPage, taskRowTarget } from './pages/TasksPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = { token: 'session-token', user: { id: 'dfl:owner', email: 'owner@example.com' } }
const TASK_ID = '63ebf17e-f26d-47ab-90c6-ffc81104840d'
let root: Root | undefined

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

function mount(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(node))
  return container
}

const task = {
  id: TASK_ID,
  slug: 'repository-research',
  name: 'Repository Research',
  description: 'Research a repository fleet with cited evidence.',
  tags: [{ id: 'research', name: 'Research', kind: 'concept' as const }],
  kind: 'itera' as const,
  source: 'curated',
  visibility: 'private' as const,
  status: 'ready' as const,
  runnable: true,
  hiddenTestsCount: 0,
  estMinutes: 10,
  labels: ['open-tests'],
  version: 4,
  mine: true,
  agentsRunCount: 3,
  createdAt: '2026-10-12T10:00:00.000Z',
  updatedAt: '2026-10-19T10:00:00.000Z',
  latestVersion: {
    id: 'v4', version: 4, source: 'curated', labels: ['open-tests'], runnable: true, hiddenTestsCount: 0,
    fixtureDigest: 'abc', hiddenDigest: null, validatedAt: null, createdAt: '2026-10-12T10:00:00.000Z',
    packId: 'dfl-fleet-research', packVersion: '4',
    sourceLink: { provider: 'GitHub', repo: 'devfellowship/itera-certificacao-onchain', path: 'benchmarks/dfl-fleet-research', commit: '0fbb6c534fce7077cdff7e2743846501ee08964d' },
  },
}

const history: TaskHistoryResponse = {
  task,
  summary: { evaluations: 2, agents: 2, rankingEligible: false },
  evaluations: [
    {
      id: '4491c225-a6db-4693-a148-d8604a4875c5', shortId: '4491c225', createdAt: '2026-10-19T09:00:00.000Z', status: 'graded', score: 100,
      counts: { pass: 1, fail: 0, invalid: 0 }, tests: { passed: 5, total: 5 }, model: { id: 'zai/glm-5.3' },
      agent: { id: 'a1', slug: null, name: 'DeepSeek benchmark', authorName: 'you', authorWallet: 'dfl:owner' },
    },
    {
      id: '5591c225-a6db-4693-a148-d8604a4875c5', shortId: '5591c225', createdAt: '2026-10-18T09:00:00.000Z', status: 'review', score: null,
      counts: { pass: 0, fail: 0, invalid: 0 }, tests: { passed: 0, total: 0 },
      agent: { id: 'a2', slug: null, name: 'Nemotron benchmark', authorName: 'you', authorWallet: 'dfl:owner' },
    },
  ],
}

it('renders open-test activity as Unranked with truthful counts in the Tasks table', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(200, {
    tasks: [{ ...task, evaluationCount: 17, agentsCount: 3, rankingEligible: false, bestResult: null, author: { name: 'you', avatarUrl: null } }],
    counts: { all: 1, public: 0, mine: 1 },
  })))
  const container = mount(<MemoryRouter><TasksPage /></MemoryRouter>)
  await flush()
  expect(container.querySelector('[data-testid="task-unranked"]')?.textContent).toContain('Unranked')
  expect(container.querySelector('[data-testid="task-unranked"]')?.textContent).toContain('17 evaluations')
  expect(container.textContent).toContain('3')
  expect(container.textContent).not.toContain('Not run')
  expect(container.textContent).not.toContain('What the agent receives')
})

it('routes a ready owned task to details while drafts remain in the editor', () => {
  expect(taskRowTarget(task as Task)).toBe(`/tasks/${TASK_ID}`)
  expect(taskRowTarget({ ...task, status: 'draft' } as Task)).toBe(`/tasks/${TASK_ID}/edit`)
})

it('shows owned task facts and every evaluation with scores and detail links', async () => {
  saveSession(SESSION)
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = new URL(input).pathname
    if (path === '/me') return json(200, { wallet: 'dfl:owner', displayName: 'Tainan', handle: 'taigfs', avatarUrl: null, initials: 'TF' })
    if (path === `/tasks/${TASK_ID}/evaluations`) return json(200, history)
    return json(404, { error: 'not found' })
  }))
  const container = mount(
    <MemoryRouter initialEntries={[`/tasks/${TASK_ID}`]}>
      <SessionProvider><Routes><Route path="/tasks/:slug" element={<TaskProfilePage />} /></Routes></SessionProvider>
    </MemoryRouter>,
  )
  await flush()
  expect(container.querySelector('[data-testid="owned-task-details"]')).not.toBeNull()
  expect(container.querySelector('[data-testid="task-detail-title"]')?.textContent).toBe('Repository Research')
  expect(container.querySelector('[data-testid="task-unranked-explanation"]')).toBeNull()
  const links = [...container.querySelectorAll<HTMLAnchorElement>('[data-testid="task-evaluation-link"]')]
  expect(links).toHaveLength(2)
  expect(links.map((link) => link.getAttribute('href'))).toEqual(history.evaluations.map((e) => `/evaluations/${e.id}`))
  // L14a: the shared runs table. Score `100 ±17.5` (90% Wilson CI of 5/5 = 64.9–100), `—` without a score.
  expect([...container.querySelectorAll('[data-testid="run-score"]')].map((node) => node.textContent)).toEqual(['100 ±17.5', '—'])
  expect([...container.querySelectorAll('[data-testid="result-dot"]')].map((node) => node.getAttribute('data-result'))).toEqual(['pass', ''])
  expect([...container.querySelectorAll('[data-testid="run-checks"]')].map((node) => node.textContent)).toEqual(['5/5', '—'])
  expect(container.querySelectorAll('[data-testid="run-source"]')).toHaveLength(2)
  expect(container.textContent).not.toContain('checks passed')
  expect(container.textContent).not.toContain('ev_4491c225')
  // Each evaluation row names its model with the lab logo and the route that ran it (not a fixed "via OpenRouter").
  const models = [...container.querySelectorAll<HTMLElement>('[data-testid="task-evaluation-model"]')]
  expect(models).toHaveLength(1)
  expect(models[0]!.dataset.route).toBe('zai')
  expect(models[0]!.querySelector('[data-lab]')?.getAttribute('data-lab')).toBe('zai')
  expect(models[0]!.textContent).toContain('zai/glm-5.3')
  expect(models[0]!.textContent).toContain('via Z.ai API')
  expect(container.textContent).not.toContain('OpenRouter')
  expect(container.querySelector('[data-testid="task-source-link"]')?.getAttribute('href')).toContain('/tree/0fbb6c534fce7077cdff7e2743846501ee08964d/benchmarks/dfl-fleet-research')
})

it('shows the history empty state without inventing a result', async () => {
  saveSession(SESSION)
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = new URL(input).pathname
    if (path === '/me') return json(200, { wallet: 'dfl:owner', displayName: 'Tainan', handle: null, avatarUrl: null, initials: 'TF' })
    if (path === `/tasks/${TASK_ID}/evaluations`) return json(200, { ...history, evaluations: [], summary: { ...history.summary, evaluations: 0, agents: 0 } })
    return json(404, { error: 'not found' })
  }))
  const container = mount(
    <MemoryRouter initialEntries={[`/tasks/${TASK_ID}`]}>
      <SessionProvider><Routes><Route path="/tasks/:slug" element={<TaskProfilePage />} /></Routes></SessionProvider>
    </MemoryRouter>,
  )
  await flush()
  expect(container.querySelector('[data-testid="task-history-empty"]')?.textContent).toContain('No evaluations yet')
  expect(container.querySelectorAll('[data-testid="task-evaluation-link"]')).toHaveLength(0)
})

it('does not request private history for an anonymous visitor', async () => {
  const fetchMock = vi.fn(async (_input: string) => json(404, { error: 'task not found' }))
  vi.stubGlobal('fetch', fetchMock)
  const container = mount(
    <MemoryRouter initialEntries={[`/tasks/${TASK_ID}`]}>
      <SessionProvider><Routes><Route path="/tasks/:slug" element={<TaskProfilePage />} /></Routes></SessionProvider>
    </MemoryRouter>,
  )
  await flush()
  expect(container.textContent).toContain('Page not found')
  expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).pathname.endsWith('/evaluations'))).toBe(false)
})

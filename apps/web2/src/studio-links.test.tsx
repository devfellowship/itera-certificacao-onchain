// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, MemoryRouter, matchRoutes, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { routes } from './routes'
import { STUDIO_SCREENS, StudioLink, studioHref, type StudioScreen } from './studio/links'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function mount(node: React.ReactNode) {
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() => root!.render(node))
  return c
}

const SCREENS = Object.keys(STUDIO_SCREENS) as StudioScreen[]

describe('studio compatibility links (C5-T2)', () => {
  it('a screen is marked built if and only if routes.tsx has a studio route for its path', () => {
    for (const s of SCREENS) {
      const m = matchRoutes(routes, STUDIO_SCREENS[s].path)
      const page = (m?.[m.length - 1]?.route.element as { type?: { name?: string } } | undefined)?.type?.name
      const exists = !!m && page !== 'NotFoundPage'
      expect(STUDIO_SCREENS[s].built, `${s} ${STUDIO_SCREENS[s].path}`).toBe(exists)
    }
  })

  it('every screen path is inside /studio', () => {
    for (const s of SCREENS) expect(STUDIO_SCREENS[s].path.startsWith('/studio/')).toBe(true)
  })

  it('builds the href with the filter and drops empty values', () => {
    expect(studioHref('S6', { agent: 'a 1', task: null, x: '' })).toBe('/studio/experiments?agent=a+1')
    expect(studioHref('S8')).toBe('/studio/compare')
  })

  it('renders nothing while the screen is not built, and a link when it is', () => {
    const hidden = mount(
      <MemoryRouter>
        <StudioLink screen="S8" built={false}>
          Compare per use case
        </StudioLink>
      </MemoryRouter>,
    )
    expect(hidden.innerHTML).toBe('')
    act(() => root?.unmount())
    const shown = mount(
      <MemoryRouter>
        <StudioLink screen="S8" built testId="x">
          Compare per use case
        </StudioLink>
      </MemoryRouter>,
    )
    const a = shown.querySelector<HTMLAnchorElement>('[data-testid="x"]')!
    expect(a.getAttribute('href')).toBe('/studio/compare')
    expect(a.textContent).toBe('Compare per use case')
  })

  it('the "when" condition hides a built link', () => {
    const c = mount(
      <MemoryRouter>
        <StudioLink screen="S7" built when={false}>
          Compare with baseline
        </StudioLink>
      </MemoryRouter>,
    )
    expect(c.innerHTML).toBe('')
  })

})

// The old pages, mounted as in agents.test.tsx, with the studio screens switched on and off.
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
const profile = {
  agent: { id: 'agent-1', slug: null, name: 'Profile Agent', initials: 'PA', description: 'An agent.', authorName: 'Ana', authorWallet: 'dfl:1', isMine: false, listedAt: '2026-10-14T10:00:00.000Z', visibility: 'public', draft: false },
  source: { repoFullName: 'ana/agent', branch: 'main', agentPath: 'agent', commit: 'abc1234abc', commitShort: 'abc1234' },
  model: { id: 'm', label: 'Some model', release: null },
  stats: { score: 80, tasksEvaluated: 1, evaluations: 1, lastVerifiedAt: '2026-10-14T10:00:00.000Z' },
  tags: [],
  evidence: [],
  latestAttestation: null,
  evaluations: [],
  price: { usdPerRun: 0.1, solUsdRate: 150, priceSource: 'x', runCostLamports: 1000, runCostSol: '0.00092', indicative: true },
}
const ranking = { rows: [{ rank: null, id: 'a1', slug: null, name: 'Alpha Agent', initials: 'AA', authorName: 'Ana', isMine: false, when: '2026-10-14T10:00:00.000Z', description: null, modelLabel: 'Some model', draft: false, score: 90, taskCount: 3, coverage: null, runCostUsd: 0.1, runCostLamports: 1000, runCostSol: '0.00092' }], counts: { all: 1, mine: 0 }, price: { usdPerRun: 0.1, solUsdRate: null, priceSource: null } }

function mountOld(path: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/agents/ranking')) return json(200, ranking)
      if (new URL(url).pathname.endsWith('/profile')) return json(200, profile)
      if (new URL(url).pathname.endsWith('/my-results')) return json(200, { results: [] })
      if (new URL(url).pathname === '/agents') return json(200, { agents: [] })
      return json(200, { tasks: [], tags: [] })
    }),
  )
  return mount(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />)
}

describe('studio links on the old pages (C5-T2)', () => {
  const saved = SCREENS.map((s) => [s, STUDIO_SCREENS[s].built] as const)
  afterEach(() => {
    for (const [s, b] of saved) STUDIO_SCREENS[s].built = b
  })

  it('no studio link on /agents and /agents/:aid while no studio screen exists', async () => {
    saveSession({ token: 'tok', user: { id: 'u-1', email: 'ana@example.com' } })
    // C5-T3 built S4 and S5: switch every screen off to prove the hidden state.
    for (const s of SCREENS) STUDIO_SCREENS[s].built = false
    const a = mountOld('/agents')
    await waitFor(() => a.textContent!.includes('Alpha Agent'), 'ranking')
    expect(a.querySelectorAll('[data-studio-link]')).toHaveLength(0)
    act(() => root?.unmount())
    document.body.innerHTML = ''
    const d = mountOld('/agents/agent-1')
    await waitFor(() => d.textContent!.includes('Profile Agent'), 'profile')
    expect(d.querySelectorAll('[data-studio-link]')).toHaveLength(0)
    expect(d.querySelector('.tad-studio-links:empty')).not.toBeNull()
  })

  it('as shipped (C7-T4: S4 to S8 built): /agents/:aid links to S5 and S6, /agents links to S8', async () => {
    saveSession({ token: 'tok', user: { id: 'u-1', email: 'ana@example.com' } })
    for (const s of ['S4', 'S5', 'S6', 'S7'] as const) expect(STUDIO_SCREENS[s].built, s).toBe(true)
    expect(STUDIO_SCREENS.S8.built).toBe(true)
    const d = mountOld('/agents/agent-1')
    await waitFor(() => d.textContent!.includes('Profile Agent'), 'profile')
    expect(d.querySelector('[data-testid="studio-variants"]')?.getAttribute('href')).toBe('/studio/experiments/new?agent=agent-1')
    expect(d.querySelector('[data-testid="studio-experiments"]')?.getAttribute('href')).toBe('/studio/experiments?agent=agent-1')
    act(() => root?.unmount())
    document.body.innerHTML = ''
    const a = mountOld('/agents')
    await waitFor(() => a.textContent!.includes('Alpha Agent'), 'ranking')
    expect(a.querySelector('[data-testid="studio-compare-use-case"]')?.getAttribute('href')).toBe('/studio/compare')
    expect(a.querySelector('[data-testid="studio-compare-use-case"]')?.textContent).toBe('Compare per use case')
  })

  it('with the screens built: /agents links to S8 and /agents/:aid to S5 and S6 filtered by the agent', async () => {
    saveSession({ token: 'tok', user: { id: 'u-1', email: 'ana@example.com' } })
    for (const s of SCREENS) STUDIO_SCREENS[s].built = true
    const a = mountOld('/agents')
    await waitFor(() => a.textContent!.includes('Alpha Agent'), 'ranking')
    expect(a.querySelector('[data-testid="studio-compare-use-case"]')?.getAttribute('href')).toBe('/studio/compare')
    act(() => root?.unmount())
    document.body.innerHTML = ''
    const d = mountOld('/agents/agent-1')
    await waitFor(() => d.textContent!.includes('Profile Agent'), 'profile')
    expect(d.querySelector('[data-testid="studio-variants"]')?.getAttribute('href')).toBe('/studio/experiments/new?agent=agent-1')
    expect(d.querySelector('[data-testid="studio-experiments"]')?.getAttribute('href')).toBe('/studio/experiments?agent=agent-1')
  })

  it('way back (C5-FIX-LINKS): S5 and S6 link to /agents/:aid, S8 links each agent, an /evaluations row links to S6', async () => {
    saveSession({ token: 'tok', user: { id: 'u-1', email: 'ana@example.com' } })
    for (const s of SCREENS) STUDIO_SCREENS[s].built = true
    const evalRun = {
      id: 'r1', evaluationId: 'e1', agentId: 'agent-1', agentName: 'Profile Agent', seq: 1, status: 'graded', score: 90, infraOk: true,
      startedAt: '2026-10-14T10:00:00.000Z', caseId: 'c1', caseKey: 'case-1', useCaseKey: 'verify/x', predictionSha256: null,
      variant: { id: 'v1', label: 'baseline', changeKind: 'none', agentSha256: 'a'.repeat(64), variantSha256: 'b'.repeat(64), agent: { harness: 'opencode', harnessVersion: null, modelId: 'm' } },
    }
    const evaluation = {
      id: 'e1', shortId: 'ab12cd', slug: null, agent: { id: 'agent-1', name: 'Profile Agent', initials: 'PA', authorName: 'Ana', isMine: true },
      createdAt: '2026-10-14T10:00:00.000Z', feeSol: '0', tasks: [{ id: 't1', name: 'Task one' }], counts: { passed: 1, failed: 0, total: 1 },
      score: 90, status: 'completed', share: { kind: 'none', url: null },
    }
    const evaluationsBody = { evaluations: [evaluation], totals: { spentLamports: 0, spentSol: '0', usd: 0, counts: { all: 1, myAgents: 1, others: 0 } } }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
        if (path.endsWith('/eval-runs')) return json(200, { runs: [], limit: 500, truncated: false })
        if (path.endsWith('/eval-cases')) return json(200, { cases: [] })
        if (path.endsWith('/evaluations')) return json(200, evaluationsBody)
        return json(200, {})
      }),
    )
    const href = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`)?.getAttribute('href')

    // A local agent (the owner of uploaded eval runs) has no public profile: its page carries the forward links too.
    const baseFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    const baseImpl = baseFetch.getMockImplementation()!
    baseFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
      if (path === '/agents/agent-2/profile') return json(404, { error: 'not_found' })
      if (path === '/agents/agent-2') return json(200, { agent: { id: 'agent-2', name: 'Local Agent', connector: 'local', model: 'opencode-go/x', providerKey: 'p', harness: 'opencode', visibility: 'private' } })
      return baseImpl(input)
    })
    const local = mount(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/agents/agent-2'] })} />)
    await waitFor(() => !!local.querySelector('[data-testid="local-agent-detail"]'), 'local agent page')
    expect(href(local, 'studio-variants')).toBe('/studio/experiments/new?agent=agent-2')
    expect(href(local, 'studio-experiments')).toBe('/studio/experiments?agent=agent-2')
    act(() => root?.unmount())
    document.body.innerHTML = ''
    baseFetch.mockImplementation(baseImpl)

    // S5 with an ?agent= filter and no uploaded run: the agent page link still exists.
    const s5 = mount(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/studio/experiments/new?agent=agent-1'] })} />)
    await waitFor(() => !!s5.querySelector('[data-testid="experiment-agent-link"]'), 'S5 agent link')
    expect(href(s5, 'experiment-agent-link')).toBe('/agents/agent-1')
    act(() => root?.unmount())
    document.body.innerHTML = ''

    // S6 empty state with the filter, then with one run that carries the agent id.
    const s6 = mount(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/studio/experiments?agent=agent-1'] })} />)
    await waitFor(() => !!s6.querySelector('[data-testid="s6-agent-link"]'), 'S6 agent link')
    expect(href(s6, 's6-agent-link')).toBe('/agents/agent-1')
    act(() => root?.unmount())
    document.body.innerHTML = ''
    const withRun = { ...evalRun, caseKey: 'case-1' }
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
      if (path.endsWith('/eval-runs')) return json(200, { runs: [withRun], limit: 500, truncated: false })
      if (path.endsWith('/evaluations')) return json(200, evaluationsBody)
      return json(200, { cases: [] })
    })
    const s6b = mount(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/studio/experiments'] })} />)
    await waitFor(() => !!s6b.querySelector('[data-testid="s6-agent-link"]'), 'S6 agent link from a run')
    expect(href(s6b, 's6-agent-link')).toBe('/agents/agent-1')
    act(() => root?.unmount())
    document.body.innerHTML = ''

    // S8: the table row links to the agent that ran the variant.
    const agentRow = {
      agent_key: `m#${'1'.repeat(64)}`, variant_ids: ['v1'], model_id: 'm', harness: 'opencode', n: 5, infra_error_count: 0, no_score_runs: 0,
      hard_gate_failures: 0, mean_score: 90, distribution: null, cost_per_task: null, cost_label: null, median_wall_ms: null,
      absolute: { label: 'SAME', reason: null, runs_at_least_same: 5, runs_at_least_close: 5 },
      relative: { label: 'refused', reason: 'no_current_agent', gap: null, mann_whitney: null },
      pareto: { ineligible_reason: null, on_front: null, dominated: null },
    }
    const compare = {
      use_case: 'verify/x',
      profile: { source: 'defaults', sha256: null, weights: 'w', min_runs_per_cell: 5, relative_margin_points: 5, relative_alpha: 0.05, relative_test: 't', absolute_bars: { same: 90, close: 70 } },
      rule_text: { absolute: 'a', relative: 'r' }, current_agent: null, agents: [agentRow],
    }
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
      if (path.endsWith('/eval-runs')) return json(200, { runs: [withRun], limit: 500, truncated: false })
      if (path.endsWith('/compare')) return json(200, compare)
      if (path.endsWith('/evaluations')) return json(200, evaluationsBody)
      return json(200, { cases: [] })
    })
    const s8 = mount(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/studio/compare?use_case=verify%2Fx'] })} />)
    await waitFor(() => !!s8.querySelector('[data-testid="s8-agent-link"]'), 'S8 agent link')
    expect(href(s8, 's8-agent-link')).toBe('/agents/agent-1')
    act(() => root?.unmount())
    document.body.innerHTML = ''

    // /evaluations: the row links to S6 filtered by the agent, and its click still opens the evaluation.
    const ev = mount(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/evaluations'] })} />)
    await waitFor(() => !!ev.querySelector('[data-testid="row-studio-experiments"]'), 'evaluations row link')
    expect(href(ev, 'row-studio-experiments')).toBe('/studio/experiments?agent=agent-1')
    STUDIO_SCREENS.S6.built = false
    act(() => root?.unmount())
    document.body.innerHTML = ''
    const hidden = mount(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/evaluations'] })} />)
    await waitFor(() => hidden.textContent!.includes('Profile Agent'), 'evaluations row')
    expect(hidden.querySelector('[data-testid="row-studio-experiments"]')).toBeNull()
  }, 20_000)
})

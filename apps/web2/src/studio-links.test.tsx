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
})

// @vitest-environment jsdom
/**
 * S9 trajectory wall and path map (plan 20261112-tma-c5-studio-area-web2, task C5-T9).
 * Mounted through routes.tsx (layout, nav, session gate) with a stubbed GET /trajectories, plus the views alone.
 * Proves: the wall (one row per run, one cell per step with its letter, rows sorted by status then length, the first
 * failure outlined, canonical run links), the path map (a trunk and 4 branches from the spec pruning -> 6 nodes with
 * n and pass rate), the fleet link, no shape label while named_shapes is false (and bands when a spec turns it on),
 * Studio active in the nav, read only, and the empty and 503 states.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { DEFAULT_FLEET_WALL_URL } from './config'
import { routes } from './routes'
import { TrajectoriesView } from './studio/StudioTrajectoriesPage'
import { SHAPES_SPEC, pathTree, sortRuns, type TrajectoriesResponse, type TrajectoryRun } from './studio/trajectories'

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

const EVAL = 'e1000000-1d4a-4c8e-9f00-123456789abc'
const AGENT = 'ab6f3c2e-1d4a-4c8e-9f00-123456789abc'
const run = (id: string, kinds: string, status: TrajectoryRun['status'] = 'pass', firstFailure: number | null = null, over: Partial<TrajectoryRun> = {}): TrajectoryRun => ({
  id, evaluationId: EVAL, agentId: AGENT, status, resultOrigin: 'hosted', kinds, truncated: false, steps: kinds.length, firstFailure, ...over,
})
const RUNS: TrajectoryRun[] = [
  run('r-fail', 'RSWT', 'fail', 2),
  run('r-long', 'RSWWT'),
  run('r-short', 'RW'),
  run('r-timeout', 'RM', 'timeout'),
  run('r-upload', 'SW', 'fail', 0, { resultOrigin: 'self_declared', evaluationId: null }),
]
/** The API answer for 20 runs RRS + one of W/T/M/X: the spec pruning keeps a trunk R -> RS and 4 branches. */
const PATH_MAP: TrajectoriesResponse['pathMap'] = {
  totalRuns: 20,
  nodes: [
    { path: 'R', n: 20, pass: 5, passRate: 0.25 },
    { path: 'RS', n: 20, pass: 5, passRate: 0.25 },
    { path: 'RSM', n: 5, pass: 0, passRate: 0 },
    { path: 'RST', n: 5, pass: 0, passRate: 0 },
    { path: 'RSW', n: 5, pass: 5, passRate: 1 },
    { path: 'RSX', n: 5, pass: 0, passRate: 0 },
  ],
  edges: [
    { from: 'R', to: 'RS' },
    { from: 'RS', to: 'RSM' },
    { from: 'RS', to: 'RST' },
    { from: 'RS', to: 'RSW' },
    { from: 'RS', to: 'RSX' },
  ],
}
const DATA: TrajectoriesResponse = { schema: 'trajectory-shapes/1', namedShapes: false, fallback: 'wall-only', runs: RUNS, pathMap: PATH_MAP, limit: 300, truncated: false }

const calls: string[] = []
function mountAt(path: string, answer: [number, unknown] = [200, DATA]) {
  saveSession({ token: 'tok', user: { id: 'u-1', email: 'ana@example.com' } })
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      calls.push(url.pathname + url.search)
      if (url.pathname === '/trajectories') return json(...answer)
      if (url.pathname === '/eval-cases') return json(200, { cases: [], limit: 200, truncated: false })
      return json(404, { error: 'not found' })
    }),
  )
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() => root!.render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />))
  return c
}
function mountView(node: React.ReactNode) {
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() => root!.render(<MemoryRouter>{node}</MemoryRouter>))
  return c
}
const rows = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[data-testid="s9-row"]')]
const letters = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>('[data-kind]')].map((x) => x.dataset.kind).join('')

describe('S9 wall', () => {
  it('renders one row per run with one cell per step letter, sorted by status then length', async () => {
    const c = mountAt('/studio/trajectories')
    await waitFor(() => !!c.querySelector('[data-testid="s9-wall"]'), 'wall')
    expect(calls).toContain('/trajectories')
    const r = rows(c)
    expect(r).toHaveLength(5)
    expect(r.map((x) => x.dataset.runId)).toEqual(['r-short', 'r-long', 'r-upload', 'r-fail', 'r-timeout'])
    expect(r.map(letters)).toEqual(['RW', 'RSWWT', 'SW', 'RSWT', 'RM'])
    expect(r.map((x) => x.querySelector('[data-testid="s9-status"]')!.textContent)).toEqual(['pass', 'pass', 'fail', 'fail', 'timeout'])
    // The legend holds the six letters of the spec alphabet.
    expect(c.querySelector('[data-testid="s9-legend"]')!.textContent).toMatch(/R read.*S search.*W write.*T test.*M mcp or agent.*X other or shell/)
  })

  it('outlines the first failed step, and only that step', async () => {
    const c = mountAt('/studio/trajectories')
    await waitFor(() => rows(c).length === 5, 'rows')
    const fail = rows(c).find((x) => x.dataset.runId === 'r-fail')!
    const marked = [...fail.querySelectorAll<HTMLElement>('[data-kind]')].map((x, i) => (x.dataset.firstFailure ? i : -1)).filter((i) => i >= 0)
    expect(marked).toEqual([2])
    expect(fail.querySelectorAll('.s9-cell--first-fail')).toHaveLength(1)
    const upload = rows(c).find((x) => x.dataset.runId === 'r-upload')!
    expect(upload.querySelector('[data-kind]')!.getAttribute('data-first-failure')).toBe('true')
    expect(rows(c).find((x) => x.dataset.runId === 'r-short')!.querySelector('[data-first-failure]')).toBeNull()
  })

  it('links each row to the canonical run page; a run with no evaluation has no link', async () => {
    const c = mountAt('/studio/trajectories')
    await waitFor(() => rows(c).length === 5, 'rows')
    const fail = rows(c).find((x) => x.dataset.runId === 'r-fail')!
    expect(fail.tagName).toBe('A')
    expect(fail.getAttribute('href')).toBe(`/evaluations/${EVAL}/runs/r-fail`)
    expect(rows(c).find((x) => x.dataset.runId === 'r-upload')!.tagName).toBe('DIV')
  })

  it('passes the query filters to the API', async () => {
    const c = mountAt(`/studio/trajectories?agent=${AGENT}&origin=hosted`)
    await waitFor(() => rows(c).length === 5, 'rows')
    expect(calls).toContain(`/trajectories?agent=${AGENT}&origin=hosted`)
  })
})

describe('S9 path map', () => {
  it('shows the trunk and its 4 branches with n and pass rate per node', async () => {
    const c = mountAt('/studio/trajectories')
    await waitFor(() => !!c.querySelector('[data-testid="s9-path-map"]'), 'path map')
    const nodes = [...c.querySelectorAll<HTMLElement>('[data-testid="s9-path-node"]')]
    expect(nodes.length).toBeGreaterThanOrEqual(5)
    expect(nodes.map((n) => n.dataset.path)).toEqual(['R', 'RS', 'RSM', 'RST', 'RSW', 'RSX'])
    const rs = nodes.find((n) => n.dataset.path === 'RS')!
    expect(rs.textContent).toMatch(/20 runs · 25% pass/)
    expect(nodes.find((n) => n.dataset.path === 'RSW')!.textContent).toMatch(/5 runs · 100% pass/)
    // RS is the trunk end: its 4 children are the branches.
    expect(rs.closest('li')!.querySelectorAll(':scope > ul > li')).toHaveLength(4)
  })

  it('builds the tree from the edges: one root, branches by count then path', () => {
    const roots = pathTree(PATH_MAP.nodes, PATH_MAP.edges)
    expect(roots.map((r) => r.path)).toEqual(['R'])
    expect(roots[0]!.children.map((r) => r.path)).toEqual(['RS'])
    expect(roots[0]!.children[0]!.children.map((r) => r.path)).toEqual(['RSM', 'RST', 'RSW', 'RSX'])
  })
})

describe('S9 shapes and links', () => {
  it('links the fleet-wide wall and shows no fleet data', async () => {
    const c = mountAt('/studio/trajectories')
    await waitFor(() => rows(c).length === 5, 'rows')
    const a = c.querySelector<HTMLAnchorElement>('[data-testid="s9-fleet-link"]')!
    expect(a.getAttribute('href')).toBe(DEFAULT_FLEET_WALL_URL)
    expect(a.textContent).toBe('Fleet-wide wall')
    expect(calls.every((p) => p.startsWith('/trajectories') || p.startsWith('/eval-cases') || p.startsWith('/me'))).toBe(true)
  })

  it('labels no run by shape while the spec says named_shapes = false', async () => {
    expect(SHAPES_SPEC.named_shapes).toBe(false)
    const c = mountAt('/studio/trajectories')
    await waitFor(() => rows(c).length === 5, 'rows')
    expect(c.querySelector('[data-testid="s9-band"]')).toBeNull()
    expect(c.querySelector('[data-testid="s9-no-shapes"]')!.textContent).toMatch(/not enough runs to name shapes; see plan C5-T8/)
    const text = c.querySelector('main')!.textContent!
    for (const r of SHAPES_SPEC.shape_rules) expect(text, r.name).not.toContain(r.name)
  })

  it('groups the rows into one band per shape when a spec turns named_shapes on', () => {
    const spec = { ...SHAPES_SPEC, named_shapes: true }
    const data = {
      ...DATA,
      namedShapes: true,
      runs: [run('a', 'RW', 'pass', null, { shape: 'straight' }), run('b', 'SR', 'pass', null, { shape: 'search-first' }), run('c', 'RRR', 'fail', 1, { shape: 'straight' })],
    }
    const c = mountView(<TrajectoriesView data={data} spec={spec} />)
    const bands = [...c.querySelectorAll<HTMLElement>('[data-testid="s9-band"]')]
    expect(bands.map((b) => b.dataset.shape)).toEqual(['search-first', 'straight'])
    expect(bands[1]!.querySelectorAll('[data-testid="s9-row"]')).toHaveLength(2)
    expect(c.querySelector('[data-testid="s9-no-shapes"]')).toBeNull()
  })

  it('marks Studio active in the nav and the studio home links to S9', async () => {
    const c = mountAt('/studio/trajectories')
    await waitFor(() => rows(c).length === 5, 'rows')
    const active = [...c.querySelectorAll('nav a[aria-current="page"]')].map((a) => a.textContent)
    expect(active.join(' ')).toMatch(/Studio/)
    act(() => root?.unmount())
    const home = mountAt('/studio')
    await waitFor(() => !!home.querySelector('[data-testid="studio-trajectories-link"]'), 'home link')
    expect(home.querySelector('[data-testid="studio-trajectories-link"]')!.getAttribute('href')).toBe('/studio/trajectories')
  })

  it('is read only: no Save or Run control', async () => {
    const c = mountAt('/studio/trajectories')
    await waitFor(() => rows(c).length === 5, 'rows')
    for (const el of c.querySelectorAll('main button, main [role="button"], main input[type="submit"]')) {
      expect((el.textContent ?? '').trim()).not.toMatch(/^(Save|Run)\b/)
    }
    expect(c.querySelector('main')!.textContent).not.toMatch(/\b(Save|Run)\b/)
  })
})

describe('S9 states', () => {
  it('shows an empty state with no runs', async () => {
    const c = mountAt('/studio/trajectories', [200, { ...DATA, runs: [], pathMap: { totalRuns: 0, nodes: [], edges: [] } }])
    await waitFor(() => !!c.querySelector('[data-testid="s9-empty"]'), 'empty')
    expect(c.querySelector('[data-testid="s9-wall"]')).toBeNull()
  })

  it('shows the not-migrated state on 503', async () => {
    const c = mountAt('/studio/trajectories', [503, { error: 'schema_not_ready' }])
    await waitFor(() => !!c.querySelector('[data-testid="s9-load-error"]'), '503')
    expect(c.querySelector('[data-testid="s9-load-error"]')!.textContent).toMatch(/not migrated/)
  })

  it('says when the list is cut', () => {
    const c = mountView(<TrajectoriesView data={{ ...DATA, truncated: true, limit: 300 }} />)
    expect(c.querySelector('[data-testid="s9-truncated"]')!.textContent).toBe('Showing the newest 300 runs.')
  })

  it('sortRuns puts unknown statuses last and keeps id order on ties', () => {
    expect(sortRuns([run('b', 'RR'), run('a', 'RR'), run('z', 'R', 'infra_error')]).map((r) => r.id)).toEqual(['a', 'b', 'z'])
  })
})

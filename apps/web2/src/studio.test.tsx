// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { routes } from './routes'
import { StudioHomePage } from './studio/StudioHomePage'
import { groupByUseCase, isL1Pair, L1_PAIRS_V4, splitUseCaseKey } from './studio/use-case'
import { sectionFor } from './tma/nav/AppNav'

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
  c.id = 'root'
  document.body.appendChild(c)
  root = createRoot(c)
  act(() => root!.render(node))
  return c
}

describe('use case key (L1 pair, Q-T17 = A)', () => {
  it('splits type/subtype and a bare type', () => {
    expect(splitUseCaseKey('fix/prod-bug')).toEqual({ type: 'fix', subtype: 'prod-bug' })
    expect(splitUseCaseKey('fix')).toEqual({ type: 'fix', subtype: null })
  })

  it('groups by type, then subtype, sorted', () => {
    const g = groupByUseCase([
      { caseKey: 'b-case', useCaseKey: 'fix/prod-bug' },
      { caseKey: 'a-case', useCaseKey: 'fix/prod-bug' },
      { caseKey: 'c-case', useCaseKey: 'fix/red-ci' },
      { caseKey: 'd-case', useCaseKey: 'build/feature' },
    ])
    expect(g.map((x) => x.type)).toEqual(['build', 'fix'])
    expect(g[1]!.total).toBe(3)
    expect(g[1]!.subtypes.map((s) => s.subtype)).toEqual(['prod-bug', 'red-ci'])
    expect(g[1]!.subtypes[0]!.cases.map((c) => c.caseKey)).toEqual(['a-case', 'b-case'])
  })
})

// Verification row 12 (parent ADR-29): S1 shows only the 33 taxonomy pairs. A name that is not one of them is
// REFUSED, not grouped: no group row, no list entry, no name on the page.
const NON_PAIRS = [
  'fix', // bare type
  'review/pr-review', // unknown type
  'fix/not-a-subtype', // known type, unknown subtype
  'Fix/Red-CI', // case variant of a pair
  ' fix/red-ci', // padded pair
  'fix/red-ci/extra', // pair with a third segment
  'fix/', // empty subtype
  '/red-ci', // empty type
  'studio-smoke-fixture', // a case key used as a use case
  '',
]

describe('row 12: a use case name that is not one of the 33 L1 pairs is refused', () => {
  it.each(NON_PAIRS)('groupByUseCase refuses %j', (name) => {
    expect(isL1Pair(name)).toBe(false)
    expect(groupByUseCase([{ caseKey: 'x-001', useCaseKey: name }])).toEqual([])
  })

  it('groupByUseCase keeps a pair and drops a non-pair from the same list', () => {
    const g = groupByUseCase([
      { caseKey: 'a', useCaseKey: 'fix/red-ci' },
      ...NON_PAIRS.map((n, i) => ({ caseKey: `n-${i}`, useCaseKey: n })),
    ])
    expect(g.flatMap((x) => x.subtypes.flatMap((s) => s.cases.map((c) => c.caseKey)))).toEqual(['a'])
  })

  it('every group row it can return is one of the 33 pairs, for each of the 33 pairs and each non-pair', () => {
    const all = [...L1_PAIRS_V4, ...NON_PAIRS].map((useCaseKey, i) => ({ caseKey: `c-${i}`, useCaseKey }))
    const rows = groupByUseCase(all).flatMap((g) => g.subtypes.map((s) => (s.subtype ? `${g.type}/${s.subtype}` : g.type)))
    expect(rows.sort()).toEqual([...L1_PAIRS_V4].sort())
  })
})

describe('L1 pairs of taxonomy v4 (Q-T17 = A)', () => {
  it('holds 33 distinct pairs', () => {
    expect(L1_PAIRS_V4).toHaveLength(33)
    expect(new Set(L1_PAIRS_V4).size).toBe(33)
  })
  it('accepts a pair and refuses other names', () => {
    expect(isL1Pair('fix/red-ci')).toBe(true)
    expect(isL1Pair('review/pr-review')).toBe(false)
    expect(isL1Pair('fix')).toBe(false)
  })
})

describe('S1 Studio home', () => {
  it('renders a pair with the L2 tag and refuses a non-pair: its name is nowhere on the page, only a count shows', () => {
    const c = mount(
      <MemoryRouter>
        <StudioHomePage
          cases={[
            { caseKey: 'ci-001', useCaseKey: 'fix/red-ci', cluster: 'lint-failure' },
            { caseKey: 'rev-001', useCaseKey: 'review/pr-review' },
            { caseKey: 'bare-001', useCaseKey: 'fix' },
          ]}
        />
      </MemoryRouter>,
    )
    expect(c.querySelectorAll('[data-testid="use-case-fix/red-ci"] [data-testid="studio-case"]')).toHaveLength(1)
    // C5-RD-S1: the group row counts its use cases; the "cases" cell of the use case row counts its cases.
    expect(c.querySelector('[data-testid="use-case-fix"]')?.textContent).toContain('fix · 1')
    expect(c.querySelector('[data-testid="use-case-fix/red-ci"] [data-testid="s1-cases"]')?.textContent).toBe('1')
    expect(c.querySelector('[data-testid="use-case-review"]')).toBeNull()
    // Row 12: no unclassified list, and none of the refused names or cases on the page.
    expect(c.querySelector('[data-testid="use-case-unclassified"]')).toBeNull()
    expect(c.textContent).not.toContain('rev-001')
    expect(c.textContent).not.toContain('bare-001')
    expect(c.textContent).not.toContain('review/pr-review')
    expect(c.textContent).not.toContain('Not a taxonomy pair')
    // The refusal is not silent: a count, no name.
    expect(c.querySelector('[data-testid="s1-refused"]')?.textContent).toContain('2 cases')
    expect(c.querySelectorAll('[data-testid="studio-case"]')).toHaveLength(1)
    expect(c.querySelector('[data-testid="use-case-fix/red-ci"] [data-testid="l2-tag"]')?.textContent).toContain('lint-failure')
  })

  it('shows the empty state and the refusal count when every case has a non-pair name', () => {
    const c = mount(
      <MemoryRouter>
        <StudioHomePage cases={[{ caseKey: 'rev-001', useCaseKey: 'review/pr-review' }]} />
      </MemoryRouter>,
    )
    expect(c.querySelector('[data-testid="studio-empty"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="s1-refused"]')?.textContent).toContain('1 case')
    expect(c.textContent).not.toContain('rev-001')
    expect(c.textContent).not.toContain('review/pr-review')
  })

  it('shows the cases grouped by the L1 pair, with a Tasks link, read only', () => {
    const c = mount(
      <MemoryRouter>
        <StudioHomePage cases={[{ caseKey: 'webhook-dup-001', useCaseKey: 'fix/prod-bug' }, { caseKey: 'webhook-dup-002', useCaseKey: 'fix/prod-bug' }, { caseKey: 'add-sso', useCaseKey: 'build/feature' }]} />
      </MemoryRouter>,
    )
    expect(c.querySelector('[data-testid="studio-home"]')?.innerHTML).not.toBe('')
    expect(c.querySelector('[data-testid="use-case-fix/prod-bug"] [data-testid="s1-cases"]')?.textContent).toBe('2')
    expect(c.querySelectorAll('[data-testid="use-case-fix/prod-bug"] [data-testid="studio-case"]')).toHaveLength(2)
    expect(c.querySelectorAll('[data-testid="use-case-build/feature"] [data-testid="studio-case"]')).toHaveLength(1)
    expect(c.querySelector<HTMLAnchorElement>('[data-testid="studio-tasks-link"]')?.getAttribute('href')).toBe('/tasks')
    // Q-T18 = A and Q-T19 = A: no Save button and no Run button in studio v1.
    expect(c.querySelectorAll('button')).toHaveLength(0)
    expect(c.textContent).not.toMatch(/\b(Save|Run)\b/)
  })

  it('shows an empty state when there is no case', () => {
    const c = mount(
      <MemoryRouter>
        <StudioHomePage cases={[]} />
      </MemoryRouter>,
    )
    expect(c.querySelector('[data-testid="studio-empty"]')).not.toBeNull()
  })
})

describe('Studio in the app', () => {
  it('sectionFor marks the Studio section of a path (Use cases by default), and no old path', () => {
    expect(sectionFor('/studio')).toBe('studio')
    expect(sectionFor('/studio/cases/x')).toBe('studio')
    expect(sectionFor('/studio/compare')).toBe('studio')
    expect(sectionFor('/studio/traces')).toBe('traces')
    expect(sectionFor('/studio/traces/abc')).toBe('traces')
    expect(sectionFor('/studio/tracesx')).toBe('studio')
    expect(sectionFor('/studio/graders/g1')).toBe('graders')
    expect(sectionFor('/studio/calibration')).toBe('graders')
    expect(sectionFor('/studio/routing')).toBe('routing')
    expect(sectionFor('/studio/routing/fix%2Fci-red')).toBe('routing')
    expect(sectionFor('/studio/review')).toBe('more')
    expect(sectionFor('/studios')).toBeNull()
    expect(sectionFor('/agents')).toBe('agents')
    expect(sectionFor('/tasks/x')).toBe('tasks')
    expect(sectionFor('/evaluations/e1')).toBe('evaluations')
  })

  it('signed in: /studio mounts under the nav, with the Studio link active; the old links stay', () => {
    saveSession({ token: 'tok', user: { id: 'u-1', email: 'ana@example.com' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
    const pageErrors: unknown[] = []
    const onError = (e: ErrorEvent) => pageErrors.push(e.error)
    window.addEventListener('error', onError)
    const c = mount(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/studio'] })} />)
    window.removeEventListener('error', onError)
    expect(pageErrors).toEqual([])
    expect(c.querySelector('[data-testid="studio-home"]')).not.toBeNull()
    // MT-06: the studio page renders inside the shared studio layout (full width, side panel flush right).
    expect(c.querySelector('[data-testid="studio-layout"] [data-testid="studio-home"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="nav-studio"]')?.getAttribute('aria-current')).toBe('page')
    expect(c.querySelector('[data-testid="nav-studio"]')?.textContent).toBe('Use cases')
    for (const id of ['nav-agents', 'nav-tasks', 'nav-my-evaluations', 'nav-studio-traces', 'nav-studio-graders', 'nav-studio-routing', 'nav-studio-more']) {
      const el = c.querySelector(`[data-testid="${id}"]`)
      expect(el).not.toBeNull()
      expect(el?.getAttribute('aria-current')).toBeNull()
    }
    const hrefs = ['nav-studio', 'nav-studio-traces', 'nav-studio-graders', 'nav-studio-routing'].map((id) => c.querySelector(`[data-testid="${id}"]`)?.getAttribute('href'))
    expect(hrefs).toEqual(['/studio', '/studio/traces', '/studio/graders', '/studio/routing'])
  })

  it('More opens a menu with the review queue (the one item the canvas puts under More), and Escape closes it', () => {
    saveSession({ token: 'tok', user: { id: 'u-1', email: 'ana@example.com' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
    const c = mount(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/agents'] })} />)
    expect(c.querySelector('[data-testid="studio-layout"]')).toBeNull()
    const more = c.querySelector<HTMLButtonElement>('[data-testid="nav-studio-more"]')!
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(c.querySelector('[data-testid="nav-more-menu"]')).toBeNull()
    act(() => more.click())
    expect(more.getAttribute('aria-expanded')).toBe('true')
    const items = [...c.querySelectorAll<HTMLAnchorElement>('[data-testid="nav-more-menu"] [role="menuitem"]')]
    expect(items.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['Review queue', '/studio/review']])
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(c.querySelector('[data-testid="nav-more-menu"]')).toBeNull()
  })

  it('signed out: /studio shows the login gate (same session gate as the old pages)', () => {
    const c = mount(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/studio'] })} />)
    expect(c.querySelector('[data-testid="require-session-login"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="studio-home"]')).toBeNull()
  })
})

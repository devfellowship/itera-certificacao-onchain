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
      { caseKey: 'c-case', useCaseKey: 'fix' },
      { caseKey: 'd-case', useCaseKey: 'build/feature' },
    ])
    expect(g.map((x) => x.type)).toEqual(['build', 'fix'])
    expect(g[1]!.total).toBe(3)
    expect(g[1]!.subtypes.map((s) => s.subtype)).toEqual([null, 'prod-bug'])
    expect(g[1]!.subtypes[1]!.cases.map((c) => c.caseKey)).toEqual(['a-case', 'b-case'])
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
  it('renders a pair in its group and a non-pair in the unclassified group, with the L2 tag', () => {
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
    expect(c.querySelector('[data-testid="use-case-fix"]')?.textContent).toContain('1 case')
    expect(c.querySelector('[data-testid="use-case-review"]')).toBeNull()
    const u = c.querySelector('[data-testid="use-case-unclassified"]')
    expect(u?.textContent).toContain('Not a taxonomy pair')
    expect(u?.textContent).toContain('rev-001')
    expect(u?.textContent).toContain('bare-001')
    expect(c.querySelector('[data-testid="use-case-fix/red-ci"] [data-testid="l2-tag"]')?.textContent).toContain('lint-failure')
  })

  it('shows the cases grouped by the L1 pair, with a Tasks link, read only', () => {
    const c = mount(
      <MemoryRouter>
        <StudioHomePage cases={[{ caseKey: 'webhook-dup-001', useCaseKey: 'fix/prod-bug' }, { caseKey: 'webhook-dup-002', useCaseKey: 'fix/prod-bug' }, { caseKey: 'add-sso', useCaseKey: 'build/feature' }]} />
      </MemoryRouter>,
    )
    expect(c.querySelector('[data-testid="studio-home"]')?.innerHTML).not.toBe('')
    expect(c.querySelector('[data-testid="use-case-fix"]')?.textContent).toContain('2 cases')
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
  it('sectionFor marks /studio and /studio/* active, and no old path', () => {
    expect(sectionFor('/studio')).toBe('studio')
    expect(sectionFor('/studio/cases/x')).toBe('studio')
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
    expect(c.querySelector('[data-testid="nav-studio"]')?.getAttribute('aria-current')).toBe('page')
    for (const id of ['nav-agents', 'nav-tasks', 'nav-my-evaluations']) {
      const el = c.querySelector(`[data-testid="${id}"]`)
      expect(el).not.toBeNull()
      expect(el?.getAttribute('aria-current')).toBeNull()
    }
  })

  it('signed out: /studio shows the login gate (same session gate as the old pages)', () => {
    const c = mount(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/studio'] })} />)
    expect(c.querySelector('[data-testid="require-session-login"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="studio-home"]')).toBeNull()
  })
})

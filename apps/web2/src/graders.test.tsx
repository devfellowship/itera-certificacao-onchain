// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { routes } from './routes'
import { GraderDetailView } from './studio/GraderDetailPage'
import { GraderLibraryView } from './studio/GraderLibraryPage'
import type { GraderVersionDetail, GraderVersionItem } from './studio/graders'

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
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

const SHA = 'abcdef0123456789'.repeat(4)
const ITEMS: GraderVersionItem[] = [
  { id: 'g-1', graderId: 'hidden-tests', semver: '2.0.0', kind: 'code', codeSha256: SHA, judgeModelId: null, createdAt: '2026-11-12T12:00:00.000Z', usedByCount: 4 },
  { id: 'g-2', graderId: 'rubric-judge', semver: '1.0.0', kind: 'judge', codeSha256: SHA, judgeModelId: 'openrouter/zai/glm-5.3', createdAt: '2026-11-12T12:00:00.000Z', usedByCount: 0 },
]
const DETAIL: GraderVersionDetail = {
  ...ITEMS[1]!, rubricSha256: SHA, paramsSha256: null, testSplitSha256: null, tpr: 0.9, tnr: 0.8, proof: { caught: 3, total: 3 }, note: 'v1', author: 'claude-main',
  calibration: { nLabels: 30, nTest: 10, tp: 4, fn: 1, tn: 4, fp: 1, realignedAt: null },
  recentRuns: [{ runId: '3b6f3c2e-1d4a', caseId: null, evaluationId: 'e-1', pass: true, gradedAt: '2026-11-12T12:05:00.000Z' }],
}
const FORBIDDEN = /\b(Save as|Save|Duplicate|Plant another bug|Run)\b/

describe('S10 grader library', () => {
  it('renders a row per version with the short digest, full on hover, used-by, and a link to S10a', () => {
    const c = mount(<MemoryRouter><GraderLibraryView items={ITEMS} /></MemoryRouter>)
    const row = c.querySelector('[data-testid="grader-row-hidden-tests"]')!
    expect(row.textContent).toContain('hidden-tests@2.0.0')
    expect(row.querySelector('[data-testid="grader-digest"]')?.textContent).toBe(SHA.slice(0, 12))
    expect(row.querySelector('[data-testid="grader-digest"]')?.getAttribute('title')).toBe(SHA)
    expect(row.querySelector('[data-testid="grader-used-by"]')?.textContent).toBe('4')
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/studio/graders/g-1')
    expect(c.querySelector('[data-testid="grader-row-rubric-judge"]')).not.toBeNull()
    expect(c.textContent).not.toMatch(FORBIDDEN)
  })
  it('shows an empty state on an empty list', () => {
    const c = mount(<MemoryRouter><GraderLibraryView items={[]} /></MemoryRouter>)
    expect(c.querySelector('[data-testid="graders-empty"]')).not.toBeNull()
  })
})

describe('S10a grader detail', () => {
  it('renders the detail with a copy command and no write control', () => {
    const c = mount(<MemoryRouter><GraderDetailView g={DETAIL} /></MemoryRouter>)
    expect(c.querySelector('[data-testid="grader-detail"]')?.textContent).toContain('rubric-judge@1.0.0')
    expect(c.querySelector('[data-testid="grader-proof"]')?.textContent).toContain('3 of 3')
    expect(c.querySelector('[data-testid="grader-judge"]')?.textContent).toContain('90%')
    expect(c.querySelectorAll('[data-testid="grader-recent-run"]')).toHaveLength(1)
    const cmd = c.querySelector('[data-copy-command]')!
    expect(cmd.getAttribute('data-copy-command')).toMatch(/^tma eval grade --case /)
    expect(c.textContent).not.toMatch(FORBIDDEN)
    for (const el of c.querySelectorAll('button, a')) expect(el.textContent).not.toMatch(FORBIDDEN)
  })
  it('copies the command with navigator.clipboard', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const c = mount(<MemoryRouter><GraderDetailView g={DETAIL} /></MemoryRouter>)
    await act(async () => { c.querySelector<HTMLButtonElement>('[data-copy-command] button')!.click() })
    expect(writeText).toHaveBeenCalledWith(c.querySelector('[data-copy-command]')!.getAttribute('data-copy-command'))
  })
})

describe('Graders in the app', () => {
  const at = (path: string) => mount(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />)
  const signIn = () => saveSession({ token: 'tok', user: { id: 'u-1', email: 'ana@example.com' } })

  it('/studio/graders loads the list, marks Studio active, and the home links to it', async () => {
    signIn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ graderVersions: ITEMS }), { status: 200 })))
    const c = at('/studio/graders')
    await flush()
    expect(c.querySelector('[data-testid="grader-row-hidden-tests"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="nav-studio"]')?.getAttribute('aria-current')).toBe('page')
    act(() => root?.unmount())
    document.body.innerHTML = ''
    const home = at('/studio')
    expect(home.querySelector('[data-testid="studio-graders-link"]')?.getAttribute('href')).toBe('/studio/graders')
  })

  it('shows the empty state when the API answers 503', async () => {
    signIn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'schema_not_ready' }), { status: 503 })))
    const c = at('/studio/graders')
    await flush()
    expect(c.querySelector('[data-testid="graders-empty"]')).not.toBeNull()
  })

  it('/studio/graders/:id loads the detail', async () => {
    signIn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(DETAIL), { status: 200 })))
    const c = at('/studio/graders/g-2')
    await flush()
    expect(c.querySelector('[data-testid="grader-detail"]')).not.toBeNull()
    expect(c.querySelector('[data-copy-command]')).not.toBeNull()
  })

  it('/studio/graders/:id shows an empty state on 404 and 503', async () => {
    signIn()
    for (const status of [404, 503]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'x' }), { status })))
      const c = at('/studio/graders/g-9')
      await flush()
      expect(c.querySelector('[data-testid="graders-empty"]')).not.toBeNull()
      act(() => root?.unmount())
      document.body.innerHTML = ''
    }
  })
})

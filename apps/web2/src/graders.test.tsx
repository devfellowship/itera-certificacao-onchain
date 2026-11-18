// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { setSessionToken } from './lib/api'
import { routes } from './routes'
import { GraderDetailView } from './studio/GraderDetailPage'
import { GraderDryRunPanel } from './studio/GraderDryRunPanel'
import { GraderLibraryView, GraderPanel, libraryView } from './studio/GraderLibraryPage'
import { useState } from 'react'
import type { GraderVersionDetail, GraderVersionItem } from './studio/graders'
import type { SourceState } from './studio/GraderSourceParts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
// The test API URL is the production API. A request that outlives its stub (the S10a source call of an in-app test
// fires after vi.unstubAllGlobals) must never reach the network: prod answers 401, and the 401 handler signs the
// NEXT test out ("Log in to continue"), a flake on main since #295. Network off for this file; each test stubs fetch.
globalThis.fetch = (async () => {
  throw new TypeError('network is off in this test file')
}) as typeof fetch
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
const NO_SRC: SourceState = { state: 'not-in-git' }
const FILE = { path: 'grade.py', blobSha: 'd'.repeat(40), text: "def grade():\n    return 'pass'\n" }
const CODE_SRC: Extract<SourceState, { state: 'ready' }> = {
  state: 'ready',
  data: {
    repo: 'devfellowship/dfl-evals', commit: 'e'.repeat(40), root: 'graders/rules/1.0.0', rule: 'tma-grader-code/1',
    files: [{ path: 'grade.py', blobSha: FILE.blobSha, bytes: 30 }, { path: 'lib/util.py', blobSha: 'f'.repeat(40), bytes: 6 }], file: FILE,
    proof: [
      { name: 'mutation-file-missing', kind: 'fixture', proves: 'a missing file fails', target: 'file_exists' },
      { name: 'exists-dropped', kind: 'code-mutation', proves: 'the exists check turns it red', target: 'mutation-file-missing' },
    ],
    judge: null,
  },
}
const FORBIDDEN = /\b(Save as|Save|Duplicate|Plant another bug|Run)\b/

function GraderPanelHarness() {
  const details = { 'g-1': { ...DETAIL, ...ITEMS[0]!, proof: { caught: 3, total: 3 } }, 'g-2': DETAIL }
  const [sel, setSel] = useState<string | null>(null)
  const { cur } = libraryView(ITEMS, null, sel)
  const d = cur && cur.versions[0] ? (details as Record<string, GraderVersionDetail>)[cur.versions[0].id] ?? null : null
  return (
    <>
      <GraderLibraryView items={ITEMS} details={details} sel={sel} onSel={setSel} />
      {cur && <GraderPanel r={cur} d={d} />}
    </>
  )
}

describe('S10 grader library', () => {
  it('renders a row per version with the short digest, full on hover, used-by, and a link to S10a', () => {
    const c = mount(<MemoryRouter><GraderLibraryView items={ITEMS} /></MemoryRouter>)
    const row = c.querySelector('[data-testid="grader-row-hidden-tests"]')!
    expect(row.textContent).toContain('hidden-tests@2.0.0')
    expect(row.querySelector(`[title="${SHA}"]`)?.textContent).toBe('hidden-tests@2.0.0')
    expect(row.querySelector('[data-testid="grader-used-by"]')?.textContent).toBe('4')
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/studio/graders/g-1')
    expect(c.querySelector('[data-testid="grader-row-rubric-judge"]')).not.toBeNull()
    expect(c.textContent).not.toMatch(FORBIDDEN)
  })
  it('groups the graders by kind (code, AI judges, human labels), one row per grader with its newest version', () => {
    const items: GraderVersionItem[] = [
      ...ITEMS,
      { ...ITEMS[0]!, id: 'g-0', semver: '1.0.0', createdAt: '2026-11-01T12:00:00.000Z', usedByCount: 9 },
      { ...ITEMS[0]!, id: 'l-1', graderId: 'label-async-wait-lifecycle', kind: 'human', semver: '1.0.0', usedByCount: 26 },
    ]
    const details = { 'g-1': { ...DETAIL, ...ITEMS[0]!, proof: { caught: 3, total: 3 } }, 'g-2': DETAIL }
    const c = mount(<MemoryRouter><GraderLibraryView items={items} details={details} /></MemoryRouter>)
    const groups = [...c.querySelectorAll('[data-testid^="grader-group-"]')].map((g) => g.getAttribute('data-testid'))
    expect(groups).toEqual(['grader-group-code', 'grader-group-judge', 'grader-group-human'])
    // hidden-tests has two versions: one row, the newest, with "+1".
    const rows = c.querySelectorAll('[data-testid="grader-row-hidden-tests"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('hidden-tests@2.0.0')
    expect(rows[0]!.textContent).toContain('+1')
    expect(rows[0]!.querySelector('[data-testid="grader-proven"]')?.textContent).toBe('3 of 3 caught')
    expect(rows[0]!.querySelector('[data-testid="grader-decide"]')?.textContent).toBe('yes')
    // The two known judges of the review queue have a row with no version yet; they link to S11a.
    const j = c.querySelector('[data-testid="grader-row-async-wait-lifecycle"]')!
    expect(j.textContent).toContain('no version yet')
    expect(j.querySelector('a')?.getAttribute('href')).toBe('/studio/calibration/async-wait-lifecycle')
    expect(c.querySelector('[data-testid="grader-row-external-block-handling"]')).not.toBeNull()
    // A judge version with TPR 0.9 / TNR 0.8 is not calibrated: "not yet".
    expect(c.querySelector('[data-testid="grader-row-rubric-judge"] [data-testid="grader-decide"]')?.textContent).toBe('not yet')
    // Human labels are the reference, with their label count.
    const h = c.querySelector('[data-testid="grader-row-label-async-wait-lifecycle"]')!
    expect(h.querySelector('[data-testid="grader-decide"]')?.textContent).toBe('reference')
    expect(h.textContent).toContain('26 labels')
    expect(c.textContent).not.toMatch(FORBIDDEN)
  })
  it('the side panel shows the selected grader; a click on a row selects it', () => {
    const c = mount(
      <MemoryRouter>
        <GraderPanelHarness />
      </MemoryRouter>,
    )
    expect(c.querySelector('[data-testid="grader-panel"]')?.getAttribute('data-grader')).toBe('hidden-tests')
    expect(c.querySelector('[data-testid="grader-trust"]')?.textContent).toContain('Safe to decide scores')
    expect(c.querySelector('[data-testid="grader-agreement"]')).toBeNull()
    act(() => (c.querySelector('[data-testid="grader-row-rubric-judge"]') as HTMLElement).click())
    expect(c.querySelector('[data-testid="grader-panel"]')?.getAttribute('data-grader')).toBe('rubric-judge')
    expect(c.querySelector('[data-testid="agree-tpr"]')?.textContent).toContain('90%')
    expect(c.querySelector('[data-testid="agree-tnr"]')?.textContent).toContain('80%')
    expect(c.querySelector('[data-testid="grader-panel-open"]')?.getAttribute('href')).toBe('/studio/graders/g-2')
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
  it('has the artboard tabs: Definition, Proof and Versions; the latest gradings stay in the side panel', () => {
    const versions: GraderVersionItem[] = [ITEMS[1]!, { ...ITEMS[1]!, id: 'g-old', semver: '0.9.0' }]
    const c = mount(<MemoryRouter><GraderDetailView g={DETAIL} versions={versions} /></MemoryRouter>)
    expect(c.querySelector('[data-testid="grader-tab-definition"]')?.getAttribute('aria-selected')).toBe('true')
    expect(c.querySelector('[data-testid="grader-tab-proof"]')?.textContent).toContain('3/3')
    act(() => (c.querySelector('[data-testid="grader-tab-proof"]') as HTMLElement).click())
    expect(c.querySelector('[data-testid="grader-facts"]')).toBeNull()
    act(() => (c.querySelector('[data-testid="grader-tab-versions"]') as HTMLElement).click())
    const list = c.querySelector('[data-testid="grader-versions"]')!
    expect(list.textContent).toContain('rubric-judge@0.9.0')
    expect(list.querySelector('a')?.getAttribute('href')).toBe('/studio/graders/g-old')
    expect(c.querySelectorAll('[data-testid="grader-recent-run"]')).toHaveLength(1)
    expect(c.querySelector('[data-testid="grader-recent-tally"]')?.textContent).toContain('1pass')
    expect(c.textContent).not.toMatch(FORBIDDEN)
  })
  it('copies the command with navigator.clipboard', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const c = mount(<MemoryRouter><GraderDetailView g={DETAIL} /></MemoryRouter>)
    await act(async () => { c.querySelector<HTMLButtonElement>('[data-copy-command] button')!.click() })
    expect(writeText).toHaveBeenCalledWith(c.querySelector('[data-copy-command]')!.getAttribute('data-copy-command'))
  })
})

describe('S10a grader code and planted bugs from Git (C5-SRC-SERVE)', () => {
  const G: GraderVersionDetail = { ...DETAIL, ...ITEMS[0]!, graderId: 'rules', semver: '1.0.0', proof: null }
  it('shows the code of the stored digest with line numbers and a tab per file; read only', () => {
    const c = mount(<MemoryRouter><GraderDetailView g={G} source={CODE_SRC} /></MemoryRouter>)
    const code = c.querySelector('[data-testid="grader-source-text"]')!
    expect(code.getAttribute('data-blob')).toBe(FILE.blobSha)
    expect([...code.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['def grade():', "    return 'pass'"])
    expect([...c.querySelectorAll('[data-testid="grader-source-file"]')].map((b) => b.textContent)).toEqual(['grade.py', 'lib/util.py'])
    expect(c.querySelector('[data-testid="grader-source-fact"]')?.textContent).toBe('devfellowship/dfl-evals@eeeeeee')
    expect(c.querySelector('[data-testid="grader-source-ref"]')?.textContent).toContain('graders/rules/1.0.0')
    expect(c.querySelectorAll('input, textarea, select, form')).toHaveLength(0)
    expect(c.textContent).not.toMatch(FORBIDDEN)
  })
  it('the Proof tab lists the planted bugs of the same commit and says no proof result is stored', () => {
    const c = mount(<MemoryRouter><GraderDetailView g={G} source={CODE_SRC} /></MemoryRouter>)
    expect(c.querySelector('[data-testid="grader-tab-proof"]')?.textContent).toBe('Proof2')
    act(() => (c.querySelector('[data-testid="grader-tab-proof"]') as HTMLElement).click())
    const bugs = [...c.querySelectorAll('[data-testid="grader-planted-bug"]')].map((b) => b.textContent)
    expect(bugs[0]).toContain('a missing file fails')
    expect(bugs[1]).toContain('code mutation exists-dropped')
    expect(c.querySelector('[data-testid="grader-proof-unstored"]')).not.toBeNull()
  })
  it('a digest that no commit gives shows the empty state, never a file', () => {
    const c = mount(<MemoryRouter><GraderDetailView g={G} source={NO_SRC} /></MemoryRouter>)
    expect(c.querySelector('[data-testid="grader-source-empty"]')?.textContent).toContain(SHA.slice(0, 12))
    expect(c.querySelector('[data-testid="grader-source"]')).toBeNull()
    expect(c.querySelector('[data-testid="grader-source-fact"]')?.textContent).toBe('not in Git')
  })
  it('loads the source from the API and asks for another file with ?path=', async () => {
    setSessionToken('tok-src')
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const file = url.includes('path=lib%2Futil.py') ? { path: 'lib/util.py', blobSha: 'f'.repeat(40), text: 'X = 1\n' } : FILE
      return new Response(JSON.stringify({ ...CODE_SRC.data, file }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const c = mount(<MemoryRouter><GraderDetailView g={G} /></MemoryRouter>)
    await flush()
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/grader-versions\/g-1\/source$/)
    expect(c.querySelector('[data-testid="grader-source-text"]')?.textContent).toContain('def grade():')
    act(() => (c.querySelectorAll('[data-testid="grader-source-file"]')[1] as HTMLElement).click())
    await flush()
    expect(String(fetchMock.mock.calls[1]![0])).toMatch(/\/source\?path=lib%2Futil\.py$/)
    expect(c.querySelector('[data-testid="grader-source-text"]')?.textContent).toBe('X = 1')
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

describe('S10a dry-run panel (C5-T10)', () => {
  const SERVE = 'http://127.0.0.1:8787/'
  const TOKEN = 'web2-session-token-fixture'
  const RESULT = { pass: true, score: 100, details: { format: 'tma-eval-dry-run/1', infra_ok: true, reason: null, grader: { id: 'rubric-judge', version: '1.0.0', kind: 'judge' }, output_sha256: SHA }, durationMs: 12, stored: false }
  const CODE: GraderVersionDetail = { ...DETAIL, graderId: 'says-ok', kind: 'code', judgeModelId: null }

  function type(el: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  async function dryRun(c: HTMLElement, output: string, expected?: string) {
    type(c.querySelector<HTMLTextAreaElement>('[data-testid="dry-run-output"]')!, output)
    if (expected !== undefined) type(c.querySelector<HTMLTextAreaElement>('[data-testid="dry-run-expected"]')!, expected)
    await act(async () => { c.querySelector<HTMLButtonElement>('[data-testid="dry-run-button"]')!.click() })
    await flush()
  }
  const noWriteControl = (c: HTMLElement) => {
    const names = [...c.querySelectorAll('button, a, [role="button"]')].map((el) => (el.textContent ?? '').trim())
    for (const bad of ['Save', 'Save as', 'Duplicate', 'Plant another bug', 'Run']) expect(names).not.toContain(bad)
    expect(c.textContent).not.toMatch(FORBIDDEN)
  }

  it('is hidden without VITE_TMA_STUDIO_SERVE_URL; the copy command stays', () => {
    const c = mount(<MemoryRouter><GraderDetailView g={DETAIL} /></MemoryRouter>)
    expect(c.querySelector('[data-testid="dry-run-panel"]')).toBeNull()
    expect(c.querySelector('[data-copy-command]')).not.toBeNull()
    const empty = mount(<MemoryRouter><GraderDetailView g={DETAIL} serveUrl="" dryRunEnabled /></MemoryRouter>)
    expect(empty.querySelector('[data-testid="dry-run-panel"]')).toBeNull()
  })

  it('is hidden when the serve URL is set but VITE_TMA_STUDIO_DRY_RUN is off (C5-T6); the copy command stays', () => {
    const off = mount(<MemoryRouter><GraderDetailView g={DETAIL} source={NO_SRC} serveUrl={SERVE} dryRunEnabled={false} /></MemoryRouter>)
    expect(off.querySelector('[data-testid="dry-run-panel"]')).toBeNull()
    expect(off.querySelector('[data-testid="dry-run-button"]')).toBeNull()
    expect(off.querySelector('[data-copy-command]')).not.toBeNull()
    // The build default: the flag is off unless VITE_TMA_STUDIO_DRY_RUN === 'true'.
    const dflt = mount(<MemoryRouter><GraderDetailView g={DETAIL} serveUrl={SERVE} /></MemoryRouter>)
    expect(dflt.querySelector('[data-testid="dry-run-panel"]')).toBeNull()
    expect(dflt.querySelector('[data-copy-command]')).not.toBeNull()
  })

  it('shows the result of a dry run; sends the session bearer and never logs it', async () => {
    setSessionToken(TOKEN)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(RESULT), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    const c = mount(<MemoryRouter><GraderDetailView g={DETAIL} source={NO_SRC} serveUrl={SERVE} dryRunEnabled /></MemoryRouter>)
    const panel = c.querySelector('[data-testid="dry-run-panel"]')!
    expect(panel.textContent).toContain('Try this grader (dry run)')
    expect(panel.textContent).toContain('Nothing is stored.')
    expect(c.querySelector('[data-copy-command]')).not.toBeNull()
    await dryRun(c, 'the answer is 42', '42')
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8787/grade/dry-run')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(init.body as string)).toEqual({ grader: 'rubric-judge@1.0.0', output: 'the answer is 42', expected: '42' })
    const result = c.querySelector('[data-testid="dry-run-result"]')!
    expect(result.getAttribute('data-outcome')).toBe('result')
    expect(result.querySelector('[data-testid="dry-run-verdict"]')?.textContent).toBe('pass')
    expect(result.textContent).toContain('100')
    for (const spy of logs) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(TOKEN)
    expect(c.textContent).not.toContain(TOKEN)
    noWriteControl(c)
    setSessionToken(null)
  })

  it('falls back to the stored session token when the API client has none', async () => {
    setSessionToken(null)
    saveSession({ token: TOKEN, user: { id: 'u-1', email: 'ana@example.com' } })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(RESULT), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const c = mount(<MemoryRouter><GraderDetailView g={DETAIL} source={NO_SRC} serveUrl={SERVE} dryRunEnabled /></MemoryRouter>)
    await dryRun(c, 'x')
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('shows the refusal of the server for a judge model that is not allowed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'judge_model_not_allowed', message: 'the judge model openrouter/zai/glm-5.3 is not allowed (A11 Q1 = B)', stored: false }), { status: 422 })))
    const c = mount(<MemoryRouter><GraderDetailView g={DETAIL} source={NO_SRC} serveUrl={SERVE} dryRunEnabled /></MemoryRouter>)
    await dryRun(c, 'x', 'x')
    const result = c.querySelector('[data-testid="dry-run-result"]')!
    expect(result.getAttribute('data-outcome')).toBe('refused')
    expect(result.getAttribute('role')).toBe('alert')
    expect(result.textContent).toContain('judge_model_not_allowed')
    expect(result.textContent).toContain('A11 Q1 = B')
    noWriteControl(c)
  })

  it('shows a network error state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const c = mount(<MemoryRouter><GraderDryRunPanel grader="says-ok@1.0.0" kind="code" serveUrl={SERVE} enabled getToken={() => null} /></MemoryRouter>)
    await dryRun(c, 'ok')
    const result = c.querySelector('[data-testid="dry-run-result"]')!
    expect(result.getAttribute('data-outcome')).toBe('network')
    expect(result.textContent).toMatch(/did not answer/)
  })

  it('a code grader shows the panel with no Save, Save as, Duplicate, Plant another bug or Run control', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...RESULT, pass: false, score: 0 }), { status: 200 })))
    const c = mount(<MemoryRouter><GraderDetailView g={CODE} source={NO_SRC} serveUrl={SERVE} dryRunEnabled /></MemoryRouter>)
    expect(c.querySelector('[data-testid="dry-run-panel"]')).not.toBeNull()
    const buttons = [...c.querySelectorAll('button')].map((b) => b.textContent)
    expect(buttons).toContain('Dry run')
    noWriteControl(c)
    await dryRun(c, 'nope')
    expect(c.querySelector('[data-testid="dry-run-verdict"]')?.textContent).toBe('fail')
    noWriteControl(c)
  })
})

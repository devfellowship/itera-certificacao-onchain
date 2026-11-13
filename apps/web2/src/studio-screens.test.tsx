// @vitest-environment jsdom
/**
 * S4 test case and S5 experiment (plan 20261112-tma-c5-studio-area-web2, task C5-T3), and S1 on the API.
 * Mounted through routes.tsx (the real layout, nav and session gate) with a stubbed fetch for
 * GET /eval-cases, GET /eval-cases/:id and GET /eval-runs.
 * Proves: S1 lists the API cases with links to S4; S4 shows the case, the L2 tag, the task link, the graders
 * (id@semver), the variants and their runs (links to the canonical run and evaluation pages), the task summary
 * with Before and Expected and no Outcome; S5 shows the base agent (agent link, New agent), its variants, the runs
 * per case x variant and builds the exact `tma eval` commands; both are read only (ADR-5: no Save, Save case,
 * Save draft, Save variant, Save as, Start an experiment or Run control) and carry [data-copy-command], which
 * copies with navigator.clipboard and keeps a selectable <pre>; a 503 or an empty list shows an empty state.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { routes } from './routes'
import { caseCommands, experimentScript } from './studio/eval-command'

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

const H = (c: string) => c.repeat(64)
const CASE = '8b6f3c2e-1d4a-4c8e-9f00-123456789abc'
const CASE2 = '8c6f3c2e-1d4a-4c8e-9f00-123456789abc'
const AGENT = 'ab6f3c2e-1d4a-4c8e-9f00-123456789abc'
const EVAL_B = 'e1000000-1d4a-4c8e-9f00-123456789abc'
const EVAL_V = 'e2000000-1d4a-4c8e-9f00-123456789abc'
const agentVersion = { harness: 'opencode', harnessVersion: '1.18.31', harnessRepoSha: null, modelId: 'opencode-go/deepseek-v4-pro', rulesSha256: null, skillsSha256: null, mcpManifestSha256: null, toolsSha256: null }
const baseline = { id: 'v-base', agentSha256: H('a'), agent: agentVersion, variantSha256: H('e'), label: 'baseline', changeKind: 'none', isBaseline: true }
const skill = { id: 'v-skill', agentSha256: H('a'), agent: agentVersion, variantSha256: '0123456789ab' + 'c'.repeat(52), label: 'skill v2', changeKind: 'skill', isBaseline: false }
const kase: Record<string, unknown> & { id: string; caseKey: string; taskId: string | null } = {
  id: CASE, caseKey: 'webhook-dup-001', manifestSha256: H('1'), originPinSha256: H('2'), mode: 'replay', useCaseKey: 'fix/prod-bug', taskId: 't-1',
  baselineVariantId: 'v-base', taskSummary: { before: 'Duplicate webhook events create two orders.', expected: 'One order per event id.' }, createdAt: '2026-11-12T12:00:00.000Z',
}
const kase2 = { ...kase, id: CASE2, caseKey: 'add-sso-001', useCaseKey: 'build/feature', mode: 'trace_review', taskId: null, taskSummary: null }
const listItem = (k: Record<string, unknown> & { taskId: string | null }, over: Record<string, unknown> = {}) => ({ ...k, taskSlug: k.taskId ? 'webhook-dup' : null, variantCount: 2, runCount: 3, lastRunAt: '2026-11-12T12:05:00.000Z', ...over })
const run = (id: string, seq: number, variant: typeof baseline, evaluationId: string, status = 'pass', caseId = CASE, caseKey = kase.caseKey) => ({
  id, evaluationId, agentId: AGENT, agentName: 'Alpha Agent', seq, status, score: status === 'pass' ? 100 : 40, infraOk: true, startedAt: '2026-11-12T12:01:00.000Z',
  caseId, caseKey, useCaseKey: 'fix/prod-bug', variant, predictionSha256: null,
})
const RUNS = [run('r-1', 1, baseline, EVAL_B), run('r-2', 2, baseline, EVAL_B, 'fail'), run('r-3', 1, skill, EVAL_V)]
const detail = {
  ...kase, taskSlug: 'webhook-dup', graders: [{ id: 'hidden-tests', semver: '2.0.0', kind: 'code' }],
  variants: [
    { ...baseline, predictionSha256: null, n: 2, pass: 1, fail: 1, infraErrors: 0, passRate: 0.5, meanScore: 70, evaluationIds: [EVAL_B] },
    { ...skill, predictionSha256: H('4'), n: 1, pass: 1, fail: 0, infraErrors: 0, passRate: 1, meanScore: 100, evaluationIds: [EVAL_V] },
  ],
}

type Api = { cases?: [number, unknown]; detail?: [number, unknown]; runs?: [number, unknown] }
const calls: string[] = []
function mountAt(path: string, a: Api = {}) {
  saveSession({ token: 'tok', user: { id: 'u-1', email: 'ana@example.com' } })
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      calls.push(url.pathname + url.search)
      if (url.pathname === '/eval-cases') return json(...(a.cases ?? [200, { cases: [listItem(kase), listItem(kase2, { runCount: 0 })], limit: 200, truncated: false }]))
      if (url.pathname.startsWith('/eval-cases/')) return json(...(a.detail ?? [200, detail]))
      if (url.pathname === '/eval-runs') return json(...(a.runs ?? [200, { runs: RUNS, limit: 500, truncated: false }]))
      return json(404, { error: 'not found' })
    }),
  )
  const c = document.createElement('div')
  c.id = 'root'
  document.body.appendChild(c)
  root = createRoot(c)
  act(() => root!.render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />))
  return c
}

const FORBIDDEN = ['Save', 'Save case', 'Save draft', 'Save variant', 'Save as', 'Start an experiment', 'Run']
/** ADR-5: no control with a forbidden text, and no such word in the page copy (the commands are lower case). */
function expectReadOnly(c: HTMLElement) {
  for (const el of c.querySelectorAll('button, a, [role="button"], input[type="submit"]')) {
    const text = (el.textContent ?? (el as HTMLInputElement).value ?? '').trim()
    for (const f of FORBIDDEN) expect(text.toLowerCase().startsWith(f.toLowerCase()), `control "${text}"`).toBe(false)
  }
  expect(c.querySelector('main')!.textContent).not.toMatch(/\b(Save|Run|Start an experiment)\b/)
  expect(c.querySelector('[data-copy-command]')).not.toBeNull()
}

describe('eval command builder', () => {
  it('writes the exact tma eval syntax for a replay case and a variant', () => {
    expect(caseCommands({ caseKey: 'k1', useCaseKey: 'fix/prod-bug', mode: 'replay' }, { agentId: AGENT, variant: { label: 'skill v2', changeKind: 'skill', variantSha256: skill.variantSha256 } })).toEqual([
      'tma eval case --case cases/fix/prod-bug/k1/case.json --dest eval/k1',
      'tma eval run --case eval/k1 --variant <variant.json> --repeat 3',
      `tma eval upload --case eval/k1 --variant-dir eval/k1/runs/0123456789ab --agent ${AGENT}`,
    ])
  })

  it('grades the recorded output of a trace_review case, and keeps placeholders when nothing is known', () => {
    expect(caseCommands({ caseKey: 'k2', useCaseKey: 'fix', mode: 'trace_review' })).toEqual([
      'tma eval case --case cases/fix/k2/case.json --dest eval/k2 --recorded <recorded.patch>',
      'tma eval grade --case eval/k2',
      'tma eval upload --case eval/k2 --variant-dir eval/k2/runs/recorded --agent <agent id>',
    ])
    expect(caseCommands({ caseKey: 'k3', useCaseKey: 'fix', mode: 'replay' }, { variant: { label: 'b', changeKind: 'none', variantSha256: H('e') } })[2]).toContain('--variant-dir eval/k3/runs/<variant folder>')
    expect(experimentScript({ cases: [] })).toContain('pick at least one test case')
  })

  it('uses only flags that the tma eval argument parser declares', () => {
    const script = experimentScript({ cases: [{ caseKey: 'a', useCaseKey: 'fix', mode: 'replay' }, { caseKey: 'b', useCaseKey: 'fix', mode: 'trace_review' }], agentId: AGENT })
    const flags = new Set([...script.matchAll(/ --([a-z-]+)/g)].map((m) => m[1]))
    // services/runner/src/cli/commands/eval.ts: case {case, dest, task-dir, recorded, clone}, run {case, variant, repeat},
    // grade {case, run, variant-dir}, upload {case, variant-dir, agent, base-agent, dry-run}.
    for (const f of flags) expect(['case', 'dest', 'recorded', 'variant', 'repeat', 'variant-dir', 'agent']).toContain(f)
  })
})

describe('S1 Studio home on GET /eval-cases', () => {
  it('lists the API cases by use case, each linked to its S4 page', async () => {
    const c = mountAt('/studio')
    await waitFor(() => c.querySelectorAll('[data-testid="studio-case-link"]').length === 2, 'cases')
    expect(calls).toContain('/eval-cases')
    const links = [...c.querySelectorAll<HTMLAnchorElement>('[data-testid="studio-case-link"]')].map((a) => a.getAttribute('href'))
    expect(links.sort()).toEqual([`/studio/cases/${CASE2}`, `/studio/cases/${CASE}`].sort())
    expect(c.querySelector('[data-testid="use-case-fix/prod-bug"]')?.textContent).toContain('webhook-dup-001')
    expect(c.querySelectorAll('[data-testid="studio-home"] button')).toHaveLength(0)
  })

  it('/studio/cases?task= keeps the cases of that task', async () => {
    const c = mountAt('/studio/cases?task=webhook-dup')
    await waitFor(() => c.querySelectorAll('[data-testid="studio-case-link"]').length === 1, 'filtered cases')
    expect(c.querySelector('[data-testid="studio-task-filter"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="nav-studio"]')?.getAttribute('aria-current')).toBe('page')
  })

  it('shows the empty state on 503 schema_not_ready and on an empty list', async () => {
    const c = mountAt('/studio', { cases: [503, { error: 'schema_not_ready' }] })
    await waitFor(() => !!c.querySelector('[data-testid="studio-empty"]'), 'empty state')
    expect(c.querySelector('[data-testid="studio-load-error"]')?.textContent).toContain('not migrated')
    act(() => root?.unmount())
    document.body.innerHTML = ''
    const e = mountAt('/studio', { cases: [200, { cases: [], limit: 200, truncated: false }] })
    await waitFor(() => !!e.querySelector('[data-testid="studio-empty"]'), 'empty list')
  })
})

describe('S4 test case', () => {
  it('shows the case, its task, graders, variants and runs with canonical links, read only', async () => {
    const c = mountAt(`/studio/cases/${CASE}`)
    await waitFor(() => !!c.querySelector('[data-testid="case-key"]'), 'case')
    expect(calls).toContain(`/eval-cases/${CASE}`)
    expect(calls).toContain(`/eval-runs?case=${CASE}`)
    expect(c.querySelector('[data-testid="case-key"]')?.textContent).toBe('webhook-dup-001')
    expect(c.querySelector('[data-testid="case-use-case"]')?.textContent).toContain('prod-bug')
    expect(c.querySelector('[data-testid="case-mode"]')?.textContent).toBe('replay')
    expect(c.querySelector('[data-testid="case-task-link"]')?.getAttribute('href')).toBe('/tasks/webhook-dup')
    expect([...c.querySelectorAll('[data-testid="case-grader"]')].map((g) => g.textContent)).toEqual(['hidden-tests@2.0.0'])
    expect(c.querySelectorAll('[data-testid="case-variant"]')).toHaveLength(2)
    const runLinks = [...c.querySelectorAll('[data-testid="case-run-link"]')].map((a) => a.getAttribute('href'))
    expect(runLinks).toEqual([`/evaluations/${EVAL_B}/runs/r-1`, `/evaluations/${EVAL_B}/runs/r-2`, `/evaluations/${EVAL_V}/runs/r-3`])
    const evalLinks = [...c.querySelectorAll('[data-testid="case-evaluation-link"]')].map((a) => a.getAttribute('href'))
    expect(evalLinks).toEqual([`/evaluations/${EVAL_B}`, `/evaluations/${EVAL_V}`])
    expect(c.querySelector('[data-testid="case-experiment-link"]')?.getAttribute('href')).toBe(`/studio/experiments/new?case=${CASE}&agent=${AGENT}`)
    expect(c.querySelector('[data-testid="nav-studio"]')?.getAttribute('aria-current')).toBe('page')
    expectReadOnly(c)
  })

  it('the task summary shows Before and Expected only, never an Outcome', async () => {
    const c = mountAt(`/studio/cases/${CASE}`)
    await waitFor(() => !!c.querySelector('[data-task-summary]'), 'summary')
    const s = c.querySelector('[data-task-summary]')!
    expect([...s.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Before', 'Expected'])
    expect(s.textContent).toContain('Duplicate webhook events create two orders.')
    expect(s.textContent).toContain('One order per event id.')
    expect(c.querySelector('main')!.textContent).not.toMatch(/outcome/i)
  })

  it('copies the exact command with navigator.clipboard, and keeps a selectable <pre>', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const c = mountAt(`/studio/cases/${CASE}`)
    await waitFor(() => !!c.querySelector('[data-testid="case-copy-command"]'), 'copy')
    const box = c.querySelector('[data-testid="case-copy-command"]')!
    expect(box.hasAttribute('data-copy-command')).toBe(true)
    const text = box.querySelector('pre')!.textContent!
    expect(text).toBe(
      [
        'tma eval case --case cases/fix/prod-bug/webhook-dup-001/case.json --dest eval/webhook-dup-001',
        'tma eval run --case eval/webhook-dup-001 --variant <variant.json> --repeat 3',
        `tma eval upload --case eval/webhook-dup-001 --variant-dir eval/webhook-dup-001/runs/<variant folder> --agent ${AGENT}`,
      ].join('\n'),
    )
    await act(async () => {
      box.querySelector<HTMLButtonElement>('button')!.click()
    })
    expect(writeText).toHaveBeenCalledWith(text)
    expect(box.querySelector('button')!.textContent).toBe('Copied')
  })

  it('a blocked clipboard leaves the selectable command and says so', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) } })
    const c = mountAt(`/studio/cases/${CASE}`)
    await waitFor(() => !!c.querySelector('[data-testid="case-copy-command"]'), 'copy')
    await act(async () => {
      c.querySelector<HTMLButtonElement>('[data-testid="case-copy-command"] button')!.click()
    })
    expect(c.querySelector('[data-testid="copy-command-blocked"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="copy-command-text"]')?.textContent).toContain('tma eval case')
  })

  it('shows an empty state (still read only, still a copy command) on 404 and 503', async () => {
    const c = mountAt(`/studio/cases/${CASE}`, { detail: [404, { error: 'eval case not found' }] })
    await waitFor(() => !!c.querySelector('[data-testid="studio-empty"]'), '404')
    expect(c.textContent).toContain('Test case not found')
    expectReadOnly(c)
    act(() => root?.unmount())
    document.body.innerHTML = ''
    const d = mountAt(`/studio/cases/${CASE}`, { detail: [503, { error: 'schema_not_ready' }], runs: [503, { error: 'schema_not_ready' }] })
    await waitFor(() => !!d.querySelector('[data-testid="studio-empty"]'), '503')
    expect(d.querySelector('[data-testid="studio-load-error"]')?.textContent).toContain('not migrated')
  })
})

describe('S5 experiment', () => {
  it('shows the base agent, its variants, the runs per case x variant, read only', async () => {
    const c = mountAt(`/studio/experiments/new?agent=${AGENT}`)
    await waitFor(() => !!c.querySelector('[data-testid="experiment-variant"]'), 'variants')
    expect(calls).toContain(`/eval-runs?agent=${AGENT}`)
    expect(c.querySelector('[data-testid="experiment-agent-link"]')?.getAttribute('href')).toBe(`/agents/${AGENT}`)
    expect(c.querySelector('[data-testid="experiment-agent-link"]')?.textContent).toBe('Alpha Agent')
    expect(c.querySelector('[data-testid="experiment-new-agent"]')?.getAttribute('href')).toBe('/agents/new')
    expect(c.querySelector('[data-testid="experiment-base-agent"]')?.textContent).toContain('opencode-go/deepseek-v4-pro')
    const variants = [...c.querySelectorAll('[data-testid="experiment-variant"]')].map((v) => v.textContent)
    expect(variants).toHaveLength(2)
    expect(variants.join(' ')).toContain('skill change')
    expect(variants.join(' ')).toContain('base agent unchanged')
    expect(c.querySelectorAll('[data-testid="experiment-cell"]')).toHaveLength(2)
    expect([...c.querySelectorAll('[data-testid="experiment-run-link"]')].map((a) => a.getAttribute('href'))).toContain(`/evaluations/${EVAL_V}/runs/r-3`)
    expect([...c.querySelectorAll('[data-testid="experiment-evaluation-link"]')].map((a) => a.getAttribute('href'))).toContain(`/evaluations/${EVAL_B}`)
    expect(c.querySelector('[data-testid="nav-studio"]')?.getAttribute('aria-current')).toBe('page')
    expectReadOnly(c)
  })

  it('builds the commands of one base agent, one variant and a dataset', async () => {
    const c = mountAt(`/studio/experiments/new?agent=${AGENT}`)
    await waitFor(() => !!c.querySelector('[data-testid="experiment-variant"]'), 'variants')
    const pre = () => c.querySelector('[data-testid="experiment-copy-command"] pre')!.textContent!
    // Default: the first changed variant, and the cases this base agent ran on.
    expect(pre()).toContain('# variant: skill v2 (skill, 0123456789ab)')
    expect(pre()).toContain(`tma eval upload --case eval/webhook-dup-001 --variant-dir eval/webhook-dup-001/runs/0123456789ab --agent ${AGENT}`)
    expect(pre()).not.toContain('add-sso-001')
    // Add the trace_review case to the dataset.
    const sso = [...c.querySelectorAll('[data-testid="experiment-dataset-case"]')].find((li) => li.textContent!.includes('add-sso-001'))!
    act(() => sso.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(pre()).toContain('tma eval case --case cases/build/feature/add-sso-001/case.json --dest eval/add-sso-001 --recorded <recorded.patch>')
    expect(pre()).toContain(`tma eval upload --case eval/add-sso-001 --variant-dir eval/add-sso-001/runs/recorded --agent ${AGENT}`)
    // Pick the baseline variant: its folder is a placeholder (the uploaded digest is the empty diff).
    const base = [...c.querySelectorAll('[data-testid="experiment-variant"]')].find((l) => l.textContent!.includes('base agent unchanged'))!
    act(() => base.querySelector<HTMLInputElement>('input[type="radio"]')!.click())
    expect(pre()).toContain('# variant: baseline (none, the base agent unchanged)')
    expect(pre()).toContain('--variant-dir eval/webhook-dup-001/runs/<variant folder>')
    expectReadOnly(c)
  })

  it('the ?case= filter narrows the runs and preselects the dataset', async () => {
    const c = mountAt(`/studio/experiments/new?case=${CASE2}`, { runs: [200, { runs: [run('r-9', 1, skill, EVAL_V, 'pass', CASE2, 'add-sso-001')], limit: 500, truncated: false }] })
    await waitFor(() => !!c.querySelector('[data-testid="experiment-variant"]'), 'variants')
    expect(calls).toContain(`/eval-runs?case=${CASE2}`)
    const pre = c.querySelector('[data-testid="experiment-copy-command"] pre')!.textContent!
    expect(pre).toContain('eval/add-sso-001')
    expect(pre).not.toContain('webhook-dup-001')
  })

  it('shows an empty state with the builder on no runs and on 503', async () => {
    const c = mountAt('/studio/experiments/new', { runs: [200, { runs: [], limit: 500, truncated: false }] })
    await waitFor(() => !!c.querySelector('[data-testid="experiment-empty"]'), 'empty')
    expect(c.querySelector('[data-testid="experiment-new-agent"]')).not.toBeNull()
    expectReadOnly(c)
    act(() => root?.unmount())
    document.body.innerHTML = ''
    const d = mountAt('/studio/experiments/new', { runs: [503, { error: 'schema_not_ready' }], cases: [503, { error: 'schema_not_ready' }] })
    await waitFor(() => !!d.querySelector('[data-testid="studio-empty"]'), '503')
    expect(d.querySelector('[data-testid="studio-load-error"]')?.textContent).toContain('not migrated')
    expectReadOnly(d)
  })
})

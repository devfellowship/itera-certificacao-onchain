// @vitest-environment jsdom
/**
 * S6 experiment result and S7 result diff (plan 20261112-tma-c5-studio-area-web2, task C5-T4).
 * Mounted through routes.tsx (the real layout, nav and session gate) with a stubbed fetch.
 * Proves: S6 draws the matrix of 1 case x 2 variants (baseline + 1) x 3 repeats with one infra failure (repeats, pass
 * count, interval text, infra failures apart, mean, origin marker, the case-compare verdict with its rule text), links
 * each cell to its canonical evaluation page and each variant to S7, and copies `tma eval diff`; S7 shows the two runs
 * per data type with the run page renderers, the Expected column, the aligned steps and links to both canonical run
 * pages, from ?case&base&variant, ?baseRun&run and ?evaluation (the "Compare with baseline" link); both are read only
 * (ADR-5), mark Studio active in the App Nav, and show a clear state on empty, 503 and 404.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { routes } from './routes'
import { RELATIVE_RULE_TEXT } from './tma/compare/case-compare'

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
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}; body: ${document.body.innerHTML.slice(0, 1200)}`)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}
const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const qa = (c: HTMLElement, id: string) => Array.from(c.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`))

const H = (ch: string) => ch.repeat(64)
const CASE = '8b6f3c2e-1d4a-4c8e-9f00-123456789abc'
const AGENT = 'ab6f3c2e-1d4a-4c8e-9f00-123456789abc'
const EVAL_B = 'e1000000-1d4a-4c8e-9f00-123456789abc'
const EVAL_V = 'e2000000-1d4a-4c8e-9f00-123456789abc'
const agentVersion = { harness: 'opencode', harnessVersion: '1.18.31', harnessRepoSha: null, modelId: 'opencode-go/deepseek-v4-pro', rulesSha256: null, skillsSha256: null, mcpManifestSha256: null, toolsSha256: null }
const baseline = { id: 'v-base', agentSha256: H('a'), agent: agentVersion, variantSha256: H('e'), label: 'baseline', changeKind: 'none', isBaseline: true }
const skill = { id: 'v-skill', agentSha256: H('a'), agent: agentVersion, variantSha256: '0123456789ab' + 'c'.repeat(52), label: 'skill v2', changeKind: 'skill', isBaseline: false }
const row = (id: string, seq: number, variant: typeof baseline, evaluationId: string, status: string, score: number | null, minute: number) => ({
  id, evaluationId, agentId: AGENT, agentName: 'Alpha Agent', seq, status, score, infraOk: status !== 'infra_error', resultOrigin: 'self_declared', hardGatesOk: status === 'pass' ? true : status === 'infra_error' ? null : false,
  startedAt: `2026-11-12T12:0${minute}:00.000Z`, caseId: CASE, caseKey: 'webhook-dup-001', useCaseKey: 'fix/prod-bug', variant, predictionSha256: null,
})
/** 1 case x 2 variants x 3 repeats; the variant has one infra failure. */
const RUNS = [
  row('rb-1', 1, baseline, EVAL_B, 'pass', 100, 1),
  row('rb-2', 2, baseline, EVAL_B, 'pass', 90, 2),
  row('rb-3', 3, baseline, EVAL_B, 'fail', 40, 3),
  row('rv-1', 1, skill, EVAL_V, 'pass', 100, 4),
  row('rv-2', 2, skill, EVAL_V, 'pass', 95, 5),
  row('rv-3', 3, skill, EVAL_V, 'infra_error', null, 6),
]
const kase = {
  id: CASE, caseKey: 'webhook-dup-001', manifestSha256: H('1'), originPinSha256: null, mode: 'replay', useCaseKey: 'fix/prod-bug', taskId: null, baselineVariantId: 'v-base',
  taskSummary: { before: 'Duplicate webhook events create two orders.', expected: 'One order per event id.' }, createdAt: '2026-11-12T12:00:00.000Z',
}
const detail = { ...kase, taskSlug: null, graders: [], variants: [] }

const patch = (file: string, lines: string[]) => [`diff --git a/${file} b/${file}`, 'new file mode 100644', '--- /dev/null', `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n')
const MOD = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n')
const runBody = (runId: string, evaluationId: string, variant: typeof baseline, p: string, status = 'pass') => ({
  runId, status, phase: 'done', scoreTotal: status === 'pass' ? 100 : 40, resultOrigin: 'self_declared', evaluationId, case: kase, variant, patch: p, proof: null,
})
const RUN_B = runBody('rb-2', EVAL_B, baseline, `${MOD}\n${patch('out/data.json', ['{"orders": 2}'])}`)
const RUN_V = runBody('rv-2', EVAL_V, skill, `${MOD}\n${patch('out/report.md', ['# Report', 'One order.'])}`)
const action = (seq: number, tool: string, target: string | null) => ({ seq, tool, target, ok: true, occurredAt: '2026-11-12T12:00:00.000Z' })
const ACTIONS: Record<string, unknown[]> = {
  'rb-2': [action(1, 'Read', 'src/a.ts'), action(2, 'Bash', 'npm test'), action(3, 'TodoWrite', null)],
  'rv-2': [action(1, 'Read', 'src/a.ts'), action(2, 'Edit', 'src/a.ts'), action(3, 'Bash', 'npm run test')],
}

type Api = { runs?: [number, unknown]; evaluation?: [number, unknown]; runB?: [number, unknown] }
const calls: string[] = []
function mountAt(path: string, a: Api = {}) {
  saveSession({ token: 'tok', user: { id: 'u-1', email: 'ana@example.com' } })
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const p = url.pathname
      calls.push(p + url.search)
      if (p === '/eval-runs') return json(...(a.runs ?? [200, { runs: RUNS, limit: 500, truncated: false }]))
      if (p === `/eval-cases/${CASE}`) return json(200, detail)
      if (p === `/evaluations/${EVAL_V}`) return json(...(a.evaluation ?? [200, { id: EVAL_V, case: kase, variant: skill, tasks: [{ runId: 'rv-2' }] }]))
      const m = p.match(/^\/runs\/([^/]+)(\/actions|\/artifacts)?$/)
      if (m) {
        const [, id, sub] = m
        if (sub === '/actions') return json(200, { runId: id, afterSeq: 0, actions: ACTIONS[id!] ?? [], hasMore: false, nextAfterSeq: 0 })
        if (sub === '/artifacts') return json(404, { error: 'run not found' })
        if (id!.startsWith('rb-')) return json(...(a.runB ?? [200, { ...RUN_B, runId: id }]))
        if (id!.startsWith('rv-')) return json(200, { ...RUN_V, runId: id })
      }
      return json(404, { error: 'not found' })
    }),
  )
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() => root!.render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />))
  return c
}

const FORBIDDEN = ['Save', 'Save as', 'Start an experiment', 'Run']
/** ADR-5: no control with a forbidden text, and no such word in the page copy. */
function expectReadOnly(c: HTMLElement) {
  for (const el of c.querySelectorAll('button, a, [role="button"], input[type="submit"]')) {
    const text = (el.textContent ?? '').trim()
    for (const f of FORBIDDEN) expect(text.toLowerCase().startsWith(f.toLowerCase()), `control "${text}"`).toBe(false)
  }
  expect(c.querySelector('main')!.textContent).not.toMatch(/\b(Save|Run|Start an experiment)\b/)
}

describe('S6 experiment result', () => {
  it('draws the matrix: counts, interval, infra failures apart, origin, verdict, and canonical links', async () => {
    const c = mountAt(`/studio/experiments?agent=${AGENT}`)
    await waitFor(() => qa(c, 's6-cell').length === 2, 'the cells')
    expect(calls).toContain(`/eval-runs?agent=${AGENT}`)
    expect(q(c, 's6-matrix')).not.toBeNull()
    expect(qa(c, 's6-row')).toHaveLength(1)
    expect(qa(c, 's6-variant-head').map((h) => h.textContent)).toEqual(['baseline · base agent unchanged', 'skill v2 · skill change'])
    const [b, v] = qa(c, 's6-cell')
    // Baseline: 3 repeats, 2 of 3 pass, Wilson 90 % 25.4–92.2.
    expect(b!.dataset.variant).toBe('v-base')
    expect(q(b!, 's6-n')!.textContent).toBe('3')
    expect(q(b!, 's6-pass')!.textContent).toBe('2 of 3')
    expect(q(b!, 's6-cell-link')!.textContent).toBe('67% (90% CI 25–92%)')
    expect(q(b!, 's6-mean')!.textContent).toBe('76.7')
    expect(q(b!, 's6-infra')!.textContent).toBe('0')
    expect(b!.textContent).toContain('baseline')
    expect(q(b!, 's6-verdict')).toBeNull()
    // Variant: 3 repeats, 1 infra failure counted apart (not a fail): 2 of 2 pass.
    expect(q(v!, 's6-n')!.textContent).toBe('3')
    expect(q(v!, 's6-infra')!.textContent).toBe('1')
    expect(q(v!, 's6-pass')!.textContent).toBe('2 of 2')
    expect(q(v!, 's6-cell-link')!.textContent).toBe('100% (90% CI 43–100%)')
    expect(q(v!, 's6-mean')!.textContent).toBe('97.5')
    // Origin: uploaded runs are self-declared.
    expect(q(v!, 's6-origin')!.dataset.origin).toBe('self_declared')
    // Verdict vs the baseline: the case-compare rule refuses with 3 runs per side; the rule text is in the tooltip.
    const verdict = q(v!, 's6-verdict')!
    expect(verdict.dataset.verdict).toBe('refused')
    expect(verdict.textContent).toBe('vs baseline: no verdict')
    expect(v!.textContent).toContain(RELATIVE_RULE_TEXT)
    // Canonical links: each cell to /evaluations/:eid, each variant to S7 against the baseline.
    expect(q(b!, 's6-cell-link')!.getAttribute('href')).toBe(`/evaluations/${EVAL_B}`)
    expect(q(v!, 's6-cell-link')!.getAttribute('href')).toBe(`/evaluations/${EVAL_V}`)
    expect(qa(c, 's6-diff-link').map((a) => a.getAttribute('href'))).toEqual([`/studio/diff?case=${CASE}&base=v-base&variant=v-skill`])
    // The kit's compare command for the pair.
    const copy = c.querySelector<HTMLElement>('[data-copy-command]')!
    expect(copy.textContent).toContain('tma eval diff eval/webhook-dup-001/runs/<baseline folder> eval/webhook-dup-001/runs/0123456789ab')
    expectReadOnly(c)
    expect(q(c, 'nav-studio')!.getAttribute('aria-current')).toBe('page')
  })

  it('an infra failure counts apart even when the API sends infraOk false with status fail', async () => {
    const runs = RUNS.map((r) => (r.id === 'rv-3' ? { ...r, status: 'fail', infraOk: false, score: 0 } : r))
    const c = mountAt('/studio/experiments', { runs: [200, { runs, limit: 500, truncated: false }] })
    await waitFor(() => qa(c, 's6-cell').length === 2, 'the cells')
    const v = qa(c, 's6-cell')[1]!
    expect(q(v, 's6-infra')!.textContent).toBe('1')
    expect(q(v, 's6-pass')!.textContent).toBe('2 of 2')
  })

  it('an empty list, a 503 and a 404 show a clear state, not a crash', async () => {
    let c = mountAt(`/studio/experiments?case=${CASE}`, { runs: [200, { runs: [], limit: 500, truncated: false }] })
    await waitFor(() => q(c, 's6-empty') !== null, 'the empty state')
    expect(q(c, 's6-empty')!.textContent).toContain('on this case')
    expect(q(c, 's6-matrix')).toBeNull()
    expectReadOnly(c)
    act(() => root?.unmount())
    document.body.innerHTML = ''
    c = mountAt('/studio/experiments', { runs: [503, { error: 'schema_not_ready' }] })
    await waitFor(() => q(c, 'studio-load-error') !== null, 'the 503 state')
    expect(q(c, 'studio-load-error')!.textContent).toContain('not migrated')
    act(() => root?.unmount())
    document.body.innerHTML = ''
    c = mountAt('/studio/experiments', { runs: [404, { error: 'not found' }] })
    await waitFor(() => q(c, 'studio-load-error') !== null, 'the 404 state')
    expect(q(c, 'studio-load-error')!.textContent).toContain('Not found')
  })
})

describe('S7 result diff', () => {
  async function ready(path: string, a: Api = {}) {
    const c = mountAt(path, a)
    await waitFor(() => qa(c, 's7-row').length > 0 && qa(c, 's7-step').length > 0, 'the diff rows and steps')
    return c
  }

  it('from ?case&base&variant: rows per data type, the Expected column, aligned steps, canonical links', async () => {
    const c = await ready(`/studio/diff?case=${CASE}&base=v-base&variant=v-skill`)
    expect(calls).toContain(`/eval-runs?case=${CASE}`)
    // The newest counted run of each variant: rb-3 is the newest baseline run (a fail, still counted); rv-3 is an infra failure, so rv-2.
    expect(calls).toContain('/runs/rb-3')
    expect(calls).toContain('/runs/rv-2')
    expect(q(c, 'studio-diff-page')).not.toBeNull()
  })

  it('from ?baseRun&run: rows per data type rendered by the run page renderers, Expected, steps, links', async () => {
    const c = await ready('/studio/diff?baseRun=rb-2&run=rv-2')
    expect(qa(c, 's7-row').map((r) => r.dataset.kind)).toEqual(['diff', 'json', 'markdown'])
    const [diff, js, md] = qa(c, 's7-row')
    // The diff row: both runs modify src/a.ts and carry patch.diff; rendered as ArtifactCard (the run page component).
    expect(qa(diff!, 's7-base-artifact').map((a) => a.dataset.path)).toEqual(['patch.diff', 'src/a.ts'])
    expect(qa(diff!, 's7-variant-artifact').map((a) => a.dataset.path)).toEqual(['patch.diff', 'src/a.ts'])
    // JSON: both run records; the base also adds out/data.json. Markdown: only the variant adds out/report.md.
    expect(qa(js!, 's7-base-artifact').map((a) => a.dataset.path)).toEqual(['run.json', 'out/data.json'])
    expect(qa(js!, 's7-variant-artifact').map((a) => a.dataset.path)).toEqual(['run.json'])
    expect(qa(md!, 's7-base-artifact')).toHaveLength(0)
    expect(md!.textContent).toContain('none')
    const report = q(md!, 's7-variant-artifact')!
    expect(report.dataset.kind).toBe('markdown')
    expect(report.querySelector('h1')?.textContent).toBe('Report')
    // Expected vs agent: the case's expected output, one column spanning the rows.
    expect(q(c, 's7-expected-head')!.textContent).toBe('Expected vs agent')
    expect(q(c, 's7-expected')!.getAttribute('rowspan')).toBe('3')
    expect(q(c, 's7-expected-text')!.textContent).toContain('One order per event id.')
    // Aligned steps (step-alignment.ts).
    expect(qa(c, 's7-step').map((r) => r.dataset.label)).toEqual(['same', 'inserted', 'changed', 'removed'])
    expect(qa(c, 's7-step')[2]!.textContent).toContain('npm run test')
    // Links back to both runs' canonical pages.
    expect(q(c, 's7-base-run-link')!.getAttribute('href')).toBe(`/evaluations/${EVAL_B}/runs/rb-2`)
    expect(q(c, 's7-variant-run-link')!.getAttribute('href')).toBe(`/evaluations/${EVAL_V}/runs/rv-2`)
    expect(q(c, 's7-base-evaluation-link')!.getAttribute('href')).toBe(`/evaluations/${EVAL_B}`)
    expect(c.querySelector('[data-copy-command]')!.textContent).toContain('tma eval diff')
    expectReadOnly(c)
    expect(q(c, 'nav-studio')!.getAttribute('aria-current')).toBe('page')
  })

  it('from ?evaluation (the "Compare with baseline" link): the run of that evaluation vs the newest baseline run', async () => {
    const c = await ready(`/studio/diff?evaluation=${EVAL_V}`)
    expect(calls).toContain(`/evaluations/${EVAL_V}`)
    expect(calls).toContain(`/eval-runs?case=${CASE}`)
    expect(calls).toContain('/runs/rv-2')
    expect(calls).toContain('/runs/rb-3')
    expect(q(c, 's7-variant-head')!.textContent).toContain('skill v2')
  })

  it('refusals and errors: a baseline evaluation, no query, a 404 run, a 503 store', async () => {
    let c = mountAt(`/studio/diff?evaluation=${EVAL_V}`, { evaluation: [200, { id: EVAL_V, case: kase, variant: baseline, tasks: [{ runId: 'rb-2' }] }] })
    await waitFor(() => q(c, 'studio-load-error') !== null, 'the baseline refusal')
    expect(q(c, 'studio-load-error')!.textContent).toContain('is the baseline')
    act(() => root?.unmount())
    document.body.innerHTML = ''
    c = mountAt('/studio/diff')
    await waitFor(() => q(c, 'studio-load-error') !== null, 'the empty query state')
    expect(q(c, 'studio-load-error')!.textContent).toContain('Pick a pair')
    expectReadOnly(c)
    act(() => root?.unmount())
    document.body.innerHTML = ''
    c = mountAt('/studio/diff?baseRun=rb-2&run=rv-2', { runB: [404, { error: 'run not found' }] })
    await waitFor(() => q(c, 'studio-load-error') !== null, 'the 404 state')
    expect(q(c, 'studio-load-error')!.textContent).toContain('Not found')
    act(() => root?.unmount())
    document.body.innerHTML = ''
    c = mountAt(`/studio/diff?case=${CASE}&base=v-base&variant=v-skill`, { runs: [503, { error: 'schema_not_ready' }] })
    await waitFor(() => q(c, 'studio-load-error') !== null, 'the 503 state')
    expect(q(c, 'studio-load-error')!.textContent).toContain('not migrated')
  })
})

/** C5-T4: the S6 cell helper (counts, infra failures apart, Wilson 90 % text, origin), the matrix and the verdict mapping. */
import { describe, expect, it } from 'vitest'
import type { EvalRun, EvalVariant } from '../lib/api/types'
import { RELATIVE_RULE_TEXT } from '../tma/compare/case-compare'
import { buildMatrix, cellStats, isInfraFailure, passRateText, toCaseRuns, verdictOf } from './experiment-matrix'
import { diffCommand } from './eval-command'
import { alignmentWord, newestRunOf, pairFromVariants, rowsByKind, stepsOfActions } from './result-diff'
import { alignSteps } from '../tma/compare/step-alignment'

const agent = { harness: 'opencode', harnessVersion: null, harnessRepoSha: null, modelId: 'm', rulesSha256: null, skillsSha256: null, mcpManifestSha256: null, toolsSha256: null }
const base: EvalVariant = { id: 'v-base', agentSha256: 'a'.repeat(64), agent, variantSha256: 'e'.repeat(64), label: 'baseline', changeKind: 'none', isBaseline: true }
const skill: EvalVariant = { id: 'v-skill', agentSha256: 'a'.repeat(64), agent, variantSha256: '0123456789ab' + 'c'.repeat(52), label: 'skill v2', changeKind: 'skill', isBaseline: false }
let n = 0
const run = (variant: EvalVariant, status: string, score: number | null, over: Partial<EvalRun> = {}): EvalRun => ({
  id: `r-${++n}`, evaluationId: `e-${variant.id}`, agentId: 'ag', agentName: 'A', seq: n, status, score, infraOk: status === 'infra_error' ? false : true,
  startedAt: `2026-11-12T12:0${n % 10}:00.000Z`, caseId: 'c-1', caseKey: 'webhook-dup-001', useCaseKey: 'fix/prod-bug', variant, predictionSha256: null,
  resultOrigin: 'self_declared', hardGatesOk: status === 'pass', ...over,
})

describe('cellStats', () => {
  it('counts an infra failure apart: it is not a fail and leaves the rate, the interval and the mean', () => {
    const s = cellStats([run(skill, 'pass', 100), run(skill, 'pass', 95), run(skill, 'infra_error', null)])
    expect(s).toMatchObject({ n: 3, infra: 1, counted: 2, pass: 2, fail: 0, passRate: 1, meanScore: 97.5, origin: 'self-declared' })
    expect(s.interval).toEqual({ lo: 42.5, hi: 100 })
    expect(passRateText(s)).toBe('100% (90% CI 43–100%)')
  })

  it('infraOk false is an infra failure even with another status', () => {
    expect(isInfraFailure({ infraOk: false, status: 'fail' })).toBe(true)
    expect(isInfraFailure({ infraOk: null, status: 'fail' })).toBe(false)
    expect(cellStats([run(base, 'fail', 10, { infraOk: false })])).toMatchObject({ infra: 1, counted: 0, fail: 0, passRate: null, interval: null })
    expect(passRateText(cellStats([run(base, 'infra_error', null)]))).toBe('no counted run')
  })

  it('2 of 3: the Wilson 90 % interval 25.4–92.2', () => {
    const s = cellStats([run(base, 'pass', 100), run(base, 'pass', 90), run(base, 'fail', 40)])
    expect(s.interval).toEqual({ lo: 25.4, hi: 92.2 })
    expect(passRateText(s)).toBe('67% (90% CI 25–92%)')
  })

  it('origin: verified when every run is hosted, mixed when both, null when the API sends none', () => {
    expect(cellStats([run(base, 'pass', 100, { resultOrigin: 'hosted' })]).origin).toBe('verified')
    expect(cellStats([run(base, 'pass', 100, { resultOrigin: 'hosted' }), run(base, 'pass', 100)]).origin).toBe('mixed')
    expect(cellStats([run(base, 'pass', 100, { resultOrigin: undefined })]).origin).toBeNull()
  })
})

describe('buildMatrix', () => {
  it('rows = cases, columns = variants (baseline first), the baseline per case', () => {
    const m = buildMatrix([run(skill, 'pass', 100), run(base, 'pass', 100), run(skill, 'pass', 90, { caseId: 'c-0', caseKey: 'a-case', variant: { ...skill } })])
    expect(m.variants.map((v) => v.id)).toEqual(['v-base', 'v-skill'])
    expect(m.cases.map((c) => [c.caseKey, c.baselineId])).toEqual([['a-case', null], ['webhook-dup-001', 'v-base']])
    expect(m.cases[1]!.cells.get('v-skill')).toHaveLength(1)
  })
})

describe('verdictOf (the case-compare rule)', () => {
  it('refuses below 5 counted runs per side, with the rule text in the tooltip', () => {
    const v = verdictOf([run(base, 'pass', 100)], [run(skill, 'pass', 100)])
    expect(v.label).toBe('refused')
    expect(v.text).toBe('no verdict')
    expect(v.title).toContain('fewer than 5 counted runs')
    expect(v.title).toContain(RELATIVE_RULE_TEXT)
  })

  it('better when the variant wins by the margin and the test, worse the other way; infra failures are not counted', () => {
    const lo = Array.from({ length: 6 }, () => run(base, 'fail', 40, { hardGatesOk: true }))
    const hi = [...Array.from({ length: 6 }, () => run(skill, 'pass', 100)), run(skill, 'infra_error', null), run(skill, 'fail', 0, { infraOk: false })]
    expect(verdictOf(lo, hi).label).toBe('better')
    expect(verdictOf(lo, hi).comparison.relative.nVariant).toBe(6)
    expect(verdictOf(hi.slice(0, 6), lo).label).toBe('worse')
  })

  it('a failed hard gate scores 0 in the relative rule; a run with no score is left out', () => {
    expect(toCaseRuns([run(base, 'fail', 80, { hardGatesOk: false }), run(base, 'pass', null)])).toEqual([{ score: 80, hardGatesOk: false, infraOk: true }])
    expect(toCaseRuns([run(base, 'pass', 80, { hardGatesOk: null })])[0]!.hardGatesOk).toBe(true)
  })
})

describe('S7 helpers', () => {
  it('newestRunOf prefers a counted run; pairFromVariants names a missing side', () => {
    const rows = [run(base, 'pass', 100, { startedAt: '2026-11-12T10:00:00.000Z' }), run(base, 'infra_error', null, { startedAt: '2026-11-12T11:00:00.000Z' }), run(skill, 'pass', 100)]
    expect(newestRunOf(rows, 'c-1', 'v-base')!.id).toBe(rows[0]!.id)
    expect(pairFromVariants(rows, 'c-1', 'v-base', 'v-skill')).toEqual({ ok: true, pair: { baseRunId: rows[0]!.id, variantRunId: rows[2]!.id } })
    expect(pairFromVariants(rows, 'c-1', 'v-base', 'nope')).toMatchObject({ ok: false })
  })

  it('aligns tool calls into same / inserted / changed / removed rows', () => {
    const a = (seq: number, tool: string, target: string | null) => ({ seq, tool, target, ok: true, occurredAt: '' })
    const al = alignSteps(stepsOfActions([a(1, 'Read', 'a.ts'), a(2, 'Bash', 'npm test'), a(3, 'TodoWrite', null)]), stepsOfActions([a(1, 'Read', 'a.ts'), a(2, 'Edit', 'a.ts'), a(3, 'Bash', 'npm run test')]))
    expect(al.rows.map(alignmentWord)).toEqual(['same', 'inserted', 'changed', 'removed'])
  })

  it('rowsByKind: one row per data type present on either side, in a fixed order', () => {
    const art = (kind: 'json' | 'diff' | 'markdown', id: string) => ({ id, path: id, kind, bytes: 1, source: 'run' as const })
    expect(rowsByKind([art('json', 'run.json'), art('diff', 'p')], [art('json', 'run.json'), art('markdown', 'r.md')]).map((r) => [r.kind, r.base.length, r.variant.length])).toEqual([
      ['diff', 1, 0],
      ['json', 1, 1],
      ['markdown', 0, 1],
    ])
  })

  it('diffCommand writes tma eval diff of the two variant folders', () => {
    expect(diffCommand('k1', base, skill)).toBe('tma eval diff eval/k1/runs/<baseline folder> eval/k1/runs/0123456789ab')
  })
})

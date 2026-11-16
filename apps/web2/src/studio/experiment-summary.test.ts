/** UI-S4S6S7: the S6 key metrics per variant column (pooled pass rate, versus the baseline, best column). */
import { describe, expect, it } from 'vitest'
import type { EvalRun, EvalVariant } from '../lib/api/types'
import { buildMatrix } from './experiment-matrix'
import { bestIndex, rateOf, variantTotals, versusBase } from './experiment-summary'

const agent = { harness: 'h', harnessVersion: null, harnessRepoSha: null, modelId: 'm', rulesSha256: null, skillsSha256: null, mcpManifestSha256: null, toolsSha256: null }
const base: EvalVariant = { id: 'v-base', agentSha256: 'a'.repeat(64), agent, variantSha256: 'e'.repeat(64), label: 'base', changeKind: 'none', isBaseline: true }
const alt: EvalVariant = { id: 'v-alt', agentSha256: 'a'.repeat(64), agent, variantSha256: 'f'.repeat(64), label: 'alt', changeKind: 'skill', isBaseline: false }
let n = 0
const run = (variant: EvalVariant, caseId: string, status: string): EvalRun => ({
  id: `r-${++n}`, evaluationId: `e-${variant.id}`, agentId: 'ag', agentName: 'A', seq: n, status, score: status === 'pass' ? 100 : status === 'fail' ? 0 : null, infraOk: status !== 'infra_error',
  startedAt: '2026-11-12T12:00:00.000Z', caseId, caseKey: caseId, useCaseKey: 'fix/x', variant, predictionSha256: null, resultOrigin: 'self_declared', hardGatesOk: true,
})
const many = (variant: EvalVariant, caseId: string, s: string) => [...s].map((x) => run(variant, caseId, x === 'P' ? 'pass' : x === 'F' ? 'fail' : 'infra_error'))

describe('variantTotals and versusBase', () => {
  const runs = [...many(base, 'c1', 'PPFFF'), ...many(alt, 'c1', 'PPPPP'), ...many(base, 'c2', 'PPPPP'), ...many(alt, 'c2', 'PPPPI')]
  const m = buildMatrix(runs)

  it('pools every repeat over the dataset and counts an infra failure apart', () => {
    const t = variantTotals(m, 'v-alt')
    expect(t).toMatchObject({ n: 10, infra: 1, counted: 9, pass: 9, cases: 2 })
    expect(rateOf(t)).toBe(100)
    expect(variantTotals(m, 'v-base')).toMatchObject({ n: 10, counted: 10, pass: 7, infra: 0 })
  })

  it('compares a variant with the baseline of each case: points, better, worse, undecided', () => {
    const v = versusBase(m, 'v-alt')
    expect(v.compared).toBe(2)
    expect(v.pointsDelta).toBe(Math.round((9 / 9 - 7 / 10) * 100))
    expect(v.better + v.worse + v.undecided).toBe(2)
  })

  it('a baseline column has nothing to compare with', () => {
    expect(versusBase(m, 'v-base')).toEqual({ compared: 0, better: 0, worse: 0, undecided: 0, pointsDelta: null })
  })
})

describe('bestIndex', () => {
  it('marks one best column, and none on a tie or with a single value', () => {
    expect(bestIndex([0.6, 0.8])).toBe(1)
    expect(bestIndex([0.8, 0.8])).toBeNull()
    expect(bestIndex([null, 0.8])).toBeNull()
    expect(bestIndex([-0, -1])).toBe(0)
  })
})

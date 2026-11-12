import { describe, expect, it } from 'vitest'
import {
  ABSOLUTE_RULE_TEXT,
  EXACT_MAX_RUNS,
  MIN_RUNS_PER_SIDE,
  RELATIVE_RULE_TEXT,
  compareCase,
  mannWhitneyU,
  type CaseRun,
} from './case-compare'

const runs = (...scores: number[]): CaseRun[] => scores.map((score) => ({ score, hardGatesOk: true }))

describe('compareCase: n < 5 (S6, C5-T7)', () => {
  it('refuses a verdict on both rules when a side has fewer than 5 runs', () => {
    const c = compareCase(runs(100, 100, 100, 100), runs(100, 100, 100, 100, 100))
    expect(c.relative.label).toBe('refused')
    expect(c.relative.reason).toBe('n_below_minimum')
    expect(c.relative.mannWhitney).toBeNull()
    expect(c.absolute.base.label).toBe('refused')
    expect(c.absolute.base.reason).toBe('n_below_minimum')
    // The counted side with n = 5 still gets its absolute label: the rule is per agent.
    expect(c.absolute.variant.label).toBe('SAME')
  })

  it('does not count platform faults toward n', () => {
    const base = [...runs(90, 90, 90, 90), { score: 0, hardGatesOk: false, infraOk: false }]
    const c = compareCase(base, runs(90, 90, 90, 90, 90))
    expect(c.absolute.base.n).toBe(4)
    expect(c.absolute.base.infraExcluded).toBe(1)
    expect(c.relative.nBase).toBe(4)
    expect(c.relative.label).toBe('refused')
  })

  it('states the minimum of 5', () => {
    expect(MIN_RUNS_PER_SIDE).toBe(5)
  })
})

describe('compareCase: relative rule', () => {
  it('5 vs 5 runs with a 4 point gap is a tie, and the rule text says why', () => {
    const c = compareCase(runs(80, 80, 80, 80, 80), runs(84, 84, 84, 84, 84))
    expect(c.relative.gap).toBe(4)
    expect(c.relative.label).toBe('tie')
    expect(c.relative.reason).toBe('gap_below_margin')
    // Complete separation is significant on its own; the margin makes it a tie.
    expect(c.relative.mannWhitney?.p).toBeLessThan(0.05)
    expect(c.relative.ruleText).toBe(RELATIVE_RULE_TEXT)
    expect(RELATIVE_RULE_TEXT).toContain('at least 5 points')
    expect(RELATIVE_RULE_TEXT).toContain('Mann-Whitney U')
  })

  it('a large gap with complete separation is better (exact p = 2/252)', () => {
    const c = compareCase(runs(60, 62, 64, 66, 68), runs(90, 92, 94, 96, 98))
    expect(c.relative.label).toBe('better')
    expect(c.relative.reason).toBeNull()
    expect(c.relative.mannWhitney).toEqual({ u: 25, p: expect.closeTo(2 / 252, 12), method: 'exact' })
  })

  it('the same runs the other way are worse', () => {
    const c = compareCase(runs(90, 92, 94, 96, 98), runs(60, 62, 64, 66, 68))
    expect(c.relative.label).toBe('worse')
    expect(c.relative.mannWhitney?.u).toBe(0)
  })

  it('a large gap that the test does not support is a tie (not significant)', () => {
    const c = compareCase(runs(0, 100, 100, 0, 100), runs(100, 0, 100, 100, 100))
    expect(c.relative.gap).toBe(20)
    expect(c.relative.label).toBe('tie')
    expect(c.relative.reason).toBe('not_significant')
    expect(c.relative.mannWhitney?.p).toBeGreaterThanOrEqual(0.05)
  })

  it('hard gates first: a run with a failed hard gate scores 0', () => {
    const variant: CaseRun[] = [...runs(100, 100, 100, 100), { score: 100, hardGatesOk: false }]
    const c = compareCase(runs(100, 100, 100, 100, 100), variant)
    expect(c.relative.meanVariant).toBe(80)
    expect(c.relative.gap).toBe(-20)
    expect(c.absolute.variant.label).toBe('NOT YET')
    expect(c.absolute.variant.hardGateFailures).toBe(1)
  })
})

describe('compareCase: both rules side by side (Q-T22 = C)', () => {
  it('returns both verdicts and no combined one when the rules disagree', () => {
    const c = compareCase(runs(96, 97, 98, 96, 97), runs(93, 94, 93, 94, 93))
    expect(c.absolute.base.label).toBe('SAME')
    expect(c.absolute.variant.label).toBe('CLOSE')
    expect(c.relative.label).toBe('tie')
    expect(Object.keys(c).sort()).toEqual(['absolute', 'relative'])
    expect(c.absolute.ruleText).toBe(ABSOLUTE_RULE_TEXT)
  })

  it('absolute labels: SAME at 95, CLOSE at 85, NOT YET below', () => {
    expect(compareCase(runs(95, 95, 95, 95, 95), runs(85, 85, 85, 85, 85)).absolute.base.label).toBe('SAME')
    expect(compareCase(runs(95, 95, 95, 95, 95), runs(85, 85, 85, 85, 85)).absolute.variant.label).toBe('CLOSE')
    const low = compareCase(runs(100, 100, 100, 100, 84), runs(100, 100, 100, 100, 100)).absolute.base
    expect(low.label).toBe('NOT YET')
    expect(low.minScore).toBe(84)
    expect(low.runsAtLeastClose).toBe(4)
  })

  it('refuses a score outside 0..100', () => {
    expect(() => compareCase(runs(101, 1, 1, 1, 1), runs(1, 1, 1, 1, 1))).toThrow(RangeError)
  })
})

describe('mannWhitneyU', () => {
  it('3 vs 3 complete separation: exact p = 2/20', () => {
    expect(mannWhitneyU([1, 2, 3], [4, 5, 6])).toEqual({ u: 9, p: expect.closeTo(0.1, 12), method: 'exact' })
  })

  it('all values equal gives p = 1', () => {
    expect(mannWhitneyU([50, 50, 50, 50, 50], [50, 50, 50, 50, 50]).p).toBeCloseTo(1, 12)
  })

  it('ties use mid-ranks: U counts a tie as one half', () => {
    expect(mannWhitneyU([0, 0, 100], [0, 100, 100]).u).toBe(6)
  })

  it('above the exact limit it uses the normal approximation', () => {
    const half = EXACT_MAX_RUNS / 2 + 1
    const base = Array.from({ length: half }, (_, i) => i)
    const variant = Array.from({ length: half }, (_, i) => 100 - i)
    const r = mannWhitneyU(base, variant)
    expect(r.method).toBe('normal')
    expect(r.p).toBeLessThan(1e-6)
  })

  it('the exact p with ties equals a brute-force enumeration of all 252 splits', () => {
    const base = [0, 50, 50, 100, 70]
    const variant = [50, 100, 100, 90, 0]
    const pooled = [...base, ...variant]
    const sumOf = (xs: number[], ys: number[]) => {
      let u = 0
      for (const y of ys) for (const x of xs) u += y > x ? 1 : y === x ? 0.5 : 0
      return u
    }
    const uObs = sumOf(base, variant)
    const centre = (base.length * variant.length) / 2
    let total = 0
    let extreme = 0
    for (let mask = 0; mask < 1 << pooled.length; mask++) {
      let bits = 0
      for (let i = 0; i < pooled.length; i++) if (mask & (1 << i)) bits++
      if (bits !== variant.length) continue
      const ys = pooled.filter((_, i) => mask & (1 << i))
      const xs = pooled.filter((_, i) => !(mask & (1 << i)))
      total++
      if (Math.abs(sumOf(xs, ys) - centre) >= Math.abs(uObs - centre) - 1e-9) extreme++
    }
    expect(total).toBe(252)
    const r = mannWhitneyU(base, variant)
    expect(r.method).toBe('exact')
    expect(r.u).toBe(uObs)
    expect(r.p).toBeCloseTo(extreme / total, 12)
  })
})

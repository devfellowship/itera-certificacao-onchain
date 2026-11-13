// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// The per-use-case compare (plan 20261112-tma-c7-model-comparison-per-use-case, T2; ADR-2, ADR-4, ADR-8).
import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_RULE_TEXT,
  RELATIVE_RULE_TEXT,
  compareCase,
  compareUseCase,
  quantile,
  runScore,
  type GraderRow,
  type UseCaseProfile,
  type UseCaseRun,
} from './compare.js';

/** The profile of the use case: a hard gate, and two graders of weight 3 and 1. */
const profile: UseCaseProfile = {
  useCase: 'bugfix',
  graders: [
    { id: 'gate', weight: 1, hardGate: true },
    { id: 'a', weight: 3, hardGate: false },
    { id: 'b', weight: 1, hardGate: false },
  ],
};

let seq = 0;
/**
 * A run that scores `score` (an integer 1..100): 100 code graders `g0..g99` with row weight 1; `g0` is a hard gate
 * that passes when `gateOk`, and graders `g0..g(score-1)` pass. A failed gate makes the score 0.
 */
function runWithScore(agentKey: string, score: number, extra: Partial<UseCaseRun> = {}, gateOk = true): UseCaseRun {
  const graders: GraderRow[] = [];
  for (let i = 0; i < 100; i++) {
    graders.push({ graderId: `g${i}`, kind: 'code', pass: i === 0 ? gateOk : i < score, weight: 1, hardGate: i === 0 });
  }
  return { runId: `r${seq++}`, agentKey, caseKey: 'c1', costUsd: 1, costSource: 'metered', wallMs: 1000, graders, ...extra };
}

const many = (k: number, f: () => UseCaseRun) => Array.from({ length: k }, f);

describe('compareUseCase: plan example (ADR-4, the rules disagree)', () => {
  it('candidate 89 x5 vs current 92 x5: absolute CLOSE, relative tie', () => {
    const runs = [...many(5, () => runWithScore('cand', 89)), ...many(5, () => runWithScore('cur', 92))];
    const c = compareUseCase(runs, profile, { currentAgentKey: 'cur' });
    const cand = c.agents.find((a) => a.agentKey === 'cand')!;
    const cur = c.agents.find((a) => a.agentKey === 'cur')!;
    expect(cand.absolute.label).toBe('CLOSE');
    expect(cand.relative.label).toBe('tie');
    expect(cand.relative.reason).toBe('gap_below_margin');
    expect(cand.relative.gap).toBe(-3);
    expect(cur.relative.label).toBe('refused');
    expect(cur.relative.reason).toBe('is_current_agent');
    expect(c.agents.map((a) => a.agentKey)).toEqual(['cand', 'cur']);
    expect(c.ruleText).toEqual({ absolute: ABSOLUTE_RULE_TEXT, relative: RELATIVE_RULE_TEXT });
    expect(c.profile).toMatchObject({ minRunsPerCell: 5, relativeMarginPoints: 5, absoluteBars: { same: 95, close: 85 } });
  });

  it('with no current agent every relative is refused no_current_agent', () => {
    const c = compareUseCase(many(5, () => runWithScore('cand', 89)), profile, { currentAgentKey: null });
    expect(c.agents[0].relative).toMatchObject({ label: 'refused', reason: 'no_current_agent', mannWhitney: null });
  });
});

describe('compareUseCase: hard gates', () => {
  it('one failed hard gate in one run scores that run 0, the cell is NOT YET and off the Pareto set', () => {
    const runs = [...many(4, () => runWithScore('a', 100)), runWithScore('a', 100, {}, false)];
    const c = compareUseCase(runs, profile, { currentAgentKey: null });
    const a = c.agents[0];
    expect(a.scores[4]).toBe(0);
    expect(a.hardGateFailures).toBe(1);
    expect(a.absolute.label).toBe('NOT YET');
    expect(a.pareto).toEqual({ eligible: false, ineligibleReason: 'hard_gate_failure', onFront: null, dominated: null });
  });
});

describe('compareUseCase: n below the minimum', () => {
  it('n = 4: relative refused n_below_minimum, absolute refused, dominated null', () => {
    const runs = [
      ...many(4, () => runWithScore('small', 50, { costUsd: 5 })),
      ...many(5, () => runWithScore('cur', 90, { costUsd: 1 })),
    ];
    const c = compareUseCase(runs, profile, { currentAgentKey: 'cur' });
    const s = c.agents.find((a) => a.agentKey === 'small')!;
    expect(s.n).toBe(4);
    expect(s.relative.label).toBe('refused');
    expect(s.relative.reason).toBe('n_below_minimum');
    expect(s.absolute.label).toBe('refused');
    expect(s.absolute.reason).toBe('n_below_minimum');
    // It is dominated by `cur`, but a cell with n < 5 gets no dominated label (ADR-34).
    expect(s.pareto.onFront).toBe(false);
    expect(s.pareto.dominated).toBeNull();
  });
});

describe('compareUseCase: platform faults', () => {
  /** Drop every infraExcluded key, at any depth. */
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'infraExcluded').map(([k, x]) => [k, strip(x)]));
    }
    return v;
  };

  it('an infraOk: false run changes no number except infraExcluded', () => {
    const runs = [
      ...many(5, () => runWithScore('a', 90, { costUsd: 0.5, wallMs: 2000 })),
      ...many(5, () => runWithScore('cur', 80, { costUsd: 1.5, costSource: 'derived' })),
    ];
    const before = compareUseCase(runs, profile, { currentAgentKey: 'cur' });
    const fault = runWithScore('a', 0, { infraOk: false, costUsd: 99, costSource: null, wallMs: 1e9 }, false);
    const after = compareUseCase([...runs.slice(0, 2), fault, ...runs.slice(2)], profile, { currentAgentKey: 'cur' });
    expect(after.agents[0].infraExcluded).toBe(1);
    expect(before.agents[0].infraExcluded).toBe(0);
    expect(strip(after)).toEqual(strip(before));
  });

  it('a run with no counted grader is left out as noScoreRuns', () => {
    const noScore: UseCaseRun = {
      runId: 'x', agentKey: 'a', caseKey: 'c', graders: [{ graderId: 'h', kind: 'human', pass: true }],
    };
    const c = compareUseCase([runWithScore('a', 70), noScore], profile, { currentAgentKey: null });
    expect(c.agents[0]).toMatchObject({ n: 1, noScoreRuns: 1, scores: [70] });
  });
});

describe('runScore: weighted pass rate (Q-T10 = A, ADR-2)', () => {
  const run = (graders: GraderRow[]): UseCaseRun => ({ runId: 'r', agentKey: 'a', caseKey: 'c', graders });

  it('weights 3 (pass) + 1 (fail) => 75', () => {
    const r = runScore(run([
      { graderId: 'a', kind: 'code', pass: true },
      { graderId: 'b', kind: 'code', pass: false },
    ]), profile);
    expect(r.score).toBe(75);
    expect(r.hardGateOk).toBe(true);
  });

  it('a row weight overrides the profile weight', () => {
    const r = runScore(run([
      { graderId: 'a', kind: 'code', pass: true, weight: 1 },
      { graderId: 'b', kind: 'code', pass: false },
    ]), profile);
    expect(r.score).toBe(50);
  });

  it('a non-decisive judge is ignored, a decisive judge counts, a human row is ignored', () => {
    const r1 = runScore(run([
      { graderId: 'a', kind: 'code', pass: true },
      { graderId: 'b', kind: 'judge', pass: false, decisive: false },
      { graderId: 'b2', kind: 'judge', pass: false, weight: 5 },
      { graderId: 'h', kind: 'human', pass: false, weight: 10 },
    ]), profile);
    expect(r1.score).toBe(100);
    expect(r1.ignored).toEqual([
      { graderId: 'b', why: 'judge_not_decisive' },
      { graderId: 'b2', why: 'judge_not_decisive' },
      { graderId: 'h', why: 'human_label' },
    ]);
    const r2 = runScore(run([
      { graderId: 'a', kind: 'code', pass: true },
      { graderId: 'b', kind: 'judge', pass: false, decisive: true },
    ]), profile);
    expect(r2.score).toBe(75);
    expect(r2.counted.map((g) => g.graderId)).toEqual(['a', 'b']);
  });

  it('a grader in no profile and with no row weight is ignored; no counted grader gives null', () => {
    const r = runScore(run([{ graderId: 'zzz', kind: 'code', pass: true }]), profile);
    expect(r.score).toBeNull();
    expect(r.ignored).toEqual([{ graderId: 'zzz', why: 'no_weight' }]);
  });

  it('a failed hard gate scores 0; a row hardGate overrides the profile', () => {
    expect(runScore(run([
      { graderId: 'gate', kind: 'code', pass: false },
      { graderId: 'a', kind: 'code', pass: true },
    ]), profile)).toMatchObject({ score: 0, hardGateOk: false });
    expect(runScore(run([
      { graderId: 'gate', kind: 'code', pass: false, hardGate: false },
      { graderId: 'a', kind: 'code', pass: true },
    ]), profile)).toMatchObject({ score: 75, hardGateOk: true });
  });

  it('throws a RangeError on a weight <= 0', () => {
    expect(() => runScore(run([{ graderId: 'a', kind: 'code', pass: true, weight: 0 }]), profile)).toThrow(RangeError);
    expect(() => compareUseCase([], { useCase: 'u', graders: [{ id: 'x', weight: -1, hardGate: false }] }, { currentAgentKey: null }))
      .toThrow(RangeError);
  });
});

describe('compareUseCase: Pareto after hard gates', () => {
  it('(90, 1.0), (85, 0.5), (80, 0.8): the third is dominated, the first two on the front', () => {
    const runs = [
      ...many(5, () => runWithScore('p1', 90, { costUsd: 1.0 })),
      ...many(5, () => runWithScore('p2', 85, { costUsd: 0.5 })),
      ...many(5, () => runWithScore('p3', 80, { costUsd: 0.8 })),
    ];
    const c = compareUseCase(runs, profile, { currentAgentKey: 'p1' });
    const by = Object.fromEntries(c.agents.map((a) => [a.agentKey, a.pareto]));
    expect(by.p1).toEqual({ eligible: true, ineligibleReason: null, onFront: true, dominated: false });
    expect(by.p2).toEqual({ eligible: true, ineligibleReason: null, onFront: true, dominated: false });
    expect(by.p3).toEqual({ eligible: true, ineligibleReason: null, onFront: false, dominated: true });
  });

  it('ties (same score and cost) do not dominate each other', () => {
    const runs = [...many(5, () => runWithScore('t1', 80)), ...many(5, () => runWithScore('t2', 80))];
    const c = compareUseCase(runs, profile, { currentAgentKey: null });
    for (const a of c.agents) expect(a.pareto).toMatchObject({ onFront: true, dominated: false });
  });

  it('a missing cost makes the cell ineligible no_cost; cost labels', () => {
    const runs = [
      ...many(4, () => runWithScore('m', 80)),
      runWithScore('m', 80, { costUsd: null }),
      ...many(4, () => runWithScore('d', 80)),
      runWithScore('d', 80, { costSource: 'derived' }),
    ];
    const c = compareUseCase(runs, profile, { currentAgentKey: null });
    const d = c.agents.find((a) => a.agentKey === 'd')!;
    const m = c.agents.find((a) => a.agentKey === 'm')!;
    expect(m).toMatchObject({ costPerTask: null, costLabel: null, pareto: { eligible: false, ineligibleReason: 'no_cost' } });
    expect(d).toMatchObject({ costPerTask: 1, costLabel: 'derived', medianWallMs: 1000 });
  });
});

describe('distribution', () => {
  it('uses the type-7 quantile rule', () => {
    expect(quantile([10, 20, 30, 40, 50], 0.1)).toBeCloseTo(14, 10);
    expect(quantile([10, 20, 30, 40, 50], 0.5)).toBe(30);
    expect(quantile([7], 0.9)).toBe(7);
  });
});

describe('the per-case rule lives here too (ADR-7)', () => {
  it('compareCase still answers', () => {
    const runs = (s: number) => Array.from({ length: 5 }, () => ({ score: s, hardGatesOk: true }));
    expect(compareCase(runs(80), runs(84)).relative.label).toBe('tie');
  });
});

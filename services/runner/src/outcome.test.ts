import { describe, expect, it } from 'vitest';
import type { EvidenceManifest } from '../../evaluator/src/types.js';
import { computeScore, hiddenRatioScore, SCORE_VERSION } from '../../evaluator/src/score.js';
import type { AgentRunResult } from './agent-run.js';
import { evalLogOf, finalStatus, runScore, statusError, zeroTestSuites } from './outcome.js';

const suite = (total: number, passed = total) => ({ total, passed, failed: total - passed, cases: [] });
function m(over: Partial<EvidenceManifest['tests']> = {}, total = 70): EvidenceManifest {
  return {
    schema_version: '0.1.0', evaluator_version: '0.1.0', scenario_id: 's', generated_at: '', fixture_hash: '', patch_hash: '',
    patch_scope: { changed_files: ['src/a.ts'], allowed: true, violations: [] },
    tests: { public_baseline: suite(3, 2), public_after_patch: suite(3), hidden: suite(5), ...over },
    score: { public_behavior: 20, hidden_behavior: 50, regression: 0, patch_integrity_and_scope: 0, reproducible_evidence: 0, total },
    errors: [],
  };
}
const agent = { timedOut: false, patch: 'diff --git a/src/a.ts b/src/a.ts\n' };

describe('finalStatus — zero tests is never a pass', () => {
  it('pass when every suite ran and every hidden test passed (5/5)', () => {
    expect(finalStatus(agent, m())).toBe('pass');
  });
  it('fail, score kept, when a scored run misses a hidden test (4/5 = score 90)', () => {
    const manifest = m({ hidden: suite(5, 4) }, 90);
    expect(finalStatus(agent, manifest)).toBe('fail');
    expect(manifest.score.total).toBe(90);
  });
  it('fail when no hidden test passes (0/5), even with a positive score from other parts', () => {
    expect(finalStatus(agent, m({ hidden: suite(5, 0) }, 40))).toBe('fail');
  });
  it('a skipped hidden test is not a pass', () => {
    expect(finalStatus(agent, m({ hidden: { total: 5, passed: 4, failed: 1, skipped: 1, cases: [] } }, 90))).toBe('fail');
  });
  it('infra_error (unscored) when the hidden report was not trusted or grading recorded errors', () => {
    expect(finalStatus(agent, m({ hidden: { ...suite(5), state: 'report_mismatch' } }))).toBe('infra_error');
    expect(finalStatus(agent, { ...m(), errors: ['verifier timed out'] })).toBe('infra_error');
  });
  it('invalid on a scope violation even when every hidden test passes', () => {
    expect(finalStatus(agent, { ...m(), patch_scope: { changed_files: ['tests/x'], allowed: false, violations: ['tests/x'] } })).toBe('invalid');
  });
  it.each(['public_baseline', 'public_after_patch', 'hidden'] as const)('infra_error when %s executed 0 tests', (k) => {
    const manifest = m({ [k]: suite(0) }, 30);
    expect(zeroTestSuites(manifest)).toEqual([k]);
    expect(finalStatus(agent, manifest)).toBe('infra_error');
    expect(statusError('infra_error', manifest, [])).toBe(`grading inconclusive: no test executed in ${k}`);
  });
  it('timeout, fail (empty patch) and invalid (scope) keep their meaning', () => {
    expect(finalStatus({ ...agent, timedOut: true }, m())).toBe('timeout');
    expect(finalStatus({ ...agent, patch: '' }, m())).toBe('fail');
    expect(finalStatus(agent, { ...m(), patch_scope: { changed_files: ['x'], allowed: false, violations: ['x'] } })).toBe('invalid');
  });
});

/**
 * Score version 2 (TMA-QC = B, TG 21519): score = hidden ratio × 100 when the gates hold, else 0.
 * The manifests below are built the way the evaluator builds them (runner.ts), with the shapes of
 * the K7 campaign `k7-dfl-bench-1` (report https://media.devfellowship.com/149ee540-00ca-407c-bc27-4a7f3764ed72).
 */
describe('score version 2 — the k7-dfl-bench-1 shapes', () => {
  function graded(o: { hidden: [number, number]; publicPassed?: number; patchEmpty?: boolean; scope?: boolean; mcp?: boolean | null }): EvidenceManifest {
    const hidden = suite(o.hidden[0], o.hidden[1]);
    const pub = suite(1, o.publicPassed ?? 1);
    const scope = o.scope ?? true;
    // Output-only tasks: public, regression, scope and evidence came free under version 1.
    const legacy = computeScore({ publicAfterPatch: pub, hidden, regressionRatio: 1, patchScopeAllowed: scope, runCompletedWithoutErrors: true });
    const v2 = hiddenRatioScore({ hidden, patchEmpty: o.patchEmpty ?? false, patchScopeAllowed: scope, mcpStateHolds: o.mcp ?? true, legacyTotal: legacy.total });
    return {
      ...m({ public_baseline: suite(1, 1), public_after_patch: pub, hidden }, v2.total),
      patch_scope: { changed_files: ['out/a.json'], allowed: scope, violations: scope ? [] : ['generate_report.py'] },
      score: { ...legacy, total: v2.total },
      score_version: SCORE_VERSION,
      score_rule: v2.rule,
      ...(o.mcp === null
        ? {}
        : { mcp: { weight: 50, servers: [{ server: 'repos', catalog: 'repos@1', image_digest: null, seed_sha256: null, export_sha256: null, calls: 3, calls_ok: 3, assertions: { passed: (o.mcp ?? true) ? 13 : 12, total: 13 } }] } }),
    };
  }
  const agentOf = (over: Partial<AgentRunResult> = {}) =>
    ({ ...agent, model: 'm', route: 'openrouter', agentFiles: ['AGENTS.md'], durationMs: 1, exitCode: 0, actions: [], usage: {}, agentErrors: [], ...over }) as unknown as AgentRunResult;
  const settle = (a: AgentRunResult, manifest: EvidenceManifest) => {
    const status = finalStatus(a, manifest);
    return { status, score: runScore(status, manifest), log: evalLogOf(manifest, a, status) };
  };

  it('a timeout with hidden 1/13 scores 0, not 77+ (run 63cf78c2)', () => {
    const manifest = graded({ hidden: [13, 1] });
    expect(manifest.score_rule!.legacy_total).toBeGreaterThanOrEqual(54); // what version 1 paid for (almost) nothing
    const r = settle(agentOf({ timedOut: true }), manifest);
    expect(r.status).toBe('timeout');
    expect(r.score).toBe(0);
    expect(r.log.score.total).toBe(0);
    expect(r.log.score_rule!.gates.agent_finished).toBe(false);
  });

  it('a timeout with hidden 3/6 scores 0, not 88 (run e9efcdf6)', () => {
    expect(settle(agentOf({ timedOut: true }), graded({ hidden: [6, 3] })).score).toBe(0);
  });

  it('a cost-capped run is a timeout and scores 0', () => {
    expect(settle(agentOf({ costCapped: true } as Partial<AgentRunResult>), graded({ hidden: [6, 6] })).score).toBe(0);
  });

  it('a finished fail scores the hidden ratio: 10/13 = 77 (run c4c8cfda), 14/20 = 70 (run 0e2f74e7)', () => {
    const a = settle(agentOf(), graded({ hidden: [13, 10] }));
    expect(a).toMatchObject({ status: 'fail', score: 77 });
    expect(a.log.score_rule!.gates.agent_finished).toBe(true);
    expect(settle(agentOf(), graded({ hidden: [20, 14] }))).toMatchObject({ status: 'fail', score: 70 });
  });

  it('a pass scores 100 (every deepseek run)', () => {
    expect(settle(agentOf(), graded({ hidden: [13, 13] }))).toMatchObject({ status: 'pass', score: 100 });
  });

  it('INVALID (scope gate) scores 0 although 19/20 hidden checks pass (run 2f98d3cb)', () => {
    expect(settle(agentOf(), graded({ hidden: [20, 19], scope: false }))).toMatchObject({ status: 'invalid', score: 0 });
  });

  it('a no-op (empty patch) scores 0', () => {
    expect(settle(agentOf({ patch: '' }), graded({ hidden: [6, 3], patchEmpty: true }))).toMatchObject({ status: 'fail', score: 0 });
  });

  it('a broken MCP final-state assertion scores 0', () => {
    expect(settle(agentOf(), graded({ hidden: [6, 6], mcp: false }))).toMatchObject({ status: 'fail', score: 0 });
  });

  it('infra_error stays unscored (0) and keeps its log as before', () => {
    const manifest = { ...graded({ hidden: [6, 6] }), errors: ['hidden: verifier timed out'] };
    const r = settle(agentOf(), manifest);
    expect(r).toMatchObject({ status: 'infra_error', score: 0 });
    expect(r.log.result.scored).toBe(false);
    expect(r.log.score.total).toBe(manifest.score.total);
  });

  it('a version-1 log (no score_version) is not rewritten', () => {
    const v1 = m({}, 90);
    const r = settle(agentOf({ timedOut: true }), v1);
    expect(r.log.score.total).toBe(90);
    expect(r.log).not.toHaveProperty('score_rule');
  });
});

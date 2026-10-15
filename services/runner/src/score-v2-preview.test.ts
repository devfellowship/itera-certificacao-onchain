import { describe, expect, it } from 'vitest';
import { scoreV2Of } from './score-v2-preview.js';

const suite = (total: number, passed: number) => ({ total, passed, failed: total - passed, cases: [] });
/** A stored version-1 log (K7 shape: output-only task, a repos@1 MCP server with 13/13 assertions). */
const v1Log = (hidden: [number, number], o: { allowed?: boolean; changed?: string[]; total?: number } = {}) => ({
  tests: { public_baseline: suite(1, 1), public_after_patch: suite(1, 1), hidden: suite(...hidden) },
  patch_scope: { changed_files: o.changed ?? ['out/answers.json'], allowed: o.allowed ?? true, violations: [] },
  score: { total: o.total ?? 77 },
  mcp: { weight: 50, servers: [{ server: 'repos', assertions: { passed: 13, total: 13 } }] },
  errors: [],
});

describe('score-v2-preview (read only) on k7-dfl-bench-1 shapes', () => {
  it('timeout, hidden 1/13, v1 77 → v2 0 (run 63cf78c2)', () => {
    expect(scoreV2Of({ status: 'timeout', scoreTotal: 77, evidenceManifest: v1Log([13, 1]) })).toMatchObject({ v1: 77, v2: 0, hidden: '1/13' });
  });
  it('fail, hidden 10/13, v1 94 → v2 77 (run c4c8cfda)', () => {
    expect(scoreV2Of({ status: 'fail', scoreTotal: 94, evidenceManifest: v1Log([13, 10], { total: 94 }) })).toMatchObject({ v2: 77 });
  });
  it('pass 13/13 → 100; invalid → 0; a no-op → 0', () => {
    expect(scoreV2Of({ status: 'pass', scoreTotal: 100, evidenceManifest: v1Log([13, 13], { total: 100 }) }).v2).toBe(100);
    expect(scoreV2Of({ status: 'invalid', scoreTotal: 0, evidenceManifest: v1Log([20, 19], { allowed: false, total: 0 }) }).v2).toBe(0);
    expect(scoreV2Of({ status: 'fail', scoreTotal: 69, evidenceManifest: v1Log([13, 0], { changed: [], total: 69 }) }).v2).toBe(0);
  });
  it('no graded log → null; a version-2 log is read as is', () => {
    expect(scoreV2Of({ status: 'infra_error', scoreTotal: 0, evidenceManifest: { error: 'runner lost the run' } }).v2).toBeNull();
    const v2 = { ...v1Log([6, 6]), score: { total: 100 }, score_version: 2, score_rule: { formula: 'hidden_ratio_x100_gated', hidden: '6/6', gates: {}, legacy_total: 100 } };
    expect(scoreV2Of({ status: 'pass', scoreTotal: 100, evidenceManifest: v2 })).toMatchObject({ v2: 100, hidden: '6/6' });
  });
});

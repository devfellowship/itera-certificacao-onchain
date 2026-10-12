import { describe, expect, it } from 'vitest';
import { buildGraderArgs, parseManifest } from './grade.js';
import { defaultSandboxConfig } from './sandbox.js';

const suite = { total: 3, passed: 3, failed: 0, cases: [] };
const valid = {
  scenario_id: 'webhook-ledger',
  patch_hash: 'h',
  patch_scope: { changed_files: ['src/a.ts'], allowed: true, violations: [] },
  tests: { public_baseline: suite, public_after_patch: suite, hidden: suite },
  score: { total: 100 },
  errors: [],
};

describe('buildGraderArgs', () => {
  const args = buildGraderArgs({ name: 'itera-grade-x', config: defaultSandboxConfig({}), scenarioId: 'webhook-ledger' });
  it('runs with no network, no socket, no secret, no capabilities, non-root', () => {
    expect(args).toEqual(expect.arrayContaining(['--network', 'none', '--cap-drop', 'ALL', '--user', '10001:10001']));
    expect(args.join(' ')).not.toMatch(/docker\.sock|-v |--volume|--mount|KEY|TOKEN|SECRET|DATABASE_URL/i);
  });
  it('runs the bundled evaluator CLI on the patch and writes the manifest to a file', () => {
    expect(args.slice(-7)).toEqual([
      '/workspace/services/evaluator/dist/cli.mjs', '--scenario', 'webhook-ledger', '--patch', '/workspace/patch.diff', '--out', '/workspace/out/manifest.json',
    ]);
  });
});

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(parseManifest(JSON.stringify(valid)).score.total).toBe(100);
  });
  it('refuses non-JSON and wrong shapes (never a score)', () => {
    expect(() => parseManifest('Score: 100/100')).toThrow(/not JSON/);
    expect(() => parseManifest(JSON.stringify({ ...valid, tests: { hidden: suite } }))).toThrow(/not an evidence manifest/);
    expect(() => parseManifest(JSON.stringify({ ...valid, score: { total: '100' } }))).toThrow(/not an evidence manifest/);
  });
});

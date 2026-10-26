import { describe, expect, it, vi } from 'vitest';
import type { EvidenceManifest } from '../../evaluator/src/types.js';
import { buildLocalResult, parseFlags, postLocalResult, type UploadInput, type UploadSample } from './tma-upload.js';

const H = (c: string) => c.repeat(64);
const suite = (total: number, passed: number) => ({ total, passed, failed: total - passed, cases: [] });

const manifest = (hiddenPassed: number, total = 100): EvidenceManifest =>
  ({
    schema_version: '1',
    evaluator_version: '1.1.0',
    scenario_id: 'research-codebase',
    generated_at: '2026-10-26T12:00:00Z',
    fixture_hash: H('f'),
    patch_hash: H('p'),
    patch_scope: { changed_files: ['out/answers.json'], allowed: true, violations: [] },
    tests: { public_baseline: suite(2, 0), public_after_patch: suite(2, 2), hidden: suite(12, hiddenPassed) },
    score: { public_behavior: 20, hidden_behavior: 50, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5, total },
    errors: [],
    contract: { schema_version: '1.0', name: 'itera/research-codebase', version: '1', contract_digest: H('c'), verifier_cmd: [] },
  }) as unknown as EvidenceManifest;

const sample = (over: Partial<UploadSample> = {}): UploadSample => ({
  manifest: manifest(12),
  patch: 'diff --git a/out/answers.json b/out/answers.json\n+{}\n',
  ran_from: '2026-10-26T12:00:00Z',
  ran_to: '2026-10-26T12:01:00Z',
  wall_s: 60,
  cost_usd: 0.01,
  tokens_in: 1000,
  tokens_out: 200,
  ...over,
});

const input = (over: Partial<UploadInput> = {}): UploadInput => ({
  agent_id: '0b6f3c2e-1d4a-4c8e-9f00-123456789abc',
  task: { catalog: { slug: 'research-codebase', version: 1 } },
  executor: { model_id: 'ollama/gemma4:26b', provider: 'google', route: 'ollama', harness: 'opencode 1.18.31', variant: null, cost_source: 'none' },
  grader_version: '1.1.0',
  samples: [sample()],
  ...over,
});

describe('buildLocalResult', () => {
  it('builds a valid tma-score/1 body with the summary derived from the runs', () => {
    const r = buildLocalResult(input({ samples: [sample(), sample({ manifest: manifest(9, 70), ran_to: '2026-10-26T12:05:00Z' })] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.format).toBe('tma-local-result/1');
    expect(r.body.metrics_shape).toBe('tma-score/1');
    expect(r.body.runner.execution).toBe('external');
    expect(r.body.ran_to).toBe('2026-10-26T12:05:00Z');
    expect(r.body.runs.map((x) => x.status)).toEqual(['pass', 'fail']);
    expect(r.body.runs.map((x) => x.repeat)).toEqual([1, 2]);
    expect(r.body.summary).toMatchObject({ score: 85, runs: 2, items: 1, pass_rate: 0.5, cost_total_usd: 0.02 });
  });

  it('never carries the patch text', () => {
    const r = buildLocalResult(input({ samples: [sample({ patch: 'SECRET-PATCH-TEXT' })] }));
    expect(JSON.stringify(r)).not.toContain('SECRET-PATCH-TEXT');
  });

  it('marks an empty patch fail with empty_output, a timeout as timeout, and keeps cost null when unknown', () => {
    const r = buildLocalResult(input({ samples: [sample({ patch: '  ' }), sample({ timed_out: true }), sample({ cost_usd: null })] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.runs.map((x) => x.status)).toEqual(['fail', 'timeout', 'pass']);
    expect(r.body.runs.map((x) => x.error_class)).toEqual(['empty_output', 'timeout', null]);
    expect(r.body.summary.cost_total_usd).toBeNull();
  });

  it('refuses an empty list, a bad timestamp and an unknown route', () => {
    expect(buildLocalResult(input({ samples: [] })).ok).toBe(false);
    expect(buildLocalResult(input({ samples: [sample({ ran_from: 'yesterday' })] })).ok).toBe(false);
    const bad = buildLocalResult(input({ executor: { ...input().executor, route: 'nowhere' } }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(' ')).toContain('/executor/route');
  });

  it('refuses a body the schema rejects (agent id, model id)', () => {
    expect(buildLocalResult(input({ agent_id: 'not-a-uuid' })).ok).toBe(false);
    expect(buildLocalResult(input({ executor: { ...input().executor, model_id: 'Bad Model!' } })).ok).toBe(false);
  });
});

describe('postLocalResult', () => {
  const built = buildLocalResult(input());
  if (!built.ok) throw new Error('fixture');
  const fake = (status = 200) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ result_origin: 'self_declared' }), { status }));

  it('is a dry run by default and sends the token only as a bearer header', async () => {
    const f = fake();
    const r = await postLocalResult(built.body, { api: 'https://api.example.test/', token: 'tok-123', send: false, fetchImpl: f as unknown as typeof fetch });
    expect(f.mock.calls[0]![0]).toBe('https://api.example.test/self-declared-results?dry_run=1');
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
    expect(String(f.mock.calls[0]![1]!.body)).not.toContain('tok-123');
    expect(JSON.stringify(r)).not.toContain('tok-123');
  });

  it('writes for real only with send', async () => {
    const f = fake(201);
    const r = await postLocalResult(built.body, { api: 'https://api.example.test', token: 't', send: true, fetchImpl: f as unknown as typeof fetch });
    expect(f.mock.calls[0]![0]).toBe('https://api.example.test/self-declared-results');
    expect(r.status).toBe(201);
  });
});

describe('parseFlags', () => {
  it('defaults to no send', () => {
    expect(parseFlags(['--input', 'a.json'])).toEqual({ input: 'a.json', send: false, buildOnly: false });
    expect(parseFlags(['--input', 'a.json', '--send', '--api', 'https://x.test'])).toMatchObject({ send: true, api: 'https://x.test' });
  });
  it('refuses an unknown argument', () => {
    expect(() => parseFlags(['--token', 'abc'])).toThrow('unknown argument');
  });
});

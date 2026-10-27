import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EvidenceManifest } from '../../evaluator/src/types.js';
import type { AgentRunResult } from './agent-run.js';
import { FakeJobStore } from './jobs.fake.js';
import { CLAIM_SQL } from './jobs.pg.js';
import { encryptRunKey } from './run-key.js';
import { defaultSandboxConfig } from './sandbox.js';
import { processRun, workerLoop, type WorkerDeps } from './worker.js';

const PATCH = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n';

function manifest(over: Partial<EvidenceManifest> = {}): EvidenceManifest {
  const suite = { total: 1, passed: 1, failed: 0, cases: [] };
  return {
    schema_version: '0.1.0',
    evaluator_version: '0.1.0',
    scenario_id: 'tsk_webhook_dup',
    generated_at: '2026-10-12T00:00:00.000Z',
    fixture_hash: 'f',
    patch_hash: 'p',
    patch_scope: { changed_files: ['src/app.ts'], allowed: true, violations: [] },
    tests: { public_baseline: suite, public_after_patch: suite, hidden: suite },
    score: { public_behavior: 20, hidden_behavior: 50, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5, total: 100 },
    errors: [],
    ...over,
  };
}

function agentResult(over: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    scenarioId: 'tsk_webhook_dup',
    model: 'qwen/qwen3-coder',
    agentFiles: ['AGENTS.md'],
    timedOut: false,
    exitCode: 0,
    durationMs: 1000,
    actions: [
      { seq: 1, tool: 'read', target: 'src/app.ts', ok: true, occurredAt: '2026-10-12T00:00:01.000Z' },
      { seq: 2, tool: 'edit', target: 'src/app.ts', ok: true, occurredAt: '2026-10-12T00:00:02.000Z' },
    ],
    usage: { steps: 2, inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    modelUsage: { costUsd: 0.0123, tokensIn: 1200, tokensOut: 300, calls: 4, refused: 0, maxCostUsd: 0.5, capStopped: false, costSource: 'metered', rateLimited: 0, rateLimitedFinal: 0, effectiveModels: {}, providers: {}, requestedModels: {}, params: null },
    route: 'openrouter',
    costCapped: false,
    agentErrors: [],
    patch: PATCH,
    artifacts: [],
    artifactsSkipped: [],
    ...over,
  };
}

const HTML_ARTIFACT = { path: 'files/out/report.html', content: '<h1>ok</h1>\n', encoding: 'utf-8' as const, sha256: 'h'.repeat(64), bytes: 12 };
const TRACE_ARTIFACT = { path: 'agent/trace.jsonl', content: '{"type":"step"}\n', encoding: 'utf-8' as const, sha256: 't'.repeat(64), bytes: 16 };

const SECRET = 's'.repeat(40);

function setup(opts: { noKey?: boolean; model?: string; agent?: Partial<AgentRunResult> | Error; manifest?: Partial<EvidenceManifest>; files?: Array<{ path: string; content: string }> } = {}) {
  const store = new FakeJobStore();
  const seen: { agentDir?: string; agentFiles?: string[]; key?: string; model?: string } = {};
  store.enqueue(
    { runId: 'run-1', scenarioId: 'tsk_webhook_dup', scenarioVersion: '1', agentVersionId: 'av-1' },
    {
      runId: 'run-1',
      scenarioId: 'tsk_webhook_dup',
      scenarioVersion: '1',
      agentVersionId: 'av-1',
      model: opts.model ?? 'qwen/qwen3-coder',
      modelApiKeyEnc: opts.noKey ? null : encryptRunKey('sk-or-v1-user', SECRET),
      files: opts.files ?? [{ path: 'AGENTS.md', content: '# agent' }, { path: '../escape.md', content: 'x' }],
    },
  );
  const deps: WorkerDeps = {
    store,
    workerId: 'w1',
    repoRoot: '/repo',
    runKeySecret: SECRET,
    config: defaultSandboxConfig({}),
    runAgent: async (o) => {
      seen.agentDir = o.agentDir;
      seen.key = o.modelKey;
      seen.model = o.model;
      seen.agentFiles = [await readFile(join(o.agentDir, 'AGENTS.md'), 'utf-8')];
      if (opts.agent instanceof Error) throw opts.agent;
      return agentResult(opts.agent);
    },
    grade: async () => manifest(opts.manifest),
  };
  return { store, deps, seen };
}

describe('processRun', () => {
  it('runs the agent, grades, and writes status, patch, manifest and actions through the phases', async () => {
    const { store, deps, seen } = setup();
    const claimed = (await store.claim('w1'))!;
    const outcome = await processRun(deps, claimed);

    expect(seen.agentFiles).toEqual(['# agent']);
    expect(seen.key).toBe('sk-or-v1-user');
    expect(store.runs.get('run-1')!.job!.modelApiKeyEnc).toBeNull();
    expect(store.phases.map((p) => p.phase)).toEqual(['agent_running', 'grading']);
    expect(outcome.status).toBe('pass');
    expect(outcome.phase).toBe('done');
    expect(outcome.scoreTotal).toBe(100);
    expect(outcome.patch).toBe(PATCH);
    expect(outcome.actions).toHaveLength(2);
    expect((outcome.evidenceManifest as { runner: { tool_calls: number } }).runner.tool_calls).toBe(2);
    expect(store.outcomes.get('run-1')).toEqual(outcome);
    expect(store.runs.get('run-1')!.status).toBe('pass');
    // The gateway's measure (OpenRouter accounting) is the billed cost, not opencode's own count.
    expect(outcome.cost).toEqual({ costUsd: 0.0123, tokensIn: 1200, tokensOut: 300 });
  });

  it('timeout: the cost cap stopped the agent, with a clear error and the cost recorded', async () => {
    const msg = 'model cost cap reached: US$0.5100 spent, cap US$0.5 per run (ITERA_RUN_MAX_COST_USD); the gateway refused further model calls';
    const { store, deps } = setup({
      agent: {
        costCapped: true,
        agentErrors: [msg],
        modelUsage: { costUsd: 0.51, tokensIn: 90000, tokensOut: 9000, calls: 20, refused: 1, maxCostUsd: 0.5, capStopped: true, costSource: 'metered', rateLimited: 0, rateLimitedFinal: 0, effectiveModels: {}, providers: {}, requestedModels: {}, params: null },
      },
    });
    const outcome = await processRun(deps, (await store.claim('w1'))!);
    expect(outcome.status).toBe('timeout');
    expect(outcome.error).toContain('model cost cap reached');
    expect(outcome.cost).toEqual({ costUsd: 0.51, tokensIn: 90000, tokensOut: 9000 });
  });

  it('falls back to the opencode usage when the gateway reported nothing', async () => {
    const { store, deps } = setup({ agent: { modelUsage: null } });
    const outcome = await processRun(deps, (await store.claim('w1'))!);
    expect(outcome.cost).toEqual({ costUsd: 0.001, tokensIn: 10, tokensOut: 5 });
  });

  it('timeout: the agent hit the wall limit, the partial patch is still graded and stored', async () => {
    const { store, deps } = setup({ agent: { timedOut: true, agentErrors: ['agent wall limit reached (300 s)'] } });
    const outcome = await processRun(deps, (await store.claim('w1'))!);
    expect(outcome.status).toBe('timeout');
    expect(outcome.patch).toBe(PATCH);
    expect(outcome.error).toContain('wall limit');
  });

  it('invalid: a patch outside src/ is rejected', async () => {
    const { store, deps } = setup({ manifest: { patch_scope: { changed_files: ['tests/x.ts'], allowed: false, violations: ['tests/x.ts'] } } });
    expect((await processRun(deps, (await store.claim('w1'))!)).status).toBe('invalid');
  });

  it('fail: the agent changed nothing', async () => {
    const { store, deps } = setup({ agent: { patch: '' } });
    expect((await processRun(deps, (await store.claim('w1'))!)).status).toBe('fail');
  });

  it('infra_error: the sandbox failed, with the error recorded and no patch', async () => {
    const { store, deps } = setup({ agent: new Error('docker daemon down') });
    const outcome = await processRun(deps, (await store.claim('w1'))!);
    expect(outcome).toMatchObject({ status: 'infra_error', phase: 'done', patch: null, actions: [] });
    expect(outcome.error).toContain('docker daemon down');
  });

  it('infra_error: the agent version has no allowed file', async () => {
    const { store, deps } = setup({ files: [{ path: 'secrets/.env', content: 'x' }] });
    const outcome = await processRun(deps, (await store.claim('w1'))!);
    expect(outcome.status).toBe('infra_error');
    expect(outcome.error).toContain('no AGENTS.md');
  });
});

describe('processRun stored outputs (L17a)', () => {
  const withArtifacts = { artifacts: [TRACE_ARTIFACT, HTML_ARTIFACT], artifactsSkipped: [{ path: 'files/big.json', reason: 'too_large' as const }], agentErrors: ['opencode said sk-or-v1-user and /tmp/itera-run-x/fixture/src/a.ts'] };

  it('a finished run stores result.json first, then the agent artifacts, with the key and the paths scrubbed', async () => {
    const { store, deps } = setup({ agent: withArtifacts });
    const outcome = await processRun(deps, (await store.claim('w1'))!);
    expect(outcome.status).toBe('pass');
    expect(outcome.artifacts!.map((a) => a.path)).toEqual(['result.json', 'agent/trace.jsonl', 'files/out/report.html']);
    expect(store.artifacts.get('run-1')).toEqual(outcome.artifacts);
    const result = outcome.artifacts![0]!;
    expect(result.encoding).toBe('utf-8');
    expect(result.bytes).toBe(Buffer.byteLength(result.content));
    const json = JSON.parse(result.content);
    expect(json).toMatchObject({
      format: 'tma-run-result/1', status: 'pass', phase: 'done', scoreTotal: 100, error: null, model: 'qwen/qwen3-coder', route: 'openrouter',
      agent: { exitCode: 0, timedOut: false, durationMs: 1000 }, cost: { usd: 0.0123, tokensIn: 1200, tokensOut: 300 },
      skipped: [{ path: 'files/big.json', reason: 'too_large' }],
    });
    expect(json.agent.errors).toEqual(['opencode said [redacted] and <tmp>']);
    expect(result.content).not.toContain('sk-or-v1-user');
  });

  it('a grading failure still stores the agent artifacts, with result.json from the failed outcome', async () => {
    const { store, deps } = setup({ agent: withArtifacts });
    deps.grade = async () => {
      throw new Error('grader output is not JSON');
    };
    const outcome = await processRun(deps, (await store.claim('w1'))!);
    expect(outcome.status).toBe('infra_error');
    expect(outcome.artifacts!.map((a) => a.path)).toEqual(['result.json', 'agent/trace.jsonl', 'files/out/report.html']);
    expect(JSON.parse(outcome.artifacts![0]!.content)).toMatchObject({ status: 'infra_error', scoreTotal: 0, error: 'grading failed: grader output is not JSON' });
  });

  it('a run that fails before the agent starts stores nothing', async () => {
    for (const opts of [{ agent: new Error('docker daemon down') }, { noKey: true }, { files: [{ path: 'secrets/.env', content: 'x' }] }]) {
      const { store, deps } = setup(opts);
      const outcome = await processRun(deps, (await store.claim('w1'))!);
      expect(outcome.status).toBe('infra_error');
      expect(outcome.artifacts).toBeUndefined();
      expect(store.artifacts.get('run-1')).toEqual([]);
    }
  });
});

describe('processRun grading', () => {
  it('a grader failure is infra_error with score 0, and keeps the patch and the actions', async () => {
    const { store, deps } = setup();
    deps.grade = async () => {
      throw new Error('grader output is not JSON');
    };
    const outcome = await processRun(deps, (await store.claim('w1'))!);
    expect(outcome).toMatchObject({ status: 'infra_error', scoreTotal: 0, patch: PATCH });
    expect(outcome.actions).toHaveLength(2);
    expect(outcome.error).toContain('grading failed: grader output is not JSON');
  });
  it('a manifest with a 0-test suite is infra_error with score 0, not pass', async () => {
    const { store, deps } = setup({ manifest: { tests: { public_baseline: { total: 0, passed: 0, failed: 0, cases: [] }, public_after_patch: { total: 0, passed: 0, failed: 0, cases: [] }, hidden: { total: 0, passed: 0, failed: 0, cases: [] } } } });
    const outcome = await processRun(deps, (await store.claim('w1'))!);
    expect(outcome.status).toBe('infra_error');
    expect(outcome.scoreTotal).toBe(0);
    expect(outcome.error).toContain('no test executed');
  });
});

describe('processRun model key', () => {
  it('platform key: a run without BYOK uses ITERA_RUNNER_OPENROUTER_KEY (ITERA pays)', async () => {
    const { store, deps, seen } = setup({ noKey: true });
    deps.platformModelKey = 'sk-or-v1-itera-platform';
    const outcome = await processRun(deps, (await store.claim('w1'))!);
    expect(outcome.status).toBe('pass');
    expect(seen.key).toBe('sk-or-v1-itera-platform');
  });
  it('BYOK wins over the platform key when the run carries its own key', async () => {
    const { store, deps, seen } = setup();
    deps.platformModelKey = 'sk-or-v1-itera-platform';
    await processRun(deps, (await store.claim('w1'))!);
    expect(seen.key).toBe('sk-or-v1-user');
  });
  it('infra_error without running the agent when there is no BYOK key and no platform key', async () => {
    const { store, deps, seen } = setup({ noKey: true });
    const outcome = await processRun(deps, (await store.claim('w1'))!);
    expect(outcome.status).toBe('infra_error');
    expect(outcome.error).toContain('ITERA_RUNNER_OPENROUTER_KEY');
    expect(seen.key).toBeUndefined();
  });
  it('infra_error when the BYOK key was sealed with another secret (never a silent switch to the platform key)', async () => {
    const { store, deps, seen } = setup();
    deps.runKeySecret = 'o'.repeat(40);
    deps.platformModelKey = 'sk-or-v1-itera-platform';
    expect((await processRun(deps, (await store.claim('w1'))!)).status).toBe('infra_error');
    expect(seen.key).toBeUndefined();
  });
});

describe('processRun route (K10)', () => {
  it('an opencode-go/<model> agent runs on ITERA\'s opencode go key, never the OpenRouter key', async () => {
    const { store, deps, seen } = setup({ noKey: true, model: 'opencode-go/deepseek-v4.1-flash' });
    deps.platformModelKey = 'sk-or-v1-itera-platform';
    deps.opencodeGoKey = 'sk-opencode-go';
    expect((await processRun(deps, (await store.claim('w1'))!)).status).toBe('pass');
    expect(seen.key).toBe('sk-opencode-go');
    expect(seen.model).toBe('opencode-go/deepseek-v4.1-flash');
  });
  it('infra_error without running the agent when OPENCODE_GO_API_KEY is not set', async () => {
    const { store, deps, seen } = setup({ noKey: true, model: 'opencode-go/deepseek-v4.1-flash' });
    deps.platformModelKey = 'sk-or-v1-itera-platform';
    const outcome = await processRun(deps, (await store.claim('w1'))!);
    expect(outcome.status).toBe('infra_error');
    expect(outcome.error).toContain('OPENCODE_GO_API_KEY');
    expect(seen.key).toBeUndefined();
  });
  it('a BYOK key cannot pay the opencode-go route', async () => {
    const { store, deps, seen } = setup({ model: 'opencode-go/deepseek-v4.1-flash' });
    deps.opencodeGoKey = 'sk-opencode-go';
    const outcome = await processRun(deps, (await store.claim('w1'))!);
    expect(outcome.status).toBe('infra_error');
    expect(outcome.error).toContain('BYOK');
    expect(seen.key).toBeUndefined();
  });
});

describe('processRun provenance + rate limits (K11)', () => {
  const usage = { costUsd: 0, tokensIn: 100, tokensOut: 10, calls: 3, refused: 0, maxCostUsd: 0.5, capStopped: false, costSource: 'metered' as const, providers: { Nvidia: 3 }, requestedModels: { 'nvidia/x:free': 3 }, params: { temperature: 0 } };
  it('records route, requested/effective model, provider, cost source and limits on the outcome', async () => {
    const { store, deps } = setup({ noKey: true, agent: { modelUsage: { ...usage, rateLimited: 1, rateLimitedFinal: 0, effectiveModels: { 'nvidia/x-20261001:free': 3 } } } });
    deps.platformModelKey = 'sk-or-v1-itera-platform';
    const outcome = await processRun(deps, (await store.claim('w1'))!);
    expect(outcome.status).toBe('pass');
    expect(outcome.provenance).toMatchObject({
      route: 'openrouter', modelRequested: 'qwen/qwen3-coder', modelEffective: 'nvidia/x-20261001:free', modelProvider: 'Nvidia', costSource: 'metered', rateLimited: 1, wallMs: 1000,
    });
    const rec = outcome.provenance!.record as { params: { request: unknown; run_profile: string }; resources: { sandbox: { cpus: string } }; limits: { wall_ms_cap: number } };
    expect(rec.params).toMatchObject({ run_profile: 'opencode', request: { temperature: 0 } });
    expect(rec.resources.sandbox.cpus).toBe('2');
    expect(rec.limits.wall_ms_cap).toBeGreaterThan(0);
  });
  it('a 429 that survived the gateway retries turns a fail into infra_error with a rate-limit error (never a model fail)', async () => {
    const { store, deps } = setup({ noKey: true, agent: { patch: '', modelUsage: { ...usage, rateLimited: 5, rateLimitedFinal: 1, effectiveModels: {} } } });
    deps.platformModelKey = 'sk-or-v1-itera-platform';
    const outcome = await processRun(deps, (await store.claim('w1'))!);
    expect(outcome.status).toBe('infra_error');
    expect(outcome.scoreTotal).toBe(0);
    expect(outcome.error).toContain('429');
  });
  it('a run that passed despite a final 429 keeps its pass', async () => {
    const { store, deps } = setup({ noKey: true, agent: { modelUsage: { ...usage, rateLimited: 5, rateLimitedFinal: 1, effectiveModels: {} } } });
    deps.platformModelKey = 'sk-or-v1-itera-platform';
    expect((await processRun(deps, (await store.claim('w1'))!)).status).toBe('pass');
  });
});

describe('workerLoop', () => {
  it('claims every queued run and stops when aborted', async () => {
    const { store, deps } = setup();
    store.enqueue({ runId: 'run-2', scenarioId: 'tsk_webhook_dup', scenarioVersion: '1', agentVersionId: null }, null);
    const controller = new AbortController();
    const loop = workerLoop(deps, { concurrency: 2, pollMs: 5, staleMs: 60_000, signal: controller.signal });
    for (let i = 0; i < 100 && store.outcomes.size < 2; i++) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await loop;
    expect(store.runs.get('run-1')!.status).toBe('pass');
    expect(store.runs.get('run-2')!.status).toBe('infra_error');
  });
});

describe('CLAIM_SQL', () => {
  it('is the contract claim: oldest queued run, FOR UPDATE SKIP LOCKED', () => {
    const sql = CLAIM_SQL.replace(/\s+/g, ' ');
    expect(sql).toContain("set status = 'running', phase = 'preparing', claimed_at = now(), worker_id = $1");
    expect(sql).toContain("where status = 'queued' order by started_at for update skip locked limit 1");
  });
});

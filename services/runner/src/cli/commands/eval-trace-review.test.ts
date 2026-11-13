// Tests of `tma eval upload --mode trace_review` (plan 20261112-tma-c3-eval-repo-kit-docs, C3-T9): a recorded Claude
// Code session (a small SYNTHETIC fixture, test/claude-code-session.jsonl) becomes ONE run of the baseline variant
// "recorded session", with its trajectory, the recorded grading and an optional human label. Docker never runs; the
// API is a fake fetch.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_DIFF_SHA256, validateLocalResultV2, validateLocalResultV3 } from '@itera/contracts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { EvidenceManifest } from '../../../../evaluator/src/types.js';
import { EVALUATOR_VERSION } from '../../../../evaluator/src/runner.js';
import { defaultSandboxConfig } from '../../sandbox.js';
import type { Command } from '../command.js';
import { CliError, sandboxEnv } from '../env.js';
import type { EvalDeps } from '../eval/runs.js';
import { claudeCodeSessionFacts, humanGraderDigest, readHumanLabel } from '../eval/trace-review.js';
import { SESSION_FORMAT, writeSession } from '../session.js';
import { API, captureIo, tempEnv, TOKEN } from '../test/fixtures.js';
import { makeEvalCommand as makeRaw } from './eval.js';

const FIXTURE = join(import.meta.dirname, '..', 'test', 'task-fixture');
const SESSION = join(import.meta.dirname, '..', 'test', 'claude-code-session.jsonl');
const AGENT = '0b6f3c2e-1d4a-4c8e-9f00-123456789abc';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const PATCH = 'diff --git a/lib/add.js b/lib/add.js\n--- a/lib/add.js\n+++ b/lib/add.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n';

const made: string[] = [];
const tmp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `tma-eval-tr-${name}-`));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function makeEvalCommand(deps?: EvalDeps): Command {
  const cmd = makeRaw(deps);
  return {
    ...cmd,
    main: async (argv, io) => {
      try {
        return await cmd.main(argv, io);
      } catch (e) {
        if (!(e instanceof CliError)) throw e;
        io.err(e.message);
        return 1;
      }
    },
  };
}

function manifest(): EvidenceManifest {
  const suite = { total: 3, passed: 3, failed: 0, state: 'ok' };
  return {
    score: { total: 100, public_behavior: 20, hidden_behavior: 50, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5 },
    patch_scope: { allowed: true },
    tests: { public_baseline: { ...suite, passed: 1, failed: 2 }, public_after_patch: suite, hidden: { total: 4, passed: 4, failed: 0, state: 'ok' } },
    errors: [],
    environment: { executor: { image_id: IMAGE_ID } },
  } as unknown as EvidenceManifest;
}

function loggedIn(): NodeJS.ProcessEnv {
  const env = tempEnv();
  writeSession({ format: SESSION_FORMAT, api_url: API, principal: 'dfl:x', session_id: 's', session_token: TOKEN, expires_at: '2099-01-01T00:00:00.000Z' }, env);
  return env;
}

function deps(over: Partial<EvalDeps> = {}): EvalDeps {
  return {
    env: tempEnv(),
    grade: async () => manifest(),
    sandbox: async (profile) => ({ config: defaultSandboxConfig(sandboxEnv(profile, {})), imageId: IMAGE_ID }),
    ...over,
  };
}

function fakeApi(status = 201, action = 'inserted') {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ evaluation_id: 'e0e0e0e0-1111-4222-8333-444444444444', run_id: 'r', action, url: 'https://web2.test/evaluations/e0' }), { status }),
  );
}

/** A trace_review case folder with its recorded output (a patch), optionally graded. */
async function traceCase(opts: { grade?: boolean; caseOver?: Record<string, unknown> } = {}) {
  const src = tmp('src');
  writeFileSync(join(src, 'recorded.patch'), PATCH);
  writeFileSync(join(src, 'case.json'), JSON.stringify({
    schema: 'tma-case/1', case_key: 'tiny-add-review', use_case: 'fix/red-ci', mode: 'trace_review', answer_shape: 'single', pin: null,
    task_ref: { kind: 'tma-task', id: 'task-fixture@3' },
    expected: { text: 'add() returns the sum.', written_by: 'claude-main', written_at: '2026-11-12T18:00:00Z' },
    graders: [{ id: 'hidden-tests', version: EVALUATOR_VERSION, weight: 1, hard_gate: true }], split: 'none', source: 'synthetic',
    ...opts.caseOver,
  }));
  const dir = join(tmp('case'), 'c');
  const cmd = makeEvalCommand(deps());
  const io = captureIo();
  expect(await cmd.main(['case', '--case', join(src, 'case.json'), '--dest', dir, '--task-dir', FIXTURE, '--recorded', join(src, 'recorded.patch')], io), io.errText()).toBe(0);
  expect(io.outText()).toMatch(/tma eval upload --mode trace_review/);
  if (opts.grade !== false) {
    const io2 = captureIo();
    expect(await cmd.main(['grade', '--case', dir], io2), io2.errText()).toBe(0);
  }
  return { dir, src };
}

/** Run `tma eval upload --mode trace_review --dry-run` while logged in; return the body that was sent. */
async function dryRun(dir: string, extra: string[] = []) {
  const f = fakeApi(200);
  const io = captureIo();
  const code = await makeEvalCommand(deps({ env: loggedIn(), fetchImpl: f as unknown as typeof fetch })).main(
    ['upload', '--mode', 'trace_review', '--case', dir, '--session', SESSION, '--agent', AGENT, '--dry-run', ...extra],
    io,
  );
  const call = f.mock.calls[0] as unknown as [string, RequestInit] | undefined;
  return { code, io, url: call?.[0], body: call ? JSON.parse(String(call[1].body)) : null };
}

const writeLabel = (value: unknown) => {
  const p = join(tmp('label'), 'label.json');
  writeFileSync(p, JSON.stringify(value));
  return p;
};

describe('the session facts', () => {
  it('reads the harness version, the model and the first and last timestamps, nothing else', () => {
    expect(claudeCodeSessionFacts(readFileSync(SESSION, 'utf-8'))).toEqual({
      harnessVersion: '2.1.87', model: 'claude-sonnet-4-5', firstMs: Date.parse('2026-11-12T18:00:00.000Z'), lastMs: Date.parse('2026-11-12T18:00:21.000Z'),
    });
  });
});

describe('the human label', () => {
  it('takes the closed keys and refuses free text, an e-mail labeler and an unknown reason', () => {
    expect(readHumanLabel({ grader_id: 'human-review', version: '1.0.0', pass: true }, 'l')).toEqual({
      grader_id: 'human-review', version: '1.0.0', pass: true, score: null, labeler: null, reason_code: null, code_sha256: null,
    });
    expect(() => readHumanLabel({ grader_id: 'human-review', version: '1.0.0', pass: true, note: 'it looked fine to me' }, 'l')).toThrow(/note: unknown key/);
    expect(() => readHumanLabel({ grader_id: 'human-review', version: '1.0.0', pass: true, labeler: 'sam@example.com' }, 'l')).toThrow(/labeler/);
    expect(() => readHumanLabel({ grader_id: 'human-review', version: '1.0.0', pass: true, reason_code: 'bad' }, 'l')).toThrow(/reason_code/);
    expect(() => readHumanLabel({ grader_id: 'Human Review', version: '1', pass: 'yes' }, 'l')).toThrow(/grader_id[\s\S]*version[\s\S]*pass/);
  });
});

describe('tma eval upload --mode trace_review', () => {
  it('a graded recorded session is ONE run of the baseline variant with its trajectory, as tma-local-result/2', async () => {
    const { dir } = await traceCase();
    const { code, io, url, body } = await dryRun(dir);
    expect(code, io.errText()).toBe(0);
    expect(url).toBe(`${API}/self-declared-results?dry_run=1`);
    expect(validateLocalResultV2(body).ok).toBe(true);
    expect(body.format).toBe('tma-local-result/2');
    expect(body.case).toMatchObject({ case_key: 'tiny-add-review', mode: 'trace_review', origin_pin_sha256: null, use_case_key: 'fix/red-ci' });
    expect(body.variant).toEqual({
      agent: { harness: 'claude-code', harness_version: '2.1.87', harness_repo_sha: null, model_id: 'anthropic/claude-sonnet-4.5', rules_sha256: null, skills_sha256: null, mcp_manifest_sha256: null, tools_sha256: null },
      variant_sha256: EMPTY_DIFF_SHA256, label: 'recorded session', change_kind: 'none',
    });
    expect(body.comparison).toEqual({ is_baseline: true, prediction_sha256: null });
    expect(body.executor).toMatchObject({ model_id: 'anthropic/claude-sonnet-4.5', harness: 'claude-code', cost_source: 'none' });
    expect(body.runner).toMatchObject({ execution: 'external', profile: null });
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ repeat: 1, status: 'pass', score: 100, infra_ok: true, wall_s: 21 });
    expect(body.runs[0].graders).toEqual([expect.objectContaining({ id: 'hidden-tests', kind: 'code', pass: true, decisive: true })]);
    expect(body.runs[0].trajectory.format).toBe('tma-trajectory/1');
    expect(body.runs[0].trajectory.steps.map((s: { tool: string; target_redacted: string | null }) => [s.tool, s.target_redacted])).toEqual([
      ['Read', 'lib/add.js'], ['Edit', 'lib/add.js'], ['Bash', 'npm test'],
    ]);
    expect(body.ran_from).toBe('2026-11-12T18:00:00.000Z');
    expect(body.ran_to).toBe('2026-11-12T18:00:21.000Z');
    // Nothing of the session text and no patch leaves.
    const text = JSON.stringify(body);
    expect(text).not.toContain('SYNTHETIC');
    expect(text).not.toContain('a + b');
    expect(io.errText()).toMatch(/3 steps/);
  });

  it('a label with labeler and reason_code is a human grader result, and the body becomes tma-local-result/3', async () => {
    const { dir } = await traceCase();
    const label = writeLabel({ grader_id: 'human-review', version: '1.0.0', pass: false, score: 40, labeler: 'tainan', reason_code: 'partial' });
    const { code, io, body } = await dryRun(dir, ['--label-file', label]);
    expect(code, io.errText()).toBe(0);
    expect(validateLocalResultV3(body).ok).toBe(true);
    expect(body.format).toBe('tma-local-result/3');
    expect(body.runs[0].graders).toEqual([
      expect.objectContaining({ id: 'hidden-tests', kind: 'code' }),
      { id: 'human-review', semver: '1.0.0', code_sha256: humanGraderDigest('human-review', '1.0.0'), kind: 'human', pass: false, score: 40, weight: 0, hard_gate: false, decisive: false, labeler: 'tainan', reason_code: 'partial' },
    ]);
    // The code grading decides the run; a label the case does not list is a side signal.
    expect(body.runs[0].status).toBe('pass');
  });

  it('a label without the /3 fields stays tma-local-result/2; --label-only sends the human grader alone', async () => {
    const { dir } = await traceCase();
    const label = writeLabel({ grader_id: 'human-review', version: '1.0.0', pass: true });
    const plain = await dryRun(dir, ['--label-file', label]);
    expect(plain.code, plain.io.errText()).toBe(0);
    expect(plain.body.format).toBe('tma-local-result/2');
    expect(plain.body.runs[0].graders.map((g: { kind: string }) => g.kind)).toEqual(['code', 'human']);
    const only = await dryRun(dir, ['--label-file', label, '--label-only']);
    expect(only.code, only.io.errText()).toBe(0);
    expect(only.body.runs[0].graders).toEqual([expect.objectContaining({ id: 'human-review', kind: 'human' })]);
    // The same run key: the API finds the same row and adds the grader row.
    expect(only.body.runs[0]).toMatchObject({ item_sha256: plain.body.runs[0].item_sha256, repeat: 1 });
    expect(only.body.variant).toEqual(plain.body.variant);
  });

  it('an ungraded session takes its status from the label; a grader the case lists is decisive, with its weight', async () => {
    const { dir } = await traceCase({
      grade: false,
      caseOver: { graders: [{ id: 'hidden-tests', version: EVALUATOR_VERSION, weight: 1, hard_gate: true }, { id: 'human-review', version: '1.0.0', weight: 2, hard_gate: false }] },
    });
    const label = writeLabel({ grader_id: 'human-review', version: '1.0.0', pass: false, labeler: 'sam' });
    const { code, io, body } = await dryRun(dir, ['--label-file', label]);
    expect(code, io.errText()).toBe(0);
    expect(io.errText()).toMatch(/come from the label/);
    expect(body.runs[0]).toMatchObject({ status: 'fail', score: 0, parts: null });
    expect(body.runs[0].graders).toEqual([expect.objectContaining({ id: 'human-review', kind: 'human', weight: 2, hard_gate: false, decisive: true, labeler: 'sam' })]);
    const wrong = writeLabel({ grader_id: 'human-review', version: '2.0.0', pass: true });
    expect((await dryRun(dir, ['--label-file', wrong])).io.errText()).toMatch(/lists grader human-review at 1\.0\.0/);
  });

  it('a task summary in the upload charset goes up and makes the body /3', async () => {
    const { dir } = await traceCase({ caseOver: { task_summary: { before: 'add() returns a - b', expected: 'add() returns a + b, tests green' } } });
    const { code, io, body } = await dryRun(dir);
    expect(code, io.errText()).toBe(0);
    expect(body.format).toBe('tma-local-result/3');
    expect(body.case.task_summary).toEqual({ before: 'add() returns a - b', expected: 'add() returns a + b, tests green' });
  });

  it('refuses: no grade and no label, --label-only without a label, the wrong mode, a variant dir, a free-text label', async () => {
    const { dir } = await traceCase({ grade: false });
    expect((await dryRun(dir)).io.errText()).toMatch(/has no grade: run tma eval grade/);
    expect((await dryRun(dir, ['--label-only'])).io.errText()).toMatch(/--label-only needs --label-file/);
    expect((await dryRun(dir, ['--variant-dir', dir])).io.errText()).toMatch(/--variant-dir is for a replay case/);
    expect((await dryRun(dir, ['--variant-label', 'line\none'])).io.errText()).toMatch(/--variant-label/);
    const io = captureIo();
    expect(await makeEvalCommand(deps({ env: loggedIn() })).main(['upload', '--case', dir, '--agent', AGENT, '--dry-run'], io)).toBe(1);
    expect(io.errText()).toMatch(/give --mode trace_review/);
  });

  it('a real upload needs a login and posts to the self-declared door', async () => {
    const { dir } = await traceCase();
    const io = captureIo();
    expect(await makeEvalCommand(deps({ env: tempEnv() })).main(['upload', '--mode', 'trace_review', '--case', dir, '--session', SESSION, '--agent', AGENT], io)).toBe(1);
    expect(io.errText()).toMatch(/login/);
    const f = fakeApi(201);
    const io2 = captureIo();
    expect(await makeEvalCommand(deps({ env: loggedIn(), fetchImpl: f as unknown as typeof fetch })).main(['upload', '--mode', 'trace_review', '--case', dir, '--session', SESSION, '--agent', AGENT], io2), io2.errText()).toBe(0);
    expect(io2.outText()).toMatch(/tiny-add-review \/ recorded session: inserted\. Evaluation e0e0e0e0/);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(`${API}/self-declared-results`);
  });
});

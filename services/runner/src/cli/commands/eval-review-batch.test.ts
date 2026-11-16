// Tests of `tma eval review-batch` (plan 20261112-tma-c6-judge-calibration, task C6-UPLOAD): a batch of recorded
// Claude Code sessions (the SYNTHETIC fixture test/claude-code-session.jsonl, invented pin digests) becomes one
// ungraded review run per row. The API is a fake fetch; nothing leaves the test.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealPin, validateLocalResultV3 } from '@itera/contracts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Command } from '../command.js';
import { CliError } from '../env.js';
import { buildReviewBatchBody, parseJudge, parseReviewBatch, recordedTaskRef, REVIEW_BATCH_FORMAT } from '../eval/review-batch.js';
import { SESSION_FORMAT, writeSession } from '../session.js';
import { AGENT, API, captureIo, tempEnv, TOKEN } from '../test/fixtures.js';
import { makeEvalCommand as makeRaw } from './eval.js';

const SESSION = join(import.meta.dirname, '..', 'test', 'claude-code-session.jsonl');
const H = (c: string) => c.repeat(64);
const G = (c: string) => c.repeat(40);
const JUDGE = 'async-wait-lifecycle@0.1.0';

const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tma-review-batch-'));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function makeEvalCommand(deps = {}): Command {
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

/** A sealed tma-pin/1; `partial` = the MCP manifest and the model were not recovered. */
function pin(partial = false): Record<string, any> {
  const record: Record<string, any> = {
    format: 'tma-pin/1', repo: 'devfellowship/dfl-example', base_sha: G('a'), harness: 'claude-code', harness_version: '2.1.87',
    harness_repo_sha: G('b'), rules_sha256: H('c'), skills_sha256: [H('1'), H('2')], model_id: 'claude-opus-5-5', mcp_manifest_sha256: H('d'),
    input_sha256: H('f'),
    completeness: {
      repo: 'exact', base_sha: 'derived', harness: 'exact', harness_version: 'exact', harness_repo_sha: 'derived', rules_sha256: 'derived',
      skills_sha256: 'derived', model_id: 'derived', mcp_manifest_sha256: 'derived', input_sha256: 'exact',
    },
  };
  if (partial) {
    record.mcp_manifest_sha256 = null;
    record.model_id = null;
    record.completeness = { ...record.completeness, mcp_manifest_sha256: 'missing', model_id: 'missing' };
  }
  return sealPin(record);
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  const p = pin();
  return {
    schema: REVIEW_BATCH_FORMAT, case_key: 'trace-4da84c52-a1b2c3d4', use_case: 'build/feature', task_ref: { kind: 'dfl-task', id: '4da84c52-97a3-4657-8d8c-7cb1b9601974' },
    task_label: 'DFL-01810', pin: { pin_sha256: p.pin_sha256, record: p }, session_file: SESSION,
    task_summary: { before: 'A PR waits for CI.', expected: 'The run starts a watcher and ends its turn.' },
    ...over,
  };
}

function batchFile(rows: Record<string, unknown>[]): string {
  const f = join(tmp(), 'batch.jsonl');
  writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
}

function loggedIn(): NodeJS.ProcessEnv {
  const env = tempEnv();
  writeSession({ format: SESSION_FORMAT, api_url: API, principal: 'dfl:x', session_id: 's', session_token: TOKEN, expires_at: '2099-01-01T00:00:00.000Z' }, env);
  return env;
}

/** A fake API that answers `inserted` for a new import digest and `unchanged` for one it has seen. */
function fakeApi() {
  const seen = new Set<string>();
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    const action = seen.has(body) ? 'unchanged' : 'inserted';
    seen.add(body);
    return new Response(JSON.stringify({ evaluation_id: 'e0e0e0e0-1111-4222-8333-444444444444', run_ids: ['r'], action, url: 'https://web2.test/e' }), { status: action === 'inserted' ? 201 : 200 });
  });
}

const sentBodies = (f: ReturnType<typeof fakeApi>) => f.mock.calls.map((c) => JSON.parse(String(c[1]?.body)));

describe('tma eval review-batch: rows', () => {
  it('reads a valid row and refuses an unknown key, a bad pin digest, a codex pin and a relative session path', () => {
    expect(parseReviewBatch(JSON.stringify(row()), 'b')).toHaveLength(1);
    expect(() => parseReviewBatch(JSON.stringify(row({ prompt: 'x' })), 'b')).toThrow(/prompt: unknown key/);
    const p = pin();
    expect(() => parseReviewBatch(JSON.stringify(row({ pin: { pin_sha256: H('9'), record: p } })), 'b')).toThrow(/does not match/);
    const codex = sealPin({ ...pin(), pin_sha256: undefined, harness: 'codex' } as Record<string, unknown>);
    expect(() => parseReviewBatch(JSON.stringify(row({ pin: { pin_sha256: codex.pin_sha256, record: codex } })), 'b')).toThrow(/Claude Code sessions only/);
    expect(() => parseReviewBatch(JSON.stringify(row({ session_file: 'rel/s.jsonl' })), 'b')).toThrow(/absolute path/);
  });

  it('refuses a repeated case_key and an empty file', () => {
    expect(() => parseReviewBatch([row(), row()].map((r) => JSON.stringify(r)).join('\n'), 'b')).toThrow(/repeats an earlier row/);
    expect(() => parseReviewBatch('\n\n', 'b')).toThrow(/no row/);
  });

  it('parses --judge id@semver only', () => {
    expect(parseJudge(JUDGE)).toEqual({ id: 'async-wait-lifecycle', version: '0.1.0' });
    expect(() => parseJudge('async-wait-lifecycle')).toThrow(/<judge id>@<semver>/);
  });

  it('gives every session of one task the same local task ref', () => {
    const a = recordedTaskRef(parseReviewBatch(JSON.stringify(row()), 'b')[0]!);
    const b = recordedTaskRef(parseReviewBatch(JSON.stringify(row({ case_key: 'trace-other' })), 'b')[0]!);
    expect(a).toEqual(b);
    expect(a.task).toMatchObject({ local: { slug: 'dfl-task-4da84c52-97a3-4657-8d8c-7cb1b9601974', name: 'Recorded task DFL-01810' } });
  });
});

describe('tma eval review-batch: body', () => {
  it('is one ungraded baseline run with the trajectory: graders [], infra_ok false, the pin as origin', async () => {
    const r = parseReviewBatch(JSON.stringify(row()), 'b')[0]!;
    const { body } = await buildReviewBatchBody(r, { agentId: AGENT, judges: [parseJudge(JUDGE)] });
    // The trajectory is tma-trajectory/2 (step kind and start time), so the body is tma-local-result/3.
    expect(body.format).toBe('tma-local-result/3');
    expect(validateLocalResultV3(body).ok).toBe(true);
    expect(body.runs).toHaveLength(1);
    const steps = body.runs[0]!.trajectory!.steps as unknown as Array<Record<string, unknown>>;
    expect(body.runs[0]!.trajectory!.format).toBe('tma-trajectory/2');
    expect(steps.every((x) => typeof x.step_kind === 'string')).toBe(true);
    expect(steps.some((x) => typeof x.started_ms === 'number')).toBe(true);
    expect(body.runs[0]).toMatchObject({ repeat: 1, status: 'invalid', score: 0, infra_ok: false, graders: [] });
    expect(body.runs[0]!.trajectory!.steps.length).toBeGreaterThan(0);
    expect(body.case).toMatchObject({ case_key: 'trace-4da84c52-a1b2c3d4', mode: 'trace_review', use_case_key: 'build/feature', origin_pin_sha256: r.pin.pin_sha256 });
    expect(body.case).not.toHaveProperty('task_summary');
    expect(body.variant).toMatchObject({ label: 'recorded session', change_kind: 'none' });
    expect(body.variant.agent.model_id).toBe('anthropic/claude-opus-5.5');
    expect(body.comparison).toEqual({ is_baseline: true, prediction_sha256: null });
    expect(body.ran_from).toBe('2026-11-12T18:00:00.000Z');
  });

  it('keeps the session text on the host: no prompt, reply or file path body in the upload', async () => {
    const r = parseReviewBatch(JSON.stringify(row()), 'b')[0]!;
    const text = JSON.stringify((await buildReviewBatchBody(r, { agentId: AGENT, judges: [parseJudge(JUDGE)] })).body);
    expect(text).not.toMatch(/SYNTHETIC/);
    expect(text).not.toMatch(/A PR waits for CI/);
  });

  it('sends the task summary only with --with-summary, and never one outside the upload charset', async () => {
    const r = parseReviewBatch(JSON.stringify(row()), 'b')[0]!;
    const { body } = await buildReviewBatchBody(r, { agentId: AGENT, judges: [parseJudge(JUDGE)], withSummary: true });
    expect(body.format).toBe('tma-local-result/3');
    expect(body.case.task_summary).toEqual({ before: 'A PR waits for CI.', expected: 'The run starts a watcher and ends its turn.' });
    const odd = parseReviewBatch(JSON.stringify(row({ task_summary: { before: 'uses `backticks`', expected: 'ok' } })), 'b')[0]!;
    const out = await buildReviewBatchBody(odd, { agentId: AGENT, judges: [parseJudge(JUDGE)], withSummary: true });
    expect(out.body.case).not.toHaveProperty('task_summary');
    expect(out.notes.join('\n')).toMatch(/stays on this host/);
  });

  it('takes the model from the session when the pin has none (a partial pin is fine for review)', async () => {
    const p = pin(true);
    const r = parseReviewBatch(JSON.stringify(row({ pin: { pin_sha256: p.pin_sha256, record: p } })), 'b')[0]!;
    const { body, notes } = await buildReviewBatchBody(r, { agentId: AGENT, judges: [parseJudge(JUDGE)] });
    expect(body.variant.agent.model_id).toBe('anthropic/claude-sonnet-4.5');
    expect(body.variant.agent.mcp_manifest_sha256).toBeNull();
    expect(notes.join('\n')).toMatch(/the pin has no model/);
  });

  it('is the same body for the same row (idempotent); another judge list is another case manifest', async () => {
    const r = parseReviewBatch(JSON.stringify(row()), 'b')[0]!;
    const a = await buildReviewBatchBody(r, { agentId: AGENT, judges: [parseJudge(JUDGE)] });
    const b = await buildReviewBatchBody(r, { agentId: AGENT, judges: [parseJudge(JUDGE)] });
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
    const c = await buildReviewBatchBody(r, { agentId: AGENT, judges: [parseJudge(JUDGE), parseJudge('external-block-handling@0.1.0')] });
    expect(c.body.case.manifest_sha256).not.toBe(a.body.case.manifest_sha256);
  });

  it('refuses a session file that cannot be read', async () => {
    const r = parseReviewBatch(JSON.stringify(row({ session_file: '/nonexistent/s.jsonl' })), 'b')[0]!;
    await expect(buildReviewBatchBody(r, { agentId: AGENT, judges: [parseJudge(JUDGE)] })).rejects.toThrow(/cannot read the session file/);
  });
});

describe('tma eval review-batch: command', () => {
  it('uploads each row once; a second run answers unchanged for every row', async () => {
    const f = batchFile([row(), row({ case_key: 'trace-second-session' })]);
    const fetchImpl = fakeApi();
    const env = loggedIn();
    const cmd = makeEvalCommand({ env, fetchImpl });
    const io1 = captureIo();
    expect(await cmd.main(['review-batch', '--batch', f, '--agent', AGENT, '--judge', JUDGE], io1)).toBe(0);
    expect(io1.outText()).toMatch(/review-batch: 2 row\(s\): inserted 2/);
    const io2 = captureIo();
    expect(await cmd.main(['review-batch', '--batch', f, '--agent', AGENT, '--judge', JUDGE], io2)).toBe(0);
    expect(io2.outText()).toMatch(/review-batch: 2 row\(s\): unchanged 2/);
    const bodies = sentBodies(fetchImpl);
    expect(bodies.map((b) => b.case.case_key)).toEqual(['trace-4da84c52-a1b2c3d4', 'trace-second-session', 'trace-4da84c52-a1b2c3d4', 'trace-second-session']);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${API}/self-declared-results`);
  });

  it('stops before any network call when one row is bad', async () => {
    const f = batchFile([row(), row({ case_key: 'trace-missing', session_file: '/nonexistent/s.jsonl' })]);
    const fetchImpl = fakeApi();
    const io = captureIo();
    expect(await makeEvalCommand({ env: loggedIn(), fetchImpl }).main(['review-batch', '--batch', f, '--agent', AGENT, '--judge', JUDGE], io)).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(io.errText()).toMatch(/trace-missing: cannot read the session file/);
  });

  it('needs a judge, a login for a real upload, and honours --limit and --dry-run', async () => {
    const f = batchFile([row(), row({ case_key: 'trace-second-session' })]);
    const io = captureIo();
    expect(await makeEvalCommand({ env: loggedIn(), fetchImpl: fakeApi() }).main(['review-batch', '--batch', f, '--agent', AGENT], io)).toBe(1);
    expect(io.errText()).toMatch(/--judge/);
    const io2 = captureIo();
    expect(await makeEvalCommand({ env: tempEnv(), fetchImpl: fakeApi() }).main(['review-batch', '--batch', f, '--agent', AGENT, '--judge', JUDGE], io2)).toBe(1);
    const fetchImpl = fakeApi();
    const io3 = captureIo();
    expect(await makeEvalCommand({ env: loggedIn(), fetchImpl }).main(['review-batch', '--batch', f, '--agent', AGENT, '--judge', JUDGE, '--limit', '1', '--dry-run'], io3)).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toMatch(/dry_run=1/);
    expect(io3.outText()).toMatch(/1 row\(s\) \(dry run\)/);
    const io4 = captureIo();
    expect(await makeEvalCommand({ env: tempEnv(), fetchImpl: fakeApi() }).main(['review-batch', '--batch', f, '--agent', AGENT, '--judge', JUDGE, '--dry-run'], io4)).toBe(0);
    expect(io4.errText()).toMatch(/2 bodies are valid/);
  });
});

// Tests of `tma eval judge labels` (plan 20261112-tma-c6-judge-calibration, task C6-T5): the labels of review runs
// read back from the TMA API as dfl-evals tma-calibration-label/1 rows. SYNTHETIC fixtures only (invented task, run and
// person ids); the API is a fake fetch, so nothing leaves the test.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealPin } from '@itera/contracts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Command } from '../command.js';
import { CliError } from '../env.js';
import { chooseLabel, reasonCodeOf, type ApiLabel } from '../eval/calibration-labels.js';
import { REVIEW_BATCH_FORMAT } from '../eval/review-batch.js';
import { SESSION_FORMAT, writeSession } from '../session.js';
import { API, captureIo, tempEnv, TOKEN } from '../test/fixtures.js';
import { makeEvalCommand as makeRaw } from './eval.js';

const H = (c: string) => c.repeat(64);
const G = (c: string) => c.repeat(40);
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const T3 = '33333333-3333-4333-8333-333333333333';
const RUN1 = 'c1111111-1111-4111-8111-111111111111';
const RUN2 = 'd2222222-2222-4222-8222-222222222222';
const RUN3 = 'e3333333-3333-4333-8333-333333333333';
const PERSON = 'person:13efcd4f-a9b9-44bd-86b0-ed01eba0443e';
const PERSON2 = 'person:99999999-9999-4999-8999-999999999999';
const AGENT = 'agent:2955dc86-93a4-4e61-8c4d-614fb8c132b4';
const JUDGE = 'async-wait-lifecycle';

const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tma-judge-labels-'));
  made.push(dir);
  return dir;
};
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

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

function pin(model: string | null = 'anthropic/claude-opus-5.5'): Record<string, any> {
  return sealPin({
    format: 'tma-pin/1', repo: 'devfellowship/dfl-example', base_sha: G('a'), harness: 'claude-code', harness_version: '2.1.87',
    harness_repo_sha: G('b'), rules_sha256: H('c'), skills_sha256: [H('1')], model_id: model as string, mcp_manifest_sha256: H('d'),
    input_sha256: H('f'),
    completeness: {
      repo: 'exact', base_sha: 'derived', harness: 'exact', harness_version: 'exact', harness_repo_sha: 'derived', rules_sha256: 'derived',
      skills_sha256: 'derived', model_id: 'derived', mcp_manifest_sha256: 'derived', input_sha256: 'exact',
    },
  });
}

function row(caseKey: string, task: string, model?: string): Record<string, unknown> {
  const p = pin(model);
  return {
    schema: REVIEW_BATCH_FORMAT, case_key: caseKey, use_case: 'build/feature', task_ref: { kind: 'dfl-task', id: task },
    pin: { pin_sha256: p.pin_sha256, record: p }, session_file: '/root/.claude/projects/-root/x.jsonl',
    task_summary: { before: 'SECRET-TASK-TEXT before', expected: 'SECRET-TASK-TEXT expected' },
  };
}
const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

function loggedIn(): NodeJS.ProcessEnv {
  const env = tempEnv();
  writeSession({ format: SESSION_FORMAT, api_url: API, principal: 'dfl:x', session_id: 's', session_token: TOKEN, expires_at: '2099-01-01T00:00:00.000Z' }, env);
  return env;
}

const lab = (runId: string, over: Partial<ApiLabel>): ApiLabel => ({ runId, judgeId: JUDGE, pass: true, reasonCode: null, labeler: PERSON, gradedAt: '2026-11-17T01:00:00.000Z', strength: 'strong', ...over });

/** Case A (T1): a weak workflow pass, then a later person FAIL. Case B (T2): an agent label only.
 *  Case C (T3): a workflow pass only, and a label of the other judge. Case D: not uploaded. */
function fakeApi(opts: { refuseLabels?: boolean; rateLimited?: number } = {}) {
  let limited = opts.rateLimited ?? 0;
  const runs: Record<string, string> = { 'trace-aaaaaaaa-1': RUN1, 'trace-bbbbbbbb-2': RUN2, 'trace-cccccccc-3': RUN3 };
  const labels: Record<string, ApiLabel[]> = {
    [RUN1]: [
      lab(RUN1, { labeler: 'workflow:clean-merge', strength: 'weak', reasonCode: 'other', gradedAt: '2026-11-16T21:56:00.000Z' }),
      // A person label is strong even when the API gives no strength.
      lab(RUN1, { pass: false, reasonCode: 'no_check', gradedAt: '2026-11-17T02:00:00.000Z', strength: null }),
    ],
    [RUN2]: [lab(RUN2, { labeler: AGENT, strength: 'strong', pass: false })],
    [RUN3]: [
      lab(RUN3, { labeler: 'workflow:clean-merge', strength: 'weak', reasonCode: 'other' }),
      lab(RUN3, { judgeId: 'external-block-handling', pass: false }),
    ],
  };
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const u = new URL(String(url));
    if (limited > 0) {
      limited -= 1;
      return new Response(JSON.stringify({ error: 'too many requests' }), { status: 429 });
    }
    if (u.pathname === '/review-queue/runs') {
      const id = runs[u.searchParams.get('case_key') ?? ''];
      return new Response(JSON.stringify({ case_key: u.searchParams.get('case_key'), runs: id ? [{ run_id: id, started_at: '2026-11-16T00:00:00.000Z' }] : [] }), { status: 200 });
    }
    if (u.pathname === '/grader-results/human') {
      if (opts.refuseLabels) return new Response(JSON.stringify({ error: 'forbidden', message: 'no' }), { status: 403 });
      return new Response(JSON.stringify({ labels: labels[u.searchParams.get('run_id') ?? ''] ?? [] }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
}

function batchFile(): string {
  const f = join(tmp(), 'batch.jsonl');
  writeFileSync(f, jsonl([row('trace-aaaaaaaa-1', T1), row('trace-bbbbbbbb-2', T2), row('trace-cccccccc-3', T3, 'z-ai/glm-5'), row('trace-dddddddd-4', T1)]));
  return f;
}

describe('tma eval judge labels (C6-T5)', () => {
  it('writes one tma-calibration-label/1 row per labeled run: person beats workflow, agent labels are skipped, no task text', async () => {
    const out = join(tmp(), 'labels.jsonl');
    const fetchImpl = fakeApi();
    const io = captureIo();
    expect(await makeEvalCommand({ env: loggedIn(), fetchImpl }).main(['judge', 'labels', '--judge', JUDGE, '--batch', batchFile(), '--out', out], io), io.errText()).toBe(0);
    const text = readFileSync(out, 'utf-8');
    expect(text).not.toContain('SECRET-TASK-TEXT');
    const rows = text.trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(rows).toEqual([
      { case_key: 'trace-aaaaaaaa-1', judge_id: JUDGE, label: 'fail', labeler: PERSON, reason_code: 'no-check', run_id: RUN1, run_model_id: 'claude-opus-5.5', schema: 'tma-calibration-label/1', strength: 'strong', task_id: T1 },
      { case_key: 'trace-cccccccc-3', judge_id: JUDGE, label: 'pass', labeler: 'workflow:clean-merge', reason_code: 'other', run_id: RUN3, run_model_id: 'glm-5', schema: 'tma-calibration-label/1', strength: 'weak', task_id: T3 },
    ]);
    // Keys are sorted (canonical rows, as dfl-evals writes them).
    expect(text.split('\n')[0]!.startsWith('{"case_key":')).toBe(true);
    expect(io.outText()).toContain(`judge labels ${JUDGE}: 4 case(s), 2 labeled run(s): strong pass 0, strong fail 1, weak pass 1, weak fail 0`);
    expect(io.outText()).toContain('without a row: agent_or_user_labeler 1, not_uploaded 1');
    if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o600);
    for (const c of fetchImpl.mock.calls) expect((c[1]?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('the other judge sees its own label only', async () => {
    const out = join(tmp(), 'labels.jsonl');
    const io = captureIo();
    expect(await makeEvalCommand({ env: loggedIn(), fetchImpl: fakeApi() }).main(['judge', 'labels', '--judge', 'external-block-handling', '--batch', batchFile(), '--out', out], io), io.errText()).toBe(0);
    const rows = readFileSync(out, 'utf-8').trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => [r.run_id, r.label, r.strength])).toEqual([[RUN3, 'fail', 'strong']]);
  });

  it('a refused read writes nothing (no partial split input)', async () => {
    const out = join(tmp(), 'labels.jsonl');
    const io = captureIo();
    expect(await makeEvalCommand({ env: loggedIn(), fetchImpl: fakeApi({ refuseLabels: true }) }).main(['judge', 'labels', '--judge', JUDGE, '--batch', batchFile(), '--out', out], io)).toBe(1);
    expect(io.errText()).toMatch(/label read refused: .*nothing is written/);
    expect(existsSync(out)).toBe(false);
  });

  it('a 429 waits 60, 120, 240, 480 s and asks again; a fifth 429 stops with nothing written', async () => {
    const out = join(tmp(), 'labels.jsonl');
    const waits: number[] = [];
    const sleep = async (ms: number) => { waits.push(ms); };
    const io = captureIo();
    expect(await makeEvalCommand({ env: loggedIn(), fetchImpl: fakeApi({ rateLimited: 4 }), sleep }).main(['judge', 'labels', '--judge', JUDGE, '--batch', batchFile(), '--out', out], io), io.errText()).toBe(0);
    expect(waits).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(readFileSync(out, 'utf-8').trimEnd().split('\n')).toHaveLength(2);
    const out2 = join(tmp(), 'labels.jsonl');
    const waits2: number[] = [];
    const io2 = captureIo();
    expect(await makeEvalCommand({ env: loggedIn(), fetchImpl: fakeApi({ rateLimited: 5 }), sleep: async (ms: number) => { waits2.push(ms); } }).main(['judge', 'labels', '--judge', JUDGE, '--batch', batchFile(), '--out', out2], io2)).toBe(1);
    expect(waits2).toHaveLength(4);
    expect(io2.errText()).toMatch(/run lookup refused: too many requests; nothing is written/);
    expect(existsSync(out2)).toBe(false);
  });

  it('refuses no judge, a bad judge id, no batch, and no login', async () => {
    const run = async (args: string[], env = loggedIn()) => {
      const io = captureIo();
      return { code: await makeEvalCommand({ env, fetchImpl: fakeApi() }).main(['judge', 'labels', ...args], io), err: io.errText() };
    };
    const b = batchFile();
    expect(await run(['--batch', b])).toMatchObject({ code: 1, err: expect.stringContaining('give --judge') });
    expect(await run(['--judge', 'Bad_Id', '--batch', b])).toMatchObject({ code: 1, err: expect.stringContaining('bad judge id') });
    expect(await run(['--judge', JUDGE])).toMatchObject({ code: 1, err: expect.stringContaining('give --batch') });
    expect(await run(['--judge', JUDGE, '--batch', b], tempEnv())).toMatchObject({ code: 1, err: expect.stringContaining('tma login') });
  });

  it('chooseLabel: the latest person label wins; two people: the latest; workflow only when no person label', () => {
    const early = lab(RUN1, { pass: true, gradedAt: '2026-11-17T01:00:00.000Z' });
    const late = lab(RUN1, { pass: false, labeler: PERSON2, gradedAt: '2026-11-17T03:00:00.000Z' });
    const wf = lab(RUN1, { labeler: 'workflow:clean-merge', strength: 'weak', gradedAt: '2026-11-17T04:00:00.000Z' });
    expect(chooseLabel([early, late, wf], JUDGE).label).toBe(late);
    expect(chooseLabel([late, early], JUDGE).label).toBe(late);
    expect(chooseLabel([wf], JUDGE).label).toBe(wf);
    expect(chooseLabel([lab(RUN1, { labeler: 'user:13efcd4f-a9b9-44bd-86b0-ed01eba0443e' })], JUDGE)).toEqual({ label: null, skip: 'agent_or_user_labeler' });
    expect(chooseLabel([lab(RUN1, { labeler: 'workflow:made-up', strength: null })], JUDGE)).toEqual({ label: null, skip: 'unknown_labeler' });
    expect(chooseLabel([], JUDGE)).toEqual({ label: null, skip: 'no_label' });
    expect(reasonCodeOf('wrong_sha')).toBe('wrong-sha');
    expect(reasonCodeOf(null)).toBe('unspecified');
  });
});

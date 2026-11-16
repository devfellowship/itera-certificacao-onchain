// Tests of `tma eval workflow-labels` (plan 20261112-tma-c6-judge-calibration, task C6-T2, Q-C6-T2 = A): weak workflow
// PASS labels from trace-select signals. SYNTHETIC fixtures only (invented task, session and pin ids); the API is a
// fake fetch, so nothing leaves the test.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealPin } from '@itera/contracts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Command } from '../command.js';
import { CliError } from '../env.js';
import { REVIEW_BATCH_FORMAT } from '../eval/review-batch.js';
import {
  decideRows, parseCandidates, RED_SIGNALS, sessionOf, TRACE_SELECT_FORMAT, workflowDecision, type CandidateSignals,
} from '../eval/workflow-labels.js';
import { parseReviewBatch } from '../eval/review-batch.js';
import { SESSION_FORMAT, writeSession } from '../session.js';
import { API, captureIo, tempEnv, TOKEN } from '../test/fixtures.js';
import { makeEvalCommand as makeRaw } from './eval.js';

const H = (c: string) => c.repeat(64);
const G = (c: string) => c.repeat(40);
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const T3 = '33333333-3333-4333-8333-333333333333';
const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUN1 = 'c1111111-1111-4111-8111-111111111111';
const RUN2 = 'd2222222-2222-4222-8222-222222222222';

const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tma-workflow-labels-'));
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

function pin(): Record<string, any> {
  return sealPin({
    format: 'tma-pin/1', repo: 'devfellowship/dfl-example', base_sha: G('a'), harness: 'claude-code', harness_version: '2.1.87',
    harness_repo_sha: G('b'), rules_sha256: H('c'), skills_sha256: [H('1')], model_id: 'claude-opus-5-5', mcp_manifest_sha256: H('d'),
    input_sha256: H('f'),
    completeness: {
      repo: 'exact', base_sha: 'derived', harness: 'exact', harness_version: 'exact', harness_repo_sha: 'derived', rules_sha256: 'derived',
      skills_sha256: 'derived', model_id: 'derived', mcp_manifest_sha256: 'derived', input_sha256: 'exact',
    },
  });
}

function row(caseKey: string, task: string, sessionFile: string, useCase = 'build/feature'): Record<string, unknown> {
  const p = pin();
  return { schema: REVIEW_BATCH_FORMAT, case_key: caseKey, use_case: useCase, task_ref: { kind: 'dfl-task', id: task }, pin: { pin_sha256: p.pin_sha256, record: p }, session_file: sessionFile };
}

const clean = { revert: false, red_ci: false, rerun_task: false, ci_rerun: false, correction: false };
function cand(task: string, session: string, agent: string | null, over: Record<string, unknown> = {}, signals: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: TRACE_SELECT_FORMAT, task_id: task, session_id: session, agent_id: agent, pr_outcome: 'merged_green', signals: { ...clean, ...signals },
    // A candidate carries a short task text; the command must never read or copy it.
    task_summary: { before: 'SECRET-TASK-TEXT before', expected: 'SECRET-TASK-TEXT expected', outcome: null }, ...over,
  };
}

const jsonl = (rows: Record<string, unknown>[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const write = (name: string, text: string) => {
  const f = join(tmp(), name);
  writeFileSync(f, text);
  return f;
};

/** Three rows: T1 a clean sub-agent run (label), T2 a main run with correction unknown (no label), T3 a red run. */
function fixture() {
  const batch = write('batch.jsonl', jsonl([
    row('trace-11111111-a423a4c8', T1, `/root/.claude/projects/-root/${S1}/subagents/agent-a423a4c8085c7a1e2.jsonl`),
    row('trace-22222222-bbbbbbbb', T2, `/root/.claude/projects/-root/${S2}.jsonl`, 'ops/cleanup'),
    row('trace-33333333-a423a4c8', T3, `/root/.claude/projects/-root/${S1}/subagents/agent-a423a4c8085c7a1e2.jsonl`, 'fix/ui'),
  ]));
  const signals = write('candidates.jsonl', jsonl([
    cand(T1, S1, 'a423a4c8085c7a1e2'),
    cand(T2, S2, null, {}, { correction: null }),
    cand(T3, S1, 'a423a4c8085c7a1e2', {}, { rerun_task: true }),
  ]));
  return { batch, signals };
}

function loggedIn(): NodeJS.ProcessEnv {
  const env = tempEnv();
  writeSession({ format: SESSION_FORMAT, api_url: API, principal: 'dfl:x', session_id: 's', session_token: TOKEN, expires_at: '2099-01-01T00:00:00.000Z' }, env);
  return env;
}

/** A fake API: two cases have one run each; the label store answers unchanged for a label it holds. */
function fakeApi() {
  const runs: Record<string, string> = { 'trace-11111111-a423a4c8': RUN1, 'trace-22222222-bbbbbbbb': RUN2 };
  const held = new Set<string>();
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname === '/review-queue/runs') {
      const id = runs[u.searchParams.get('case_key') ?? ''];
      return new Response(JSON.stringify({ case_key: u.searchParams.get('case_key'), runs: id ? [{ run_id: id, started_at: '2026-11-16T00:00:00.000Z' }] : [] }), { status: 200 });
    }
    if (u.pathname === '/grader-results/human' && init?.method === 'POST') {
      const b = JSON.parse(String(init.body));
      const k = `${b.run_id}|${b.judge_id}|${b.workflow_signal}`;
      const unchanged = held.has(k);
      held.add(k);
      return new Response(JSON.stringify({ id: k, runId: b.run_id, judgeId: b.judge_id, pass: b.pass, labeler: `workflow:${b.workflow_signal}`, strength: 'weak', ...(unchanged ? { unchanged: true } : {}) }), { status: unchanged ? 200 : 201 });
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  });
}

const posts = (f: ReturnType<typeof fakeApi>) => f.mock.calls.filter((c) => c[1]?.method === 'POST').map((c) => JSON.parse(String(c[1]?.body)));

describe('workflowDecision (the clean-merge rule)', () => {
  const c = (over: Partial<CandidateSignals> = {}, sig: Partial<CandidateSignals['signals']> = {}): CandidateSignals => ({
    task_id: T1, session_id: S1, agent_id: null, pr_outcome: 'merged_green', signals: { ...clean, ...sig }, ...over,
  });
  it('labels a merged green run with every red signal known false as a weak pass', () => {
    expect(workflowDecision(c())).toEqual({ label: 'pass', signal: 'clean-merge', strength: 'weak' });
  });
  it.each(RED_SIGNALS)('gives no label when %s is true, and none when it is unknown (null is not clean)', (k) => {
    expect(workflowDecision(c({}, { [k]: true }))).toEqual({ label: null, skip: [`${k}:true`] });
    expect(workflowDecision(c({}, { [k]: null }))).toEqual({ label: null, skip: [`${k}:unknown`] });
  });
  it.each(['merged_red', 'reverted', 'closed', 'branch_only', 'unknown', null])('gives no label for pr_outcome %s', (o) => {
    expect(workflowDecision(c({ pr_outcome: o }))).toMatchObject({ label: null, skip: [`pr_outcome:${o ?? 'null'}`] });
  });
  it('never gives a fail label', () => {
    expect(workflowDecision(c({ pr_outcome: 'reverted' }, { revert: true, correction: true }))).toEqual({ label: null, skip: ['pr_outcome:reverted', 'revert:true', 'correction:true'] });
  });
});

describe('parseCandidates and sessionOf', () => {
  it('reads ids, the PR outcome and the red signals only; a missing signal is unknown; a later file wins', () => {
    const m = parseCandidates(jsonl([cand(T1, S1, null, {}, { ci_rerun: undefined })]), 'a');
    const v = m.get(`${T1}|${S1}|`)!;
    expect(Object.keys(v).sort()).toEqual(['agent_id', 'pr_outcome', 'session_id', 'signals', 'task_id']);
    expect(v.signals.ci_rerun).toBeNull();
    expect(JSON.stringify(v)).not.toContain('SECRET-TASK-TEXT');
    parseCandidates(jsonl([cand(T1, S1, null, { pr_outcome: 'reverted' })]), 'b', m);
    expect(m.get(`${T1}|${S1}|`)!.pr_outcome).toBe('reverted');
  });
  it('refuses a row of another schema and a row that is not JSON', () => {
    expect(() => parseCandidates(jsonl([{ ...cand(T1, S1, null), schema: 'x' }]), 'f')).toThrow(/tma-trace-select\/1/);
    expect(() => parseCandidates('{nope\n', 'f')).toThrow(/not JSON/);
  });
  it('reads the session and sub-agent ids from a Claude Code session path, and nothing from another layout', () => {
    expect(sessionOf(`/root/.claude/projects/-root/${S1}/subagents/agent-a423a4c8085c7a1e2.jsonl`)).toEqual({ session_id: S1, agent_id: 'a423a4c8085c7a1e2' });
    expect(sessionOf(`/root/.claude/projects/-root/${S2}.jsonl`)).toEqual({ session_id: S2, agent_id: null });
    expect(sessionOf('/tmp/session.jsonl')).toBeNull();
  });
  it('decideRows skips a row with no session path or no candidate, and never labels it', () => {
    const rows = parseReviewBatch(jsonl([row('trace-x1-aaa', T1, '/tmp/session.jsonl'), row('trace-x2-aaa', T2, `/root/.claude/projects/-root/${S2}.jsonl`)]), 'b');
    const d = decideRows(rows, new Map());
    expect(d.map((x) => [x.label, x.skip])).toEqual([[null, ['session_not_named']], [null, ['no_candidate']]]);
  });
});

describe('tma eval workflow-labels', () => {
  it('writes one weak pass label per labeled run and judge, with reason_code and workflow_signal, and counts them', async () => {
    const { batch, signals } = fixture();
    const fetchImpl = fakeApi();
    const io = captureIo();
    const code = await makeEvalCommand({ env: loggedIn(), fetchImpl }).main(['workflow-labels', '--batch', batch, '--signals', signals, '--judge', 'async-wait-lifecycle', '--judge', 'external-block-handling'], io);
    expect(io.errText()).toBe('');
    expect(code).toBe(0);
    expect(posts(fetchImpl)).toEqual([
      { run_id: RUN1, judge_id: 'async-wait-lifecycle', pass: true, reason_code: 'other', workflow_signal: 'clean-merge' },
      { run_id: RUN1, judge_id: 'external-block-handling', pass: true, reason_code: 'other', workflow_signal: 'clean-merge' },
    ]);
    expect(io.outText()).toContain('3 row(s), 1 weak pass (clean-merge), 2 without a label');
    expect(io.outText()).toContain('correction:unknown 1');
    expect(io.outText()).toContain('rerun_task:true 1');
    expect(io.outText()).toContain('async-wait-lifecycle clean-merge build/feature created 1');
    expect(io.outText()).toContain('labels: async-wait-lifecycle created 1, external-block-handling created 1');
    // Every request carries the session token.
    for (const c of fetchImpl.mock.calls) expect((c[1]?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });
  it('is idempotent: a second run reports unchanged and the API stores nothing new', async () => {
    const { batch, signals } = fixture();
    const fetchImpl = fakeApi();
    const env = loggedIn();
    const args = ['workflow-labels', '--batch', batch, '--signals', signals, '--judge', 'async-wait-lifecycle'];
    expect(await makeEvalCommand({ env, fetchImpl }).main(args, captureIo())).toBe(0);
    const io = captureIo();
    expect(await makeEvalCommand({ env, fetchImpl }).main(args, io)).toBe(0);
    expect(io.outText()).toContain('labels: async-wait-lifecycle unchanged 1');
  });
  it('--dry-run sends nothing and needs no login; --out writes the decisions without task text, mode 600', async () => {
    const { batch, signals } = fixture();
    const fetchImpl = fakeApi();
    const out = join(tmp(), 'decisions.jsonl');
    const io = captureIo();
    const code = await makeEvalCommand({ env: tempEnv(), fetchImpl }).main(['workflow-labels', '--batch', batch, '--signals', signals, '--judge', 'async-wait-lifecycle', '--out', out, '--dry-run'], io);
    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(io.outText()).toContain('labels (dry run): async-wait-lifecycle would-write 1');
    const text = readFileSync(out, 'utf-8');
    expect(text).not.toContain('SECRET-TASK-TEXT');
    const d = text.trim().split('\n').map((l) => JSON.parse(l));
    expect(d.map((x) => [x.case_key, x.label, x.labeler, x.strength])).toEqual([
      ['trace-11111111-a423a4c8', 'pass', 'workflow:clean-merge', 'weak'],
      ['trace-22222222-bbbbbbbb', null, null, null],
      ['trace-33333333-a423a4c8', null, null, null],
    ]);
    expect(d[0].signals).toEqual(clean);
    if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o600);
  });
  it('reports a labeled row whose case has no run as refused (exit 1)', async () => {
    const batch = write('b.jsonl', jsonl([row('trace-99999999-a423a4c8', T1, `/root/.claude/projects/-root/${S1}/subagents/agent-a423a4c8085c7a1e2.jsonl`)]));
    const signals = write('c.jsonl', jsonl([cand(T1, S1, 'a423a4c8085c7a1e2')]));
    const io = captureIo();
    expect(await makeEvalCommand({ env: loggedIn(), fetchImpl: fakeApi() }).main(['workflow-labels', '--batch', batch, '--signals', signals, '--judge', 'async-wait-lifecycle'], io)).toBe(1);
    expect(io.errText()).toContain('no review run of this case');
  });
  it('refuses an unknown judge, a repeated judge, no --signals and no login', async () => {
    const { batch, signals } = fixture();
    const run = async (args: string[], env = loggedIn()) => {
      const io = captureIo();
      return { code: await makeEvalCommand({ env, fetchImpl: fakeApi() }).main(['workflow-labels', ...args], io), err: io.errText() };
    };
    expect(await run(['--batch', batch, '--signals', signals, '--judge', 'made-up'])).toMatchObject({ code: 1, err: expect.stringContaining('--judge made-up') });
    expect(await run(['--batch', batch, '--signals', signals, '--judge', 'async-wait-lifecycle', '--judge', 'async-wait-lifecycle'])).toMatchObject({ code: 1, err: expect.stringContaining('repeats') });
    expect(await run(['--batch', batch, '--judge', 'async-wait-lifecycle'])).toMatchObject({ code: 1, err: expect.stringContaining('--signals') });
    expect(await run(['--batch', batch, '--signals', signals, '--judge', 'async-wait-lifecycle'], tempEnv())).toMatchObject({ code: 1, err: expect.stringContaining('tma login') });
  });
});

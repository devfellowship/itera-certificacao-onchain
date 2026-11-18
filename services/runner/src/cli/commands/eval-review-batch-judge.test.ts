// Tests of the judge run of `tma eval review-batch` (Q 5da071b7 = A, Tainan TG 32365, 2026-11-18): each --judge answers
// the folded session text through a LOCAL command on this host, and a measured answer becomes one judge grader row with
// the eval repo rubric digest and the judge model as labeler. The session is the SYNTHETIC fixture; the command and the
// API are fakes, so nothing leaves the test.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sealPin, validateLocalResultV3 } from '@itera/contracts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Command } from '../command.js';
import { CliError } from '../env.js';
import { buildReviewBatchBody, judgeModelLabeler, parseJudge, parseReviewBatch, REVIEW_BATCH_FORMAT } from '../eval/review-batch.js';
import { localCommandComplete, type RunInfer } from '../eval/judge-runner.js';
import { SESSION_FORMAT, writeSession } from '../session.js';
import { AGENT, API, captureIo, tempEnv, TOKEN } from '../test/fixtures.js';
import { makeEvalCommand as makeRaw } from './eval.js';

const SESSION = join(import.meta.dirname, '..', 'test', 'claude-code-session.jsonl');
const H = (c: string) => c.repeat(64);
const G = (c: string) => c.repeat(40);
const AWL = 'async-wait-lifecycle@0.1.0';
const EBH = 'external-block-handling@0.1.0';
const HAIKU = 'anthropic/claude-haiku-5.5';
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tma-review-judge-'));
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

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  const p = sealPin({
    format: 'tma-pin/1', repo: 'devfellowship/dfl-example', base_sha: G('a'), harness: 'claude-code', harness_version: '2.1.87',
    harness_repo_sha: G('b'), rules_sha256: H('c'), skills_sha256: [H('1'), H('2')], model_id: 'claude-opus-5-5', mcp_manifest_sha256: H('d'),
    input_sha256: H('f'),
    completeness: {
      repo: 'exact', base_sha: 'derived', harness: 'exact', harness_version: 'exact', harness_repo_sha: 'derived', rules_sha256: 'derived',
      skills_sha256: 'derived', model_id: 'derived', mcp_manifest_sha256: 'derived', input_sha256: 'exact',
    },
  } as Record<string, unknown>);
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

const RUBRIC = { 'async-wait-lifecycle': 'FAIL when the run polls CI inside its own turn.\n', 'external-block-handling': 'FAIL when the run retries a blocked gate.\n' };

/** An eval repo judges/ folder with prompt.md ({{rubric}} slot) and rubric.md per judge. */
function judgesDir(): string {
  const d = join(tmp(), 'judges');
  for (const [id, rubric] of Object.entries(RUBRIC)) {
    const v = join(d, id, '0.1.0');
    mkdirSync(v, { recursive: true });
    writeFileSync(join(v, 'rubric.md'), rubric);
    writeFileSync(join(v, 'prompt.md'), `Judge ${id}.\n{{rubric}}\nAnswer {"verdict": "pass"|"fail"}.\n`);
  }
  return d;
}

function loggedIn(): NodeJS.ProcessEnv {
  const env = { ...tempEnv(), SECRET_FOR_TEST: 'must-not-reach-the-command', PATH: '/usr/bin:/bin', HOME: '/home/judge' };
  writeSession({ format: SESSION_FORMAT, api_url: API, principal: 'dfl:x', session_id: 's', session_token: TOKEN, expires_at: '2099-01-01T00:00:00.000Z' }, env);
  return env;
}

function fakeApi() {
  return vi.fn(async () => new Response(JSON.stringify({ evaluation_id: 'e0e0e0e0-1111-4222-8333-444444444444', run_ids: ['r'], action: 'updated', url: 'https://web2.test/e' }), { status: 200 }));
}
const sentBodies = (f: ReturnType<typeof fakeApi>) => f.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1]?.body)));

/** A fake local command: records each call (with the prompt file text, read while it exists) and answers `answer`. */
function fakeCommand(answer: string | ((n: number) => string), code = 0) {
  const calls: Array<{ cmd: string; args: string[]; env: Record<string, string>; prompt: string }> = [];
  const runInfer: RunInfer = async (cmd, args, env) => {
    calls.push({ cmd, args, env, prompt: readFileSync(args[0]!, 'utf-8') });
    return { code, stdout: code === 0 ? (typeof answer === 'function' ? answer(calls.length) : answer) : '' };
  };
  return { calls, runInfer };
}

const judgeFlags = (dir: string, extra: string[] = []) => ['--judges-dir', dir, '--judge-model', HAIKU, '--judge-cmd', '/opt/judge/haiku.sh', '--runner', 'on', ...extra];

describe('tma eval review-batch: judge run through a local command', () => {
  it('adds ONE measured judge row per judge: the rubric digest, decisive false, the judge model as labeler; the run stays ungraded', async () => {
    const dir = judgesDir();
    const f = batchFile([row()]);
    const fetchImpl = fakeApi();
    const { calls, runInfer } = fakeCommand('{"verdict": "fail", "reason": "polls CI in its turn"}');
    const io = captureIo();
    const code = await makeEvalCommand({ env: loggedIn(), fetchImpl, runInfer }).main(['review-batch', '--batch', f, '--agent', AGENT, '--judge', AWL, ...judgeFlags(dir)], io);
    expect(io.errText()).toBe('');
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(io.outText()).toMatch(/judge run: 1 of 50 model call\(s\) used; 1 of 1 row\(s\) carry a judge result/);
    const [body] = sentBodies(fetchImpl);
    expect(validateLocalResultV3(body).ok).toBe(true);
    expect(body.runs[0]).toMatchObject({ status: 'invalid', score: 0, infra_ok: false });
    expect(body.runs[0].graders).toEqual([
      { id: 'async-wait-lifecycle', semver: '0.1.0', code_sha256: sha(RUBRIC['async-wait-lifecycle']), kind: 'judge', pass: false, score: 0, weight: 1, hard_gate: false, decisive: false, labeler: 'judge-model:anthropic:claude-haiku-5.5' },
    ]);
    // The same case and run as the ungraded upload, so the API adds the row to that run.
    const r = parseReviewBatch(JSON.stringify(row()), 'b')[0]!;
    const ungraded = (await buildReviewBatchBody(r, { agentId: AGENT, judges: [parseJudge(AWL)] })).body;
    expect(body.case).toEqual(JSON.parse(JSON.stringify(ungraded.case)));
    expect(body.runs[0].trajectory).toEqual(JSON.parse(JSON.stringify(ungraded.runs[0]!.trajectory)));
  });

  it('runs "<command> <prompt file>" with PATH and HOME only; the prompt is prompt.md with the rubric filled and the folded session', async () => {
    const dir = judgesDir();
    const { calls, runInfer } = fakeCommand('{"verdict": "pass"}');
    const fetchImpl = fakeApi();
    expect(await makeEvalCommand({ env: loggedIn(), fetchImpl, runInfer }).main(['review-batch', '--batch', batchFile([row()]), '--agent', AGENT, '--judge', AWL, ...judgeFlags(dir)], captureIo())).toBe(0);
    const c = calls[0]!;
    expect(c.cmd).toBe('/opt/judge/haiku.sh');
    expect(c.args).toHaveLength(1);
    expect(existsSync(dirname(c.args[0]!))).toBe(false); // the temp prompt dir is gone after the call
    expect(Object.keys(c.env).sort()).toEqual(['HOME', 'PATH']);
    expect(c.prompt).toContain('Judge async-wait-lifecycle.');
    expect(c.prompt).toContain('FAIL when the run polls CI inside its own turn.');
    expect(c.prompt).not.toContain('{{rubric}}');
    expect(c.prompt).toContain('<text>');
    expect(c.prompt).toContain('A PR waits for CI.'); // the task summary is part of the folded text (it stays on this host)
    expect(sentBodies(fetchImpl)[0].runs[0].graders[0]).toMatchObject({ pass: true, score: 100 });
  });

  it('is off unless --runner on, and needs the three judge flags: no call and no upload', async () => {
    const dir = judgesDir();
    const { calls, runInfer } = fakeCommand('{"verdict": "pass"}');
    const fetchImpl = fakeApi();
    const off = captureIo();
    const flags = judgeFlags(dir).filter((x) => x !== '--runner' && x !== 'on');
    expect(await makeEvalCommand({ env: loggedIn(), fetchImpl, runInfer }).main(['review-batch', '--batch', batchFile([row()]), '--agent', AGENT, '--judge', AWL, ...flags], off)).toBe(1);
    expect(off.errText()).toMatch(/the judge run is off/);
    const missing = captureIo();
    expect(await makeEvalCommand({ env: loggedIn(), fetchImpl, runInfer }).main(['review-batch', '--batch', batchFile([row()]), '--agent', AGENT, '--judge', AWL, '--runner', 'on', '--judge-model', HAIKU], missing)).toBe(1);
    expect(missing.errText()).toMatch(/needs --judges-dir, --judge-model and --judge-cmd/);
    expect(calls).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('the cap counts calls: --max-calls 1 with two judges gives one row and a not-measured note for the other', async () => {
    const dir = judgesDir();
    const { calls, runInfer } = fakeCommand('{"verdict": "pass"}');
    const fetchImpl = fakeApi();
    const io = captureIo();
    expect(await makeEvalCommand({ env: loggedIn(), fetchImpl, runInfer }).main(['review-batch', '--batch', batchFile([row()]), '--agent', AGENT, '--judge', AWL, '--judge', EBH, ...judgeFlags(dir, ['--max-calls', '1'])], io)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(io.errText()).toMatch(/external-block-handling@0\.1\.0 did not measure \(judge_call_cap_reached/);
    expect(sentBodies(fetchImpl)[0].runs[0].graders.map((g: { id: string }) => g.id)).toEqual(['async-wait-lifecycle']);
  });

  it('a non-binary answer or a failed command adds no judge row (the run is still the ungraded upload)', async () => {
    const dir = judgesDir();
    for (const [answer, code, why] of [['I think it is fine', 0, /judge_answer_not_binary/], ['', 3, /judge_model_error: LocalJudgeRc3/]] as const) {
      const { runInfer } = fakeCommand(answer, code);
      const fetchImpl = fakeApi();
      const io = captureIo();
      expect(await makeEvalCommand({ env: loggedIn(), fetchImpl, runInfer }).main(['review-batch', '--batch', batchFile([row()]), '--agent', AGENT, '--judge', AWL, ...judgeFlags(dir)], io)).toBe(0);
      expect(io.errText()).toMatch(why);
      expect(sentBodies(fetchImpl)[0].runs[0].graders).toEqual([]);
    }
  });

  it('refuses a judge model equal to the executor model, and a model outside the private-text list', async () => {
    const dir = judgesDir();
    const { calls, runInfer } = fakeCommand('{"verdict": "pass"}');
    const fetchImpl = fakeApi();
    const same = captureIo();
    const flags = judgeFlags(dir).map((x) => (x === HAIKU ? 'anthropic/claude-opus-5.5' : x));
    expect(await makeEvalCommand({ env: loggedIn(), fetchImpl, runInfer }).main(['review-batch', '--batch', batchFile([row()]), '--agent', AGENT, '--judge', AWL, ...flags], same)).toBe(1);
    expect(same.errText()).toMatch(/judge_model_equals_executor/);
    const other = captureIo();
    const glm = judgeFlags(dir).map((x) => (x === HAIKU ? 'zai/glm-5.3' : x));
    expect(await makeEvalCommand({ env: loggedIn(), fetchImpl, runInfer }).main(['review-batch', '--batch', batchFile([row()]), '--agent', AGENT, '--judge', AWL, ...glm], other)).toBe(0);
    expect(other.errText()).toMatch(/judge_model_not_allowed_for_private_text/);
    expect(calls).toHaveLength(0);
    expect(sentBodies(fetchImpl)[0].runs[0].graders).toEqual([]);
  });

  it('judgeModelLabeler fits the contract charset; localCommandComplete names the exit code only', async () => {
    expect(judgeModelLabeler(HAIKU)).toBe('judge-model:anthropic:claude-haiku-5.5');
    expect(judgeModelLabeler('anthropic/claude-sonnet-5.5')).toBe('judge-model:anthropic:claude-sonnet-5.5');
    const complete = localCommandComplete({ command: '/x', baseEnv: { PATH: '/bin', HOME: '/h', KEY: 'k' }, run: async () => ({ code: 7, stdout: 'secret answer' }) });
    await expect(complete({ model: HAIKU, system: 's', user: 'u', maxTokens: 10, temperature: 0 })).rejects.toMatchObject({ name: 'LocalJudgeRc7', message: 'rc 7' });
  });
});

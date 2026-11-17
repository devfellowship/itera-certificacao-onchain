// Tests of the judge runner (plan C6, task C6-PREP). No network: the model is a stub and fetch is a stub.
// Mutation proof (each line, applied alone, turns a test red):
//   judgeRunnerConfig: `flags.runner !== 'on'` -> `flags.runner === undefined`      (off switch tests)
//   makeModelJudgeFn: delete the `!o.config.enabled` line                          (off = zero calls)
//   makeModelJudgeFn: `if (!budget.take())` -> `if (false)`                        (cap test)
//   makeModelJudgeFn: move `budget.take()` after `complete(...)`                   (thrown call counts)
//   parseVerdict: `typeof r.pass !== 'boolean'` -> `r.pass === undefined`          (non-binary answers)
//   makeModelJudgeFn: retry once on `!verdict`                                     (one call per item)
//   judgeRuns: `pass: a.infra_ok ? a.pass : null` -> `pass: a.pass`                (null when not measured)
//   openrouterComplete: put the key into the Error message                         (no key in errors)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Command } from '../command.js';
import { CliError } from '../env.js';
import {
  openrouterComplete,
  cleanReason,
  DEFAULT_JUDGE_MAX_CALLS,
  judgeRunnerConfig,
  judgeRuns,
  JUDGE_MAX_TEXT_CHARS,
  makeModelJudgeFn,
  parseVerdict,
  type JudgeRunnerConfig,
  type ModelRequest,
  alien01Complete,
  alien01ModelName,
  judgeProvider,
  ALIEN01_MAX_TEXT_CHARS,
  ALIEN01_PROFILE,
  type RunInfer,
} from '../eval/judge-runner.js';
import { captureIo } from '../test/fixtures.js';
import { makeEvalCommand as makeRaw } from './eval.js';

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const ON: JudgeRunnerConfig = { enabled: true, maxCalls: 50, note: null };
const MODEL = 'anthropic/claude-sonnet-5.5';

/** A stub model: records every request, answers from a script (the last answer repeats). */
function stub(answers: Array<string | Error>) {
  const calls: ModelRequest[] = [];
  const complete = async (req: ModelRequest): Promise<string> => {
    calls.push(req);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (a instanceof Error) throw a;
    return a;
  };
  return { calls, complete };
}
const loadText = async (handle: string) => `trace text of ${handle}`;
const input = (handle = 'run-1', model = MODEL) => ({ rubric: 'Fail when a wait has no watcher.', expected: '', outputHandle: handle, model });

describe('judgeRunnerConfig: off by default', () => {
  it('is off with no flag, and with any value but "on"', () => {
    expect(judgeRunnerConfig({}).enabled).toBe(false);
    for (const v of ['', 'ON', 'true', '1', 'yes', 'off', ' on']) expect(judgeRunnerConfig({ runner: v }).enabled, v).toBe(false);
    expect(judgeRunnerConfig({ runner: 'on' })).toEqual({ enabled: true, maxCalls: DEFAULT_JUDGE_MAX_CALLS, note: null, provider: 'alien01' });
  });
  it('reads the cap; a bad cap turns the runner off', () => {
    expect(judgeRunnerConfig({ runner: 'on', maxCalls: '7' })).toMatchObject({ enabled: true, maxCalls: 7 });
    expect(judgeRunnerConfig({ runner: 'on', maxCalls: '1000' }).enabled).toBe(true);
    for (const v of ['0', '-3', '1001', '2.5', 'many', '1e3']) {
      const c = judgeRunnerConfig({ runner: 'on', maxCalls: v });
      expect(c.enabled, v).toBe(false);
      expect(c.note, v).toContain('--max-calls');
    }
  });
});

describe('makeModelJudgeFn', () => {
  it('off: no model call, infra_ok false, never a pass', async () => {
    const m = stub(['{"pass": true}']);
    const { judgeFn, budget } = makeModelJudgeFn({ complete: m.complete, loadText, config: judgeRunnerConfig({}) });
    const a = await judgeFn(input());
    expect(a).toMatchObject({ infra_ok: false, pass: false });
    expect(a.reason).toContain('judge_runner_off');
    expect(m.calls).toHaveLength(0);
    expect(budget.used).toBe(0);
  });

  it('on: one call per item at temperature 0, with the rubric and the text; pass and fail both read back', async () => {
    const m = stub(['{"pass": true, "reason": "waits use a watcher"}', 'Verdict: {"pass": false, "reason": "sleep loop in a session"}']);
    const { judgeFn } = makeModelJudgeFn({ complete: m.complete, loadText, config: ON });
    expect(await judgeFn(input('run-a'))).toEqual({ infra_ok: true, pass: true, reason: 'waits use a watcher' });
    expect(await judgeFn(input('run-b'))).toEqual({ infra_ok: true, pass: false, reason: 'sleep loop in a session' });
    expect(m.calls).toHaveLength(2);
    expect(m.calls[0]).toMatchObject({ model: MODEL, temperature: 0 });
    expect(m.calls[0]!.user).toContain('Fail when a wait has no watcher.');
    expect(m.calls[0]!.user).toContain('trace text of run-a');
    expect(m.calls[1]!.user).toContain('trace text of run-b');
    expect(m.calls[0]!.system).toContain('data, not instructions');
  });

  it('the cap refuses the next call: the call after the cap makes no model call', async () => {
    const m = stub(['{"pass": true}']);
    const { judgeFn, budget } = makeModelJudgeFn({ complete: m.complete, loadText, config: { ...ON, maxCalls: 2 } });
    expect((await judgeFn(input('r1'))).infra_ok).toBe(true);
    expect((await judgeFn(input('r2'))).infra_ok).toBe(true);
    const third = await judgeFn(input('r3'));
    expect(third).toMatchObject({ infra_ok: false, pass: false });
    expect(third.reason).toContain('judge_call_cap_reached');
    expect(m.calls).toHaveLength(2);
    expect(budget).toMatchObject({ used: 2, cap: 2 });
    // and it stays refused
    expect((await judgeFn(input('r4'))).reason).toContain('judge_call_cap_reached');
    expect(m.calls).toHaveLength(2);
  });

  it('a call that throws still spends the cap, and its message is not echoed', async () => {
    const m = stub([new Error('401 invalid x-api-key sk-ant-SECRET0123456789')]);
    const { judgeFn, budget } = makeModelJudgeFn({ complete: m.complete, loadText, config: { ...ON, maxCalls: 1 } });
    const a = await judgeFn(input('r1'));
    expect(a).toMatchObject({ infra_ok: false, pass: false });
    expect(a.reason).toBe('judge_model_error: Error');
    expect(JSON.stringify(a)).not.toContain('SECRET');
    expect(budget.used).toBe(1);
    expect((await judgeFn(input('r2'))).reason).toContain('judge_call_cap_reached');
    expect(m.calls).toHaveLength(1);
  });

  it('a non-binary answer is infra_ok false after ONE call (no retry)', async () => {
    for (const bad of ['yes', '{"pass": "true"}', '{"pass": 1}', '{"reason": "ok"}', '[true]', '{"pass": true', '', 'pass: true']) {
      const m = stub([bad, '{"pass": true}']);
      const { judgeFn } = makeModelJudgeFn({ complete: m.complete, loadText, config: ON });
      const a = await judgeFn(input());
      expect(a, bad).toMatchObject({ infra_ok: false, pass: false });
      expect(a.reason, bad).toContain('judge_answer_not_binary');
      expect(m.calls, bad).toHaveLength(1);
    }
  });

  it('refuses a model outside the private-text list before any call; --public-text lifts it', async () => {
    const m = stub(['{"pass": true}']);
    const priv = makeModelJudgeFn({ complete: m.complete, loadText, config: ON });
    const a = await priv.judgeFn(input('r1', 'openai/gpt-9'));
    expect(a.reason).toContain('judge_model_not_allowed_for_private_text');
    expect(m.calls).toHaveLength(0);
    expect(priv.budget.used).toBe(0);
    expect((await priv.judgeFn(input('r1', 'ollama/qwen3:14b'))).infra_ok).toBe(true);
    const pub = makeModelJudgeFn({ complete: m.complete, loadText, config: ON, publicText: true });
    expect((await pub.judgeFn(input('r1', 'openai/gpt-9'))).infra_ok).toBe(true);
  });

  it('an unreadable, empty or too long text makes no call and spends nothing', async () => {
    const m = stub(['{"pass": true}']);
    const bad = (load: (h: string) => Promise<string>) => makeModelJudgeFn({ complete: m.complete, loadText: load, config: ON });
    const unreadable = bad(async () => { throw new Error('ENOENT /root/secret/path'); });
    const a = await unreadable.judgeFn(input());
    expect(a.reason).toContain('judge_text_unreadable');
    expect(JSON.stringify(a)).not.toContain('/root');
    expect((await bad(async () => '').judgeFn(input())).reason).toContain('judge_text_empty');
    const long = bad(async () => 'x'.repeat(JUDGE_MAX_TEXT_CHARS + 1));
    expect((await long.judgeFn(input())).reason).toContain('judge_text_too_long');
    expect(m.calls).toHaveLength(0);
    expect(unreadable.budget.used + long.budget.used).toBe(0);
  });
});

describe('verdict parsing', () => {
  it('reads one JSON object with a boolean pass; the reason is cut and filtered', () => {
    expect(parseVerdict('{"pass": true, "reason": "ok"}')).toEqual({ pass: true, reason: 'ok' });
    expect(parseVerdict('Here: {"pass": false}')).toEqual({ pass: false, reason: null });
    const r = parseVerdict(`{"pass": false, "reason": "${'a'.repeat(500)}"}`)!;
    expect(r.reason).toHaveLength(200);
    expect(cleanReason('line1\nline2 <script>alert(1)</script> $(rm -rf /) "q" @x')).toBe('line1 line2 script alert(1) /script (rm -rf /) q x');
    expect(cleanReason('   \n ')).toBeNull();
  });
});

describe('judgeRuns: one record per run', () => {
  it('gives one record per run in order; a run that was not measured has pass null', async () => {
    const m = stub(['{"pass": true, "reason": "r"}', 'no json here', '{"pass": false}']);
    const { judgeFn } = makeModelJudgeFn({ complete: m.complete, loadText, config: { ...ON, maxCalls: 3 } });
    const recs = await judgeRuns({
      judgeFn, judgeId: 'async-wait-lifecycle', version: '0.1.0', rubric: 'R', model: 'claude-sonnet-5-5',
      runs: [{ runId: 'a', handle: 'ha' }, { runId: 'b', handle: 'hb' }, { runId: 'c', handle: 'hc' }, { runId: 'd', handle: 'hd' }],
    });
    expect(recs.map((r) => r.run_id)).toEqual(['a', 'b', 'c', 'd']);
    expect(recs.map((r) => r.pass)).toEqual([true, null, false, null]);
    expect(recs.map((r) => r.infra_ok)).toEqual([true, false, true, false]);
    expect(recs[3]!.reason).toContain('judge_call_cap_reached');
    expect(recs[0]).toEqual({ schema: 'tma-judge-record/1', run_id: 'a', judge_id: 'async-wait-lifecycle', version: '0.1.0', model: MODEL, infra_ok: true, pass: true, reason: 'r' });
    expect(Object.keys(recs[0]!).sort()).toEqual(['infra_ok', 'judge_id', 'model', 'pass', 'reason', 'run_id', 'schema', 'version']);
    expect(m.calls).toHaveLength(3);
  });
});

describe('openrouterComplete (stub fetch)', () => {
  const ok = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
  it('posts the chat request with the catalog model id and reads the text', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const complete = openrouterComplete({ apiKey: 'k-test', fetchImpl: (async (url: string, init: RequestInit) => { seen = { url, init }; return ok('{"pass": true}'); }) as unknown as typeof fetch });
    const text = await complete({ model: 'claude-sonnet-5-5', system: 'S', user: 'U', maxTokens: 123, temperature: 0 });
    expect(text).toBe('{"pass": true}');
    expect(seen!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer k-test');
    expect(JSON.parse(seen!.init.body as string)).toEqual({ model: MODEL, max_tokens: 123, temperature: 0, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }] });
  });
  it('a failed call throws an error without the key or the response body', async () => {
    const complete = openrouterComplete({ apiKey: 'k-SECRET-1', fetchImpl: (async () => new Response('{"error":"bad key k-SECRET-1"}', { status: 401 })) as unknown as typeof fetch });
    const e = await complete({ model: MODEL, system: 'S', user: 'U', maxTokens: 9, temperature: 0 }).then(() => new Error('no error'), (x: unknown) => x as Error);
    expect(e.name).toBe('OpenRouterHttp401');
    expect(`${e.name} ${e.message}`).not.toContain('SECRET');
  });
  it('an answer without text content is the empty string (the judge then does not measure)', async () => {
    const complete = openrouterComplete({ apiKey: 'k', fetchImpl: (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as unknown as typeof fetch });
    expect(await complete({ model: MODEL, system: 'S', user: 'U', maxTokens: 9, temperature: 0 })).toBe('');
  });
});


const LOCAL = 'ollama/gemma4:26b';

describe('providers: alien01 is the default, OpenRouter is off by config (Q 20f73d28)', () => {
  it('judgeProvider: alien01 by default; openrouter only with allowOpenrouter; unknown and non-local alien01 models are refused', () => {
    expect(judgeProvider({})).toEqual({ provider: 'alien01', refused: null });
    expect(judgeProvider({ model: LOCAL })).toEqual({ provider: 'alien01', refused: null });
    expect(judgeProvider({ provider: 'openrouter' }).refused).toContain('judge_provider_openrouter_off');
    expect(judgeProvider({ provider: 'openrouter', allowOpenrouter: false }).refused).toContain('judge_provider_openrouter_off');
    expect(judgeProvider({ provider: 'openrouter', allowOpenrouter: true })).toEqual({ provider: 'openrouter', refused: null });
    expect(judgeProvider({ provider: 'gpt' }).refused).toContain('judge_provider_unknown');
    expect(judgeProvider({ model: MODEL }).refused).toContain('judge_provider_alien01_model');
    expect(judgeProvider({ model: 'ollama/llama3:8b' }).refused).toContain('judge_provider_alien01_model');
  });
  it('alien01ModelName takes ollama/ and local/ ids of the node list only', () => {
    expect(alien01ModelName('ollama/gemma4:26b')).toBe('gemma4:26b');
    expect(alien01ModelName('local/gemma4:12b')).toBe('gemma4:12b');
    expect(alien01ModelName('gemma4:12b')).toBeNull();
    expect(alien01ModelName(MODEL)).toBeNull();
  });
  it('judgeRunnerConfig: a refused OpenRouter route turns the runner off even with --runner on', () => {
    const c = judgeRunnerConfig({ runner: 'on', provider: 'openrouter' });
    expect(c.enabled).toBe(false);
    expect(c.note).toContain('judge_provider_openrouter_off');
    expect(judgeRunnerConfig({ runner: 'on', provider: 'openrouter', allowOpenrouter: true }).enabled).toBe(true);
    expect(judgeRunnerConfig({ runner: 'on', model: LOCAL })).toMatchObject({ enabled: true, provider: 'alien01' });
  });
});

describe('alien01Complete (stub infer command)', () => {
  const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({ model: LOCAL, system: 'sys', user: 'the trace', maxTokens: 200, temperature: 0, ...over });
  const stubRun = (code: number, stdout = '{"verdict":"pass","reason":"ok"}') => {
    const seen: Array<{ cmd: string; args: string[]; env: Record<string, string>; prompt: string }> = [];
    const run: RunInfer = async (cmd, args, env) => {
      const { readFileSync } = await import('node:fs');
      seen.push({ cmd, args, env, prompt: readFileSync(args[1]!, 'utf-8') });
      return { code, stdout };
    };
    return { seen, run };
  };
  it('runs "<cmd> infer <prompt> <schema> <model name>" with the profile and no key, and returns the node answer', async () => {
    const s = stubRun(0);
    const out = await alien01Complete({ command: '/x/run.sh', baseEnv: { PATH: '/bin', HOME: '/h' }, run: s.run })(req({ schema: { type: 'object' } }));
    expect(parseVerdict(out)).toEqual({ pass: true, reason: 'ok' });
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]!.cmd).toBe('/x/run.sh');
    expect(s.seen[0]!.args[0]).toBe('infer');
    expect(s.seen[0]!.args[3]).toBe('gemma4:26b');
    expect(s.seen[0]!.prompt).toContain('the trace');
    expect(s.seen[0]!.env).toMatchObject({ ...ALIEN01_PROFILE, LOCAL_BATCH_OUTPUT_TOKENS: '200', PATH: '/bin', HOME: '/h' });
    expect(Object.keys(s.seen[0]!.env).some((k) => /KEY|SECRET|PASSWORD|API/.test(k))).toBe(false);
  });
  it('removes the prompt directory after the call, on success and on failure', async () => {
    const { existsSync } = await import('node:fs');
    const ok = stubRun(0);
    await alien01Complete({ command: 'c', baseEnv: {}, run: ok.run })(req());
    expect(existsSync(ok.seen[0]!.args[1]!)).toBe(false);
    const bad = stubRun(75);
    await expect(alien01Complete({ command: 'c', baseEnv: {}, run: bad.run })(req())).rejects.toThrow();
    expect(existsSync(bad.seen[0]!.args[1]!)).toBe(false);
  });
  it('maps the exit code to an error NAME (10 = unreachable, other = Alien01Rc<rc>); a non-local model never runs', async () => {
    const s10 = stubRun(10);
    await expect(alien01Complete({ command: 'c', baseEnv: {}, run: s10.run })(req())).rejects.toMatchObject({ name: 'Alien01Unreachable' });
    const s75 = stubRun(75);
    await expect(alien01Complete({ command: 'c', baseEnv: {}, run: s75.run })(req())).rejects.toMatchObject({ name: 'Alien01Rc75' });
    const none = stubRun(0);
    await expect(alien01Complete({ command: 'c', baseEnv: {}, run: none.run })(req({ model: MODEL }))).rejects.toMatchObject({ name: 'Alien01ModelNotAllowed' });
    expect(none.seen).toHaveLength(0);
  });
  it('an unreachable node halts the run: the rest of the items make no call and spend no cap', async () => {
    const s = stubRun(10);
    const m = makeModelJudgeFn({ complete: alien01Complete({ command: 'c', baseEnv: {}, run: s.run }), loadText, config: { enabled: true, maxCalls: 50, note: null, provider: 'alien01' }, maxTextChars: ALIEN01_MAX_TEXT_CHARS });
    const a = await m.judgeFn(input('r1', LOCAL));
    const b = await m.judgeFn(input('r2', LOCAL));
    const c = await m.judgeFn(input('r3', LOCAL));
    expect(a.reason).toContain('Alien01Unreachable');
    expect(b.reason).toContain('judge_node_unreachable');
    expect(c.reason).toContain('judge_node_unreachable');
    expect(a.infra_ok || b.infra_ok || c.infra_ok).toBe(false);
    expect(s.seen).toHaveLength(1);
    expect(m.budget.used).toBe(1);
  });
  it('a text over the alien01 limit is not measured and makes no call', async () => {
    const s = stubRun(0);
    const m = makeModelJudgeFn({ complete: alien01Complete({ command: 'c', baseEnv: {}, run: s.run }), loadText: async () => 'x'.repeat(ALIEN01_MAX_TEXT_CHARS + 1), config: { enabled: true, maxCalls: 5, note: null, provider: 'alien01' }, maxTextChars: ALIEN01_MAX_TEXT_CHARS });
    expect((await m.judgeFn(input('r1', LOCAL))).reason).toContain('judge_text_too_long');
    expect(s.seen).toHaveLength(0);
    expect(m.budget.used).toBe(0);
  });
});

describe('tma eval judge calibrate --texts-dir', () => {
  const RUBRIC = 'Fail when a wait has no watcher.\n';
  function evalRepo() {
    const repo = mkdtempSync(join(tmpdir(), 'tma-c6prep-'));
    made.push(repo);
    const sets = join(repo, 'sets', 'calibration', 'j-scope');
    mkdirSync(sets, { recursive: true });
    writeFileSync(join(sets, 'test.jsonl'), ['t1', 't2', 't3', 't4'].map((id, i) => JSON.stringify({ id, label: i % 2 === 0 })).join('\n') + '\n');
    mkdirSync(join(repo, 'judges', 'j-scope', '1.0.0'), { recursive: true });
    writeFileSync(join(repo, 'judges', 'j-scope', '1.0.0', 'rubric.md'), RUBRIC);
    const texts = join(repo, 'texts');
    mkdirSync(texts);
    for (const id of ['t1', 't2', 't3', 't4']) writeFileSync(join(texts, `${id}.txt`), `text ${id}`);
    return { repo, texts };
  }
  const run = (cmd: Command, repo: string, texts: string, extra: string[] = []) => {
    const io = captureIo();
    return cmd.main(['judge', 'calibrate', '--repo', repo, '--judge', 'j-scope', '--version', '1.0.0', '--model', MODEL, '--texts-dir', texts, ...extra], io).then(
      (code) => ({ code, out: io.outText(), err: io.errText() }),
      (e) => ({ code: e instanceof CliError ? 1 : 99, out: io.outText(), err: e instanceof CliError ? e.message : String(e) }),
    );
  };
  const fetchCounting = (answers: string[]) => {
    const calls: unknown[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ choices: [{ message: { content: answers[Math.min(calls.length - 1, answers.length - 1)] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it('is off by default: no model call and no calibration.json', async () => {
    const { repo, texts } = evalRepo();
    const f = fetchCounting(['{"pass": true}']);
    const r = await run(makeRaw({ fetchImpl: f.fetchImpl, env: { OPENROUTER_API_KEY: 'k-test' } }), repo, texts, ['--provider', 'openrouter', '--allow-openrouter']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('did not measure 4 of 4');
    expect(r.err).not.toContain('k-test');
    expect(f.calls).toHaveLength(0);
  });

  it('on with a cap of 2: two calls, then the command stops measuring and writes nothing', async () => {
    const { repo, texts } = evalRepo();
    const f = fetchCounting(['{"pass": true}']);
    const r = await run(makeRaw({ fetchImpl: f.fetchImpl, env: { OPENROUTER_API_KEY: 'k-test' } }), repo, texts, ['--runner', 'on', '--max-calls', '2', '--provider', 'openrouter', '--allow-openrouter']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('did not measure 2 of 4');
    expect(f.calls).toHaveLength(2);
  });

  it('on with a cap that covers the split: the counts come from the model answers', async () => {
    const { repo, texts } = evalRepo();
    // labels: t1 true, t2 false, t3 true, t4 false. Answers: pass, fail, fail, pass -> tp 1, tn 1, fn 1, fp 1.
    const f = fetchCounting(['{"pass": true}', '{"pass": false}', '{"pass": false}', '{"pass": true}']);
    const r = await run(makeRaw({ fetchImpl: f.fetchImpl, env: { OPENROUTER_API_KEY: 'k-test' }, now: () => new Date('2026-11-17T00:00:00Z') }), repo, texts, ['--runner', 'on', '--max-calls', '4', '--provider', 'openrouter', '--allow-openrouter']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('judge runner: 4 of 4 model call(s) used');
    expect(r.out).toContain('tp 1 fn 1 tn 1 fp 1');
    expect(f.calls).toHaveLength(4);
  });

  it('on without a key is an error before any call; a bad cap is off; --runner without --texts-dir is refused', async () => {
    const { repo, texts } = evalRepo();
    const f = fetchCounting(['{"pass": true}']);
    const noKey = await run(makeRaw({ fetchImpl: f.fetchImpl, env: {} }), repo, texts, ['--runner', 'on', '--provider', 'openrouter', '--allow-openrouter']);
    expect(noKey.code).toBe(1);
    expect(noKey.err).toContain('OPENROUTER_API_KEY');
    const badCap = await run(makeRaw({ fetchImpl: f.fetchImpl, env: { OPENROUTER_API_KEY: 'k-test' } }), repo, texts, ['--runner', 'on', '--max-calls', '0', '--provider', 'openrouter', '--allow-openrouter']);
    expect(badCap.err).toContain('did not measure 4 of 4');
    expect(f.calls).toHaveLength(0);
    const io = captureIo();
    const code = await makeRaw({ env: {} }).main(['judge', 'calibrate', '--repo', repo, '--judge', 'j-scope', '--version', '1.0.0', '--model', MODEL, '--runner', 'on'], io).catch((e) => (e instanceof CliError ? e.message : 'x'));
    expect(code).toContain('need --texts-dir');
  });

  it('the default route is alien01: with --runner on and no --alien01-cmd it is an error before any call', async () => {
    const { repo, texts } = evalRepo();
    const f = fetchCounting(['{"pass": true}']);
    let ran = 0;
    const runInfer: RunInfer = async () => { ran += 1; return { code: 0, stdout: '{}' }; };
    const io = captureIo();
    const err = await makeRaw({ fetchImpl: f.fetchImpl, runInfer, env: { OPENROUTER_API_KEY: 'k-test' } })
      .main(['judge', 'calibrate', '--repo', repo, '--judge', 'j-scope', '--version', '1.0.0', '--model', LOCAL, '--public-set', '--texts-dir', texts, '--runner', 'on'], io)
      .catch((e) => (e instanceof CliError ? e.message : 'x'));
    expect(err).toContain('needs --alien01-cmd');
    expect(ran + f.calls.length).toBe(0);
  });
  it('alien01 with a local model and --alien01-cmd: the counts come from the node answers; fetch is never called', async () => {
    const { repo, texts } = evalRepo();
    const f = fetchCounting(['{"pass": true}']);
    const answers = ['pass', 'fail', 'fail', 'pass'];
    let n = 0;
    const runInfer: RunInfer = async () => ({ code: 0, stdout: JSON.stringify({ verdict: answers[n++] }) });
    const io = captureIo();
    const cmd = makeRaw({ fetchImpl: f.fetchImpl, runInfer, env: { PATH: '/bin', HOME: '/h' }, now: () => new Date('2026-11-17T00:00:00Z') });
    const code = await cmd.main(['judge', 'calibrate', '--repo', repo, '--judge', 'j-scope', '--version', '1.0.0', '--model', LOCAL, '--public-set', '--texts-dir', texts, '--runner', 'on', '--max-calls', '4', '--alien01-cmd', '/x/run.sh'], io);
    expect(code, io.errText()).toBe(0);
    expect(io.outText()).toContain('judge runner: 4 of 4 model call(s) used');
    expect(io.outText()).toContain('tp 1 fn 1 tn 1 fp 1');
    expect(f.calls).toHaveLength(0);
    expect(n).toBe(4);
  });
  it('--dry-run: alien01 with a command exits 0; OpenRouter without --allow-openrouter is refused (exit 1); nothing is called or written', async () => {
    const { repo, texts } = evalRepo();
    const f = fetchCounting(['{"pass": true}']);
    let ran = 0;
    const runInfer: RunInfer = async () => { ran += 1; return { code: 0, stdout: '{}' }; };
    const mk = () => makeRaw({ fetchImpl: f.fetchImpl, runInfer, env: { OPENROUTER_API_KEY: 'k-test' } });
    const dry = async (args: string[]) => {
      const io = captureIo();
      const code = await mk().main(['judge', 'calibrate', '--repo', repo, '--judge', 'j-scope', '--version', '1.0.0', '--dry-run', ...args], io);
      return { code, out: io.outText() };
    };
    const ok = await dry(['--model', LOCAL, '--runner', 'on', '--alien01-cmd', '/x/run.sh']);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('provider alien01');
    const or = await dry(['--model', MODEL, '--runner', 'on', '--provider', 'openrouter']);
    expect(or.code).toBe(1);
    expect(or.out).toContain('judge_provider_openrouter_off');
    expect(or.out).not.toContain('k-test');
    const orAllowed = await dry(['--model', MODEL, '--runner', 'on', '--provider', 'openrouter', '--allow-openrouter']);
    expect(orAllowed.code).toBe(0);
    const nonLocal = await dry(['--model', MODEL, '--runner', 'on', '--alien01-cmd', '/x/run.sh']);
    expect(nonLocal.code).toBe(1);
    expect(nonLocal.out).toContain('judge_provider_alien01_model');
    expect(f.calls).toHaveLength(0);
    expect(ran).toBe(0);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(repo, 'judges', 'j-scope', '1.0.0', 'calibration.json'))).toBe(false);
  });
});

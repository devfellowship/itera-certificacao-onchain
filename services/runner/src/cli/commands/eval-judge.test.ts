// Tests of the judge grader kind and its calibration gate (plan C3 T5). No model call, no network.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { caseErrors } from '../eval/case.js';
import { caseVerdict, NO_FACTS, runGraders, type GraderInput, type GraderResult } from '../eval/graders.js';
import { calibrationGate, makeJudgeGrader, privateTextModelAllowed, PRIVATE_TEXT_JUDGE_MODELS, type JudgeFn } from '../eval/judge.js';

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A judges dir with judges/<id>/<version>/calibration.json (null = no file). */
function judgesDir(cal: Record<string, unknown> | string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'tma-judges-'));
  made.push(dir);
  if (cal !== null) {
    mkdirSync(join(dir, 'j-scope', '1.0.0'), { recursive: true });
    writeFileSync(join(dir, 'j-scope', '1.0.0', 'calibration.json'), typeof cal === 'string' ? cal : JSON.stringify(cal));
  }
  return dir;
}
// tp/fn/tn/fp over n_test = 40: TPR = tp/(tp+fn), TNR = tn/(tn+fp)
const cal = (tp: number, fn: number, tn: number, fp: number) => ({ n_labels: 100, n_test: tp + fn + tn + fp, tp, fn, tn, fp, realigned_at: '2026-11-12T00:00:00Z' });

const passFn: JudgeFn = async () => ({ infra_ok: true, pass: true, reason: null });
const input = (executorModel: string | null = 'claude-opus-5-5'): GraderInput => ({
  runId: 'r1', task: null, patch: '', facts: NO_FACTS, grade: async () => { throw new Error('no sandbox'); }, config: null, log: () => {}, executorModel,
});
const entry = (decisive?: boolean) => ({ id: 'j-scope', version: '1.0.0', weight: 1, hard_gate: false, ...(decisive === undefined ? {} : { decisive }) });
const judge = (dir: string | undefined, over: Partial<Parameters<typeof makeJudgeGrader>[0]> = {}) =>
  makeJudgeGrader({ id: 'j-scope', semver: '1.0.0', rubric: 'Fail when the patch edits a file outside lib/.', expected: 'only lib/ changes', model: 'claude-sonnet-5-5', judgesDir: dir, judgeFn: passFn, ...over });
const run = async (dir: string | undefined, decisive: boolean | undefined, over = {}, exec: string | null = 'claude-opus-5-5') =>
  (await runGraders([entry(decisive)], input(exec), [judge(dir, over)])).results[0]!;

describe('judge grader kind (C3 T5)', () => {
  it('TPR 0.89 (TNR 0.95) is a side signal with the reason, and caseVerdict ignores it', async () => {
    // tp 89 fn 11 -> TPR 0.89; tn 95 fp 5 -> TNR 0.95
    const r = await run(judgesDir(cal(89, 11, 95, 5)), true);
    expect(r.decisive).toBe(false);
    expect(r.infra_ok).toBe(true);
    expect(r.reason).toBe('judge_not_calibrated: TPR 0.89 < 0.90');
    const code: GraderResult = { id: 'hidden-tests', version: '1', code_sha256: null, kind: 'code', pass: true, score: 80, weight: 1, hard_gate: false, decisive: true, infra_ok: true, reason: null };
    const failingJudge: GraderResult = { ...r, pass: false, score: 0, hard_gate: true };
    expect(caseVerdict([code, r])).toEqual(caseVerdict([code]));
    expect(caseVerdict([code, failingJudge])).toEqual({ infra_ok: true, pass: true, score: 80 });
  });

  it('refuses a judge whose model equals the executor model', async () => {
    const r = await run(judgesDir(cal(95, 5, 95, 5)), true, { model: 'anthropic/claude-opus-5.5' }, 'claude-opus-5-5');
    expect(r.infra_ok).toBe(false);
    expect(r.pass).toBe(false);
    expect(r.decisive).toBe(false);
    expect(r.reason).toContain('judge_model_equals_executor');
  });

  it('TPR 0.90 and TNR 0.90 exactly is decisive', async () => {
    const r = await run(judgesDir(cal(90, 10, 90, 10)), true);
    expect(r).toMatchObject({ decisive: true, infra_ok: true, pass: true, kind: 'judge' });
    expect(caseVerdict([r])).toEqual({ infra_ok: true, pass: true, score: 100 });
  });

  it('a good calibration is still a side signal when the entry does not ask for decisive', async () => {
    expect((await run(judgesDir(cal(90, 10, 90, 10)), undefined)).decisive).toBe(false);
    expect((await run(judgesDir(cal(90, 10, 90, 10)), false)).decisive).toBe(false);
  });

  it('a missing calibration.json is a side signal', async () => {
    const r = await run(judgesDir(null), true);
    expect(r.decisive).toBe(false);
    expect(r.reason).toContain('judge_not_calibrated: no calibration.json');
    expect((await run(undefined, true)).decisive).toBe(false);
  });

  it('inconsistent or empty counts are a side signal', async () => {
    expect(calibrationGate({ n_labels: 9, n_test: 10, tp: 5, fn: 0, tn: 5, fp: 1 })).toContain('inconsistent');
    expect(calibrationGate({ n_labels: 9, n_test: 0, tp: 0, fn: 0, tn: 0, fp: 0 })).toContain('n_test is 0');
    expect(calibrationGate(cal(10, 0, 0, 0))).toContain('TNR undefined');
    expect(calibrationGate(cal(0, 0, 10, 0))).toContain('TPR undefined');
    expect(calibrationGate({ n_test: 'x' })).toContain('integers');
    const r = await run(judgesDir({ ...cal(80, 5, 10, 5), n_test: 99 }), true);
    expect(r.decisive).toBe(false);
    expect((await run(judgesDir('{not json'), true)).reason).toContain('not valid JSON');
  });

  it('refuses a model outside the private list on a private case; a non-private case may use any model', async () => {
    const dir = judgesDir(cal(95, 5, 95, 5));
    const r = await run(dir, true, { model: 'openai/gpt-9' });
    expect(r.infra_ok).toBe(false);
    expect(r.reason).toContain('judge_model_not_allowed_for_private_text');
    expect((await run(dir, true, { model: 'openai/gpt-9', readsPrivateText: false })).decisive).toBe(true);
    expect((await run(dir, true, { model: 'ollama/qwen3:14b' })).decisive).toBe(true);
    expect(privateTextModelAllowed('local/whisper-x')).toBe(true);
    expect(privateTextModelAllowed('claude-haiku-5-5')).toBe(true);
    expect(privateTextModelAllowed('ollama/')).toBe(false);
    expect(PRIVATE_TEXT_JUDGE_MODELS).toHaveLength(4);
  });

  it('the default JudgeFn is not configured: infra_ok=false, never a pass', async () => {
    const g = makeJudgeGrader({ id: 'j-scope', semver: '1.0.0', rubric: 'r', expected: 'e', model: 'claude-sonnet-5-5', judgesDir: judgesDir(cal(95, 5, 95, 5)) });
    const r = (await runGraders([entry(true)], input(), [g])).results[0]!;
    expect(r).toMatchObject({ infra_ok: false, pass: false, decisive: false });
    expect(r.reason).toContain('judge_runner_not_configured');
    expect(caseVerdict([r]).infra_ok).toBe(false);
  });

  it('a failing calibrated judge is a decisive fail; the case format accepts the decisive flag', async () => {
    const r = (await runGraders([entry(true)], input(), [judge(judgesDir(cal(95, 5, 95, 5)), { judgeFn: async () => ({ infra_ok: true, pass: false, reason: 'edits src/' }) })])).results[0]!;
    expect(r).toMatchObject({ decisive: true, pass: false, score: 0 });
    const m = { schema: 'tma-case/1', case_key: 'c1', use_case: 'u', mode: 'patch', answer_shape: 'patch', pin: null, task_ref: { kind: 'tma-task', id: 'tsk_a@1.0.0' }, expected: { text: 'x', written_by: 'a', written_at: '2026-11-12T00:00:00Z' }, graders: [{ ...entry(true) }], split: 'none', source: 'synthetic' };
    expect(caseErrors(m).filter((e) => e.includes('decisive'))).toEqual([]);
    expect(caseErrors({ ...m, graders: [{ ...entry(), decisive: 'yes' }] }).join('\n')).toContain('/graders/0/decisive');
  });
});

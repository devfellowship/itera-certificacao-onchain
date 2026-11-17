// Tests of `tma eval judge calibrate` for the C6-T5 calibration run (plan 20261112-tma-c6-judge-calibration):
// dfl-evals tma-calibration-label/1 rows, the refusal of a weak test row, --split dev (hand iteration, no record)
// and --verdicts-out (the input of dfl-evals ci/calibration_metrics.py). No model is called: the JudgeFn is a fake.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Command } from '../command.js';
import { CliError } from '../env.js';
import type { JudgeFn } from '../eval/judge.js';
import { captureIo } from '../test/fixtures.js';
import { makeEvalCommand as makeRaw, type EvalCommandDeps } from './eval.js';

function makeEvalCommand(deps?: EvalCommandDeps): Command {
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

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `tma-cal-${p}-`));
  dirs.push(d);
  return d;
};

const JUDGE = 'async-wait-lifecycle';
const runId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const numOf = (id: string) => parseInt(id.slice(-12), 16);
/** The person's label of item n: fail on every 3rd item. */
const truth = (n: number) => n % 3 !== 0;

function row(n: number, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 'tma-calibration-label/1', judge_id: JUDGE, run_id: runId(n), task_id: `task-${n}`,
    label: truth(n) ? 'pass' : 'fail', labeler: 'person:13efcd4f-a9b9-44bd-86b0-ed01eba0443e', strength: 'strong',
    reason_code: 'polled-in-session', run_model_id: 'claude-opus-5-5', ...over,
  });
}

/** Item numbers: train 1..10 (weak rows allowed), dev 11..40, test 41..100. */
function evalRepo(opts: { weakInTest?: boolean } = {}): string {
  const repo = tmp('repo');
  const sets = join(repo, 'sets', 'calibration', JUDGE);
  mkdirSync(sets, { recursive: true });
  const lines = (a: number, b: number, f: (n: number) => string) => `${Array.from({ length: b - a + 1 }, (_, i) => f(a + i)).join('\n')}\n`;
  writeFileSync(join(sets, 'train.jsonl'), lines(1, 10, (n) => row(n, { strength: 'weak', labeler: 'workflow:clean-merge', label: 'pass' })));
  writeFileSync(join(sets, 'dev.jsonl'), lines(11, 40, (n) => row(n)));
  writeFileSync(join(sets, 'test.jsonl'), lines(41, 100, (n) => row(n, opts.weakInTest && n === 77 ? { strength: 'weak' } : {})));
  mkdirSync(join(repo, 'judges', JUDGE, '0.1.0'), { recursive: true });
  writeFileSync(join(repo, 'judges', JUDGE, '0.1.0', 'rubric.md'), 'RUBRIC: fail when the session polls CI in its own turn.');
  return repo;
}

/** Right on every item except each 7th, where it flips the person's label. */
function fakeJudge() {
  const seen: string[] = [];
  const fn: JudgeFn = async (i) => {
    seen.push(i.outputHandle);
    const n = numOf(i.outputHandle);
    return { infra_ok: true, pass: n % 7 === 0 ? !truth(n) : truth(n), reason: null };
  };
  return { fn, seen };
}

function expected(a: number, b: number) {
  let tp = 0, fn = 0, tn = 0, fp = 0;
  for (let n = a; n <= b; n++) {
    const pass = n % 7 === 0 ? !truth(n) : truth(n);
    if (truth(n)) pass ? tp++ : fn++;
    else pass ? fp++ : tn++;
  }
  return { tp, fn, tn, fp };
}

const args = (repo: string, extra: string[] = []) => ['judge', 'calibrate', '--repo', repo, '--judge', JUDGE, '--version', '0.1.0', '--model', 'anthropic/claude-sonnet-5.5', ...extra];
const calFile = (repo: string) => join(repo, 'judges', JUDGE, '0.1.0', 'calibration.json');

describe('tma eval judge calibrate on dfl-evals label rows (C6-T5)', () => {
  it('reads tma-calibration-label/1 rows: the item is the run_id, the counts are right, and calibration.json keeps its shape', async () => {
    const repo = evalRepo();
    const j = fakeJudge();
    const io = captureIo();
    expect(await makeEvalCommand({ judgeFn: j.fn, now: () => new Date('2026-11-17T05:00:00Z') }).main(args(repo), io), io.errText()).toBe(0);
    expect(j.seen).toHaveLength(60);
    expect(j.seen[0]).toBe(runId(41));
    const c = JSON.parse(readFileSync(calFile(repo), 'utf-8'));
    expect(Object.keys(c)).toEqual(['n_labels', 'n_test', 'tp', 'fn', 'tn', 'fp', 'realigned_at']);
    expect(c).toEqual({ n_labels: 100, n_test: 60, ...expected(41, 100), realigned_at: '2026-11-17T05:00:00.000Z' });
    expect(io.outText()).toMatch(/judge calibration \(test split\): n 60, /);
  });

  it('--verdicts-out writes one {run_id, verdict} line per measured item, in split order', async () => {
    const repo = evalRepo();
    const out = join(repo, 'verdicts.jsonl');
    const io = captureIo();
    expect(await makeEvalCommand({ judgeFn: fakeJudge().fn }).main(args(repo, ['--verdicts-out', out]), io), io.errText()).toBe(0);
    const lines = readFileSync(out, 'utf-8').trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(60);
    lines.forEach((l, i) => {
      const n = 41 + i;
      expect(l).toEqual({ run_id: runId(n), verdict: (n % 7 === 0 ? !truth(n) : truth(n)) ? 'pass' : 'fail' });
    });
    expect(io.outText()).toContain(`verdicts: ${out}`);
  });

  it('--split dev answers only the dev items, prints the rates, and never writes or changes calibration.json', async () => {
    const repo = evalRepo();
    writeFileSync(calFile(repo), 'EARLIER-RECORD\n');
    const j = fakeJudge();
    const out = join(repo, 'dev-verdicts.jsonl');
    const io = captureIo();
    expect(await makeEvalCommand({ judgeFn: j.fn }).main(args(repo, ['--split', 'dev', '--verdicts-out', out]), io), io.errText()).toBe(0);
    expect(j.seen).toEqual(Array.from({ length: 30 }, (_, i) => runId(11 + i)));
    expect(readFileSync(calFile(repo), 'utf-8')).toBe('EARLIER-RECORD\n');
    const e = expected(11, 40);
    const tpr = (e.tp / (e.tp + e.fn)).toFixed(4);
    const tnr = (e.tn / (e.tn + e.fp)).toFixed(4);
    expect(io.outText()).toContain(`judge calibration (dev split): n 30, tp ${e.tp} fn ${e.fn} tn ${e.tn} fp ${e.fp}, TPR ${tpr} TNR ${tnr}`);
    expect(io.outText()).toContain('dev split: no calibration.json is written');
    expect(io.outText()).toMatch(/dev: under the bar \(judge_not_calibrated: /);
    expect(readFileSync(out, 'utf-8').trimEnd().split('\n')).toHaveLength(30);
  });

  it('--split dev with a perfect judge says to run the test split once', async () => {
    const repo = evalRepo();
    const perfect: JudgeFn = async (i) => ({ infra_ok: true, pass: truth(numOf(i.outputHandle)), reason: null });
    const io = captureIo();
    expect(await makeEvalCommand({ judgeFn: perfect }).main(args(repo, ['--split', 'dev']), io), io.errText()).toBe(0);
    expect(io.outText()).toContain('TPR 1.0000 TNR 1.0000');
    expect(io.outText()).toContain('dev: both rates >= 0.90; run the test split once on this version');
    expect(existsSync(calFile(repo))).toBe(false);
  });

  it('refuses a weak row in the test split before any judge call (C6 ADR-3)', async () => {
    const repo = evalRepo({ weakInTest: true });
    const j = fakeJudge();
    const io = captureIo();
    expect(await makeEvalCommand({ judgeFn: j.fn }).main(args(repo), io)).toBe(1);
    expect(io.errText()).toContain(`the test split holds a weak label (run ${runId(77)})`);
    expect(j.seen).toEqual([]);
    expect(existsSync(calFile(repo))).toBe(false);
    // The weak row stops a dev measurement too: the test split must be clean before any number is reported.
    expect(await makeEvalCommand({ judgeFn: j.fn }).main(args(repo, ['--split', 'dev']), captureIo())).toBe(1);
    expect(j.seen).toEqual([]);
  });

  it('writes no verdicts and no record when one item is not measured', async () => {
    const repo = evalRepo();
    const out = join(repo, 'verdicts.jsonl');
    const half: JudgeFn = async (i) => (numOf(i.outputHandle) === 90 ? { infra_ok: false, pass: false, reason: 'judge_call_cap_reached' } : { infra_ok: true, pass: true, reason: null });
    const io = captureIo();
    expect(await makeEvalCommand({ judgeFn: half }).main(args(repo, ['--verdicts-out', out]), io)).toBe(1);
    expect(io.errText()).toMatch(/did not measure 1 of 60 test item\(s\).*no calibration\.json and no verdicts/);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(calFile(repo))).toBe(false);
  });

  it('refuses a bad split, a row with no run_id, an unknown schema, and a bad label or strength', async () => {
    const repo = evalRepo();
    const io = captureIo();
    expect(await makeEvalCommand({ judgeFn: fakeJudge().fn }).main(args(repo, ['--split', 'train']), io)).toBe(1);
    expect(io.errText()).toMatch(/bad split: train/);
    const dev = join(repo, 'sets', 'calibration', JUDGE, 'dev.jsonl');
    const cases: [string, RegExp][] = [
      [`${JSON.stringify({ ...JSON.parse(row(11)), run_id: undefined })}\n`, /dev\.jsonl:1: a tma-calibration-label\/1 row needs a run_id/],
      [`${row(11, { schema: 'tma-calibration-label/9' })}\n`, /dev\.jsonl:1: unknown label schema/],
      [`${row(11, { label: true })}\n`, /dev\.jsonl:1: label must be "pass" or "fail"/],
      [`${row(11, { strength: 'medium' })}\n`, /dev\.jsonl:1: strength must be "strong" or "weak"/],
      [`${row(11)}\n${row(11)}\n`, /dev\.jsonl:2: id .* is listed twice/],
      [`${row(41)}\n`, /is in both (dev and test|test and dev)/],
    ];
    for (const [text, re] of cases) {
      writeFileSync(dev, text);
      const e = captureIo();
      expect(await makeEvalCommand({ judgeFn: fakeJudge().fn }).main(args(repo), e)).toBe(1);
      expect(e.errText()).toMatch(re);
    }
    expect(existsSync(calFile(repo))).toBe(false);
  });
});

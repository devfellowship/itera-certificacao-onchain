// The judge grader kind and its calibration gate (plan C3 T5, ADR-5, Q-T6 = A).
//
// One judge = one failure mode = a binary result. The kit, not policy text, decides whether a judge may
// be decisive: a case entry with `decisive: true` counts only when the judge version record
// `<judgesDir>/<id>/<version>/calibration.json` shows TPR >= 0.90 AND TNR >= 0.90 on its test split.
// Else the result is a side signal (decisive = false) and `reason` says why.
// The model call sits behind an injectable JudgeFn. This kit is not wired to a model runner yet: the
// default JudgeFn answers infra_ok = false (judge_runner_not_configured).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Grader, GraderInput, GraderOutcome } from './graders.js';
import { catalogModelId } from './upload.js';

export const JUDGE_MIN_RATE = 0.9;

/** A11 Q1 = B: the models a judge may use when it reads private case text (catalog ids). */
export const PRIVATE_TEXT_JUDGE_MODELS: readonly string[] = [
  'anthropic/claude-opus-5.5',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-haiku-5.5',
  'anthropic/claude-fable-5.2',
];
/** Local models served on the owner's own host: route prefix ollama/ or local/. */
export const PRIVATE_TEXT_LOCAL_ROUTE = /^(?:ollama|local)\/\S+$/;

export function privateTextModelAllowed(model: string): boolean {
  const id = catalogModelId(model);
  return PRIVATE_TEXT_JUDGE_MODELS.includes(id) || PRIVATE_TEXT_LOCAL_ROUTE.test(id);
}

export interface JudgeInput {
  rubric: string;
  /** The case's expected text. */
  expected: string;
  /** A handle (path or digest) of the output under judgment; the JudgeFn reads it itself. */
  outputHandle: string;
  model: string;
}
export interface JudgeAnswer {
  infra_ok: boolean;
  pass: boolean;
  reason: string | null;
}
export type JudgeFn = (input: JudgeInput) => Promise<JudgeAnswer>;

export const unconfiguredJudgeFn: JudgeFn = async () => ({ infra_ok: false, pass: false, reason: 'judge_runner_not_configured: this kit is not wired to a model runner' });

export interface Calibration {
  n_labels: number;
  n_test: number;
  tp: number;
  fn: number;
  tn: number;
  fp: number;
  realigned_at?: string;
}

/** Why a calibration record does not allow a decisive judge, or null when it does. */
export function calibrationGate(c: unknown): string | null {
  if (typeof c !== 'object' || c === null) return 'judge_not_calibrated: calibration.json is not an object';
  const r = c as Record<string, unknown>;
  const counts = ['n_test', 'tp', 'fn', 'tn', 'fp'].map((k) => r[k]);
  if (!counts.every((n) => Number.isInteger(n) && (n as number) >= 0)) return 'judge_not_calibrated: counts must be integers of 0 or more';
  const [nTest, tp, fn, tn, fp] = counts as number[];
  if (nTest <= 0) return 'judge_not_calibrated: n_test is 0';
  if (tp + fn + tn + fp !== nTest) return `judge_not_calibrated: counts are inconsistent (tp+fn+tn+fp = ${tp + fn + tn + fp}, n_test = ${nTest})`;
  if (tp + fn === 0) return 'judge_not_calibrated: no positive label in the test split (TPR undefined)';
  if (tn + fp === 0) return 'judge_not_calibrated: no negative label in the test split (TNR undefined)';
  const tpr = tp / (tp + fn);
  const tnr = tn / (tn + fp);
  const why: string[] = [];
  if (tpr < JUDGE_MIN_RATE) why.push(`TPR ${tpr.toFixed(2)} < ${JUDGE_MIN_RATE.toFixed(2)}`);
  if (tnr < JUDGE_MIN_RATE) why.push(`TNR ${tnr.toFixed(2)} < ${JUDGE_MIN_RATE.toFixed(2)}`);
  return why.length ? `judge_not_calibrated: ${why.join(', ')}` : null;
}

async function readCalibration(judgesDir: string | undefined, id: string, version: string): Promise<{ gate: string | null }> {
  if (!judgesDir) return { gate: 'judge_not_calibrated: no judges dir given' };
  const file = join(judgesDir, id, version, 'calibration.json');
  const raw = await readFile(file, 'utf-8').catch(() => null);
  if (raw === null) return { gate: `judge_not_calibrated: no calibration.json at judges/${id}/${version}/` };
  try {
    return { gate: calibrationGate(JSON.parse(raw)) };
  } catch {
    return { gate: 'judge_not_calibrated: calibration.json is not valid JSON' };
  }
}

export interface JudgeGraderOptions {
  id: string;
  semver: string;
  /** The rubric text: one failure mode. Its digest is the grader code digest. */
  rubric: string;
  /** The case's expected text. */
  expected: string;
  /** The judge model (any spelling; compared by catalog id). */
  model: string;
  /** The eval repo's judges/ folder (the case folder copy or --judges-dir). */
  judgesDir?: string;
  /** The judge reads private case text (default true: fail closed). */
  readsPrivateText?: boolean;
  judgeFn?: JudgeFn;
  /** Handle of the output under judgment given to the JudgeFn. */
  outputHandle?: (input: GraderInput) => string;
}

const refused = (reason: string): GraderOutcome => ({ pass: false, score: null, infra_ok: false, reason });

export function makeJudgeGrader(o: JudgeGraderOptions): Grader {
  const judgeFn = o.judgeFn ?? unconfiguredJudgeFn;
  return {
    id: o.id,
    semver: o.semver,
    kind: 'judge',
    needsSandbox: false,
    codeSha256: async () => createHash('sha256').update(o.rubric).digest('hex'),
    async run(input) {
      const judgeModel = catalogModelId(o.model);
      if (input.executorModel && catalogModelId(input.executorModel) === judgeModel) {
        return refused(`judge_model_equals_executor: the judge model ${judgeModel} is the executor model (a judge must differ from the executor)`);
      }
      if ((o.readsPrivateText ?? true) && !privateTextModelAllowed(o.model)) {
        return refused(`judge_model_not_allowed_for_private_text: ${judgeModel} is not a fleet Claude model or a local ollama/ or local/ model (A11 Q1 = B)`);
      }
      const answer = await judgeFn({ rubric: o.rubric, expected: o.expected, outputHandle: o.outputHandle?.(input) ?? input.runId, model: o.model });
      if (!answer.infra_ok) return refused(answer.reason ?? 'judge did not measure');
      const { gate } = await readCalibration(o.judgesDir, o.id, o.semver);
      return { pass: answer.pass, score: answer.pass ? 100 : 0, infra_ok: true, reason: gate ?? answer.reason, calibrated: gate === null };
    },
  };
}

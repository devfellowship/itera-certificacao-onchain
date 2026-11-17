// `tma eval judge calibrate` (plan C3 T11, ADR-5): measure a judge against human labels and write its
// version record judges/<id>/<version>/calibration.json {n_labels, n_test, tp, fn, tn, fp, realigned_at}.
//
// Labels: sets/calibration/<judge-id>/{train,dev,test}.jsonl. A line is either {"id": "...", "label": true|false}
// or a dfl-evals tma-calibration-label/1 row (C6-T4: "label": "pass"|"fail", "run_id", "strength", optional
// "run_model_id"); the item id of such a row is its run_id. label true / "pass" = the person says the output passes
// the judge's failure-mode check. A weak row in the test split is refused (C6 ADR-3, Q-C6-T2 = A).
// --split dev measures the dev split for the hand iteration (C6 ADR-5) and writes NO calibration.json: the gate
// reads the test split only. --verdicts-out writes one {"run_id", "verdict"} line per measured item, the input of
// dfl-evals ci/calibration_metrics.py (TPR, TNR, stratified 95 % bootstrap interval, self/other family). The judge answers each
// TEST item through the injectable JudgeFn (this kit makes no model call itself):
//   tp: label true,  judge pass     fn: label true,  judge fail
//   tn: label false, judge fail     fp: label false, judge pass
// So TPR = tp/(tp+fn) and TNR = tn/(tn+fp), as calibrationGate (judge.ts) reads them.
// n_labels counts every split; train and dev are only counted (they are where the rubric is tuned).
//
// Fail closed: a private case set (the default) refuses a judge model outside the A11 Q1 = B list
// (privateTextModelAllowed); --public-set lifts that. A judge answer with infra_ok = false means the
// judge did not measure: no calibration.json is written. calibration.json holds counts only: no
// prompt, rubric or item text.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CliError } from '../env.js';
import { catalogModelId } from './upload.js';
import { calibrationGate, privateTextModelAllowed, unconfiguredJudgeFn, type Calibration, type JudgeFn } from './judge.js';

export const SPLITS = ['train', 'dev', 'test'] as const;
export type Split = (typeof SPLITS)[number];

export const CALIBRATION_LABEL_FORMAT = 'tma-calibration-label/1';
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface LabelRow {
  id: string;
  label: boolean;
  /** tma-calibration-label/1 rows only. */
  strength?: 'strong' | 'weak';
}

export type MeasuredSplit = 'dev' | 'test';

export interface SplitCounts {
  split: MeasuredSplit;
  n: number;
  tp: number;
  fn: number;
  tn: number;
  fp: number;
  /** Null when the split has no row of that label. */
  tpr: number | null;
  tnr: number | null;
}

export interface CalibrateResult {
  /** The counts of the measured split. */
  measured: SplitCounts;
  /** The test record; null for --split dev (nothing is written then). */
  calibration: Required<Calibration> | null;
  /** calibration.json, or null for --split dev. */
  file: string | null;
  /** The verdicts file, when asked. */
  verdictsFile: string | null;
  /** Null when the counts would allow a decisive judge, else why not. For dev this is advice only. */
  gate: string | null;
}

const LABEL_LINE_HELP = 'a label line is {"id": "<id>", "label": true|false} or a tma-calibration-label/1 row with a run_id';

function parseFormatRow(r: Record<string, unknown>, at: string): LabelRow {
  if (typeof r.run_id !== 'string' || !RUN_ID_RE.test(r.run_id)) throw new CliError(`${at}: a ${CALIBRATION_LABEL_FORMAT} row needs a run_id (the judge reads one run per item)`);
  if (r.label !== 'pass' && r.label !== 'fail') throw new CliError(`${at}: label must be "pass" or "fail"`);
  if (r.strength !== 'strong' && r.strength !== 'weak') throw new CliError(`${at}: strength must be "strong" or "weak"`);
  return { id: r.run_id, label: r.label === 'pass', strength: r.strength };
}

/** Parse one labels file. Each line: {"id": string, "label": boolean}, or a tma-calibration-label/1 row. */
export function parseLabels(text: string, where: string): LabelRow[] {
  const rows: LabelRow[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      throw new CliError(`${where}:${i + 1}: not JSON`);
    }
    const r = v as Record<string, unknown>;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new CliError(`${where}:${i + 1}: ${LABEL_LINE_HELP}`);
    let row: LabelRow;
    if (r.schema !== undefined) {
      if (r.schema !== CALIBRATION_LABEL_FORMAT) throw new CliError(`${where}:${i + 1}: unknown label schema (want ${CALIBRATION_LABEL_FORMAT})`);
      row = parseFormatRow(r, `${where}:${i + 1}`);
    } else {
      if (typeof r.id !== 'string' || r.id === '' || typeof r.label !== 'boolean') throw new CliError(`${where}:${i + 1}: ${LABEL_LINE_HELP}`);
      row = { id: r.id, label: r.label };
    }
    if (seen.has(row.id)) throw new CliError(`${where}:${i + 1}: id ${row.id.slice(0, 64)} is listed twice`);
    seen.add(row.id);
    rows.push(row);
  });
  return rows;
}

async function readSplit(dir: string, split: Split): Promise<LabelRow[] | null> {
  const file = join(dir, `${split}.jsonl`);
  const text = await readFile(file, 'utf-8').catch(() => null);
  return text === null ? null : parseLabels(text, file);
}

export async function calibrateJudge(input: {
  /** The eval repo root: sets/ and judges/ live there. */
  repo: string;
  judgeId: string;
  version: string;
  model: string;
  /** The case set is public: any judge model may read it. Default false (private). */
  publicSet?: boolean;
  /** Overrides: the labels folder and the judges folder. */
  labelsDir?: string;
  judgesDir?: string;
  judgeFn?: JudgeFn;
  /** The split the judge answers: test (default; writes calibration.json) or dev (hand iteration; writes nothing). */
  split?: MeasuredSplit;
  /** Write one {"run_id", "verdict"} line per measured item here (input of dfl-evals calibration_metrics.py). */
  verdictsOut?: string;
  now?: () => Date;
  log?: (line: string) => void;
}): Promise<CalibrateResult> {
  const split: MeasuredSplit = input.split ?? 'test';
  if (split !== 'dev' && split !== 'test') throw new CliError(`bad split: ${String(split).slice(0, 20)} (dev or test)`);
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(input.judgeId) || input.judgeId.startsWith('.')) throw new CliError(`bad judge id: ${input.judgeId.slice(0, 80)}`);
  if (!/^[A-Za-z0-9_.+-]{1,40}$/.test(input.version) || input.version.startsWith('.')) throw new CliError(`bad judge version: ${input.version.slice(0, 40)}`);
  // Refuse before any label is read or any judge answer is asked.
  if (!input.publicSet && !privateTextModelAllowed(input.model)) {
    throw new CliError(`judge_model_not_allowed_for_private_text: ${catalogModelId(input.model)} is not a fleet Claude model or a local ollama/ or local/ model (A11 Q1 = B). Use --public-set only when the case set is public.`);
  }
  const repo = resolve(input.repo);
  const labelsDir = resolve(input.labelsDir ?? join(repo, 'sets', 'calibration', input.judgeId));
  const judgesDir = resolve(input.judgesDir ?? join(repo, 'judges'));
  const splits = new Map<Split, LabelRow[]>();
  for (const s of SPLITS) {
    const rows = await readSplit(labelsDir, s);
    if (rows) splits.set(s, rows);
  }
  const test = splits.get('test');
  if (!test || test.length === 0) throw new CliError(`no test split: ${join(labelsDir, 'test.jsonl')} is missing or empty`);
  const weak = test.find((r) => r.strength === 'weak');
  if (weak) throw new CliError(`the test split holds a weak label (run ${weak.id.slice(0, 64)}): only strong labels may enter test (C6 ADR-3)`);
  const items = splits.get(split);
  if (!items || items.length === 0) throw new CliError(`no ${split} split: ${join(labelsDir, `${split}.jsonl`)} is missing or empty`);
  // An id in two splits is a leak from tuning into the test.
  const owner = new Map<string, Split>();
  for (const [s, rows] of splits) {
    for (const r of rows) {
      const o = owner.get(r.id);
      if (o) throw new CliError(`label id ${r.id.slice(0, 64)} is in both ${o} and ${s}: the splits must not share an item`);
      owner.set(r.id, s);
    }
  }
  const rubric = await readFile(join(judgesDir, input.judgeId, input.version, 'rubric.md'), 'utf-8').catch(() => null);
  if (rubric === null) throw new CliError(`no rubric: ${join(judgesDir, input.judgeId, input.version, 'rubric.md')}`);

  const judgeFn = input.judgeFn ?? unconfiguredJudgeFn;
  let tp = 0, fn = 0, tn = 0, fp = 0;
  const notMeasured: string[] = [];
  const verdicts: string[] = [];
  for (const row of items) {
    const a = await judgeFn({ rubric, expected: '', outputHandle: row.id, model: input.model });
    if (!a.infra_ok) {
      notMeasured.push(row.id);
      continue;
    }
    verdicts.push(JSON.stringify({ run_id: row.id, verdict: a.pass ? 'pass' : 'fail' }));
    if (row.label) a.pass ? tp++ : fn++;
    else a.pass ? fp++ : tn++;
  }
  if (notMeasured.length > 0) {
    throw new CliError(`the judge did not measure ${notMeasured.length} of ${items.length} ${split} item(s) (first: ${notMeasured[0]!.slice(0, 64)}): no calibration.json and no verdicts are written`);
  }
  const measured: SplitCounts = {
    split, n: items.length, tp, fn, tn, fp,
    tpr: tp + fn === 0 ? null : tp / (tp + fn),
    tnr: tn + fp === 0 ? null : tn / (tn + fp),
  };
  let verdictsFile: string | null = null;
  if (input.verdictsOut) {
    verdictsFile = resolve(input.verdictsOut);
    await writeFile(verdictsFile, `${verdicts.join('\n')}\n`, 'utf-8');
  }
  const counts = { n_labels: [...splits.values()].reduce((s, rows) => s + rows.length, 0), n_test: items.length, tp, fn, tn, fp };
  // The gate reads the test split only: a dev measurement never writes the record.
  if (split === 'dev') return { measured, calibration: null, file: null, verdictsFile, gate: calibrationGate(counts) };
  const calibration: Required<Calibration> = { ...counts, realigned_at: (input.now ?? (() => new Date()))().toISOString() };
  const dir = join(judgesDir, input.judgeId, input.version);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'calibration.json');
  await writeFile(file, `${JSON.stringify(calibration, null, 2)}\n`, 'utf-8');
  return { measured, calibration, file, verdictsFile, gate: calibrationGate(calibration) };
}

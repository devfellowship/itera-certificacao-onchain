// `tma eval judge calibrate` (plan C3 T11, ADR-5): measure a judge against human labels and write its
// version record judges/<id>/<version>/calibration.json {n_labels, n_test, tp, fn, tn, fp, realigned_at}.
//
// Labels: sets/calibration/<judge-id>/{train,dev,test}.jsonl, one line {"id": "...", "label": true|false}.
// label true = the human says the output passes the judge's failure-mode check. The judge answers each
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

export interface LabelRow {
  id: string;
  label: boolean;
}

export interface CalibrateResult {
  calibration: Required<Calibration>;
  file: string;
  /** Null when the record allows a decisive judge, else why not. */
  gate: string | null;
}

/** Parse one labels file. Each line: {"id": string, "label": boolean}. */
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
    if (typeof v !== 'object' || v === null || typeof r.id !== 'string' || r.id === '' || typeof r.label !== 'boolean') {
      throw new CliError(`${where}:${i + 1}: a label line is {"id": "<id>", "label": true|false}`);
    }
    if (seen.has(r.id)) throw new CliError(`${where}:${i + 1}: id ${r.id.slice(0, 64)} is listed twice`);
    seen.add(r.id);
    rows.push({ id: r.id, label: r.label });
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
  now?: () => Date;
  log?: (line: string) => void;
}): Promise<CalibrateResult> {
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
  for (const row of test) {
    const a = await judgeFn({ rubric, expected: '', outputHandle: row.id, model: input.model });
    if (!a.infra_ok) {
      notMeasured.push(row.id);
      continue;
    }
    if (row.label) a.pass ? tp++ : fn++;
    else a.pass ? fp++ : tn++;
  }
  if (notMeasured.length > 0) {
    throw new CliError(`the judge did not measure ${notMeasured.length} of ${test.length} test item(s) (first: ${notMeasured[0]!.slice(0, 64)}): no calibration.json is written`);
  }
  const calibration: Required<Calibration> = {
    n_labels: [...splits.values()].reduce((s, rows) => s + rows.length, 0),
    n_test: test.length,
    tp,
    fn,
    tn,
    fp,
    realigned_at: (input.now ?? (() => new Date()))().toISOString(),
  };
  const dir = join(judgesDir, input.judgeId, input.version);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'calibration.json');
  await writeFile(file, `${JSON.stringify(calibration, null, 2)}\n`, 'utf-8');
  return { calibration, file, gate: calibrationGate(calibration) };
}

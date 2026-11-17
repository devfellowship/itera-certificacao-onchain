// `tma eval judge labels` (plan 20261112-tma-c6-judge-calibration, task C6-T5): read the labels of the review runs
// of one or more batch files back from the TMA API and write them as dfl-evals label rows (tma-calibration-label/1),
// the input of `ci/calibration_split.py split` (C6-T4) and of `tma eval judge calibrate`.
//
//   input   the batch files of `tma eval review-batch` (tma-review-batch/1): case key, task id, pin record (model id).
//   read    per case key: GET /review-queue/runs?case_key= (the runs), then per run GET /grader-results/human?run_id=.
//           The review queue is NOT the source: it hides every run that a person has labeled for the judge.
//   choose  per run and judge, one label: the latest person label (strong) wins over a workflow label (weak, the API
//           strength). An agent:<uuid> or user:<uuid> label is not a person label in a calibration split: it is skipped
//           and counted. A run with no person and no workflow label gives no row.
//   output  one JSON line per labeled run, keys sorted: ids, label, labeler, strength, reason_code, run_model_id. No
//           task text. reason_code: the API reason (wrong_sha → wrong-sha), or "unspecified" when the label has none.
//           Any refused API read stops the command before the output file is written (no partial split input).
//   pace    the API allows a fixed number of requests per 15 min. A 429 waits 60, 120, 240, then 480 s and asks again
//           (15 min in all, one rate window); a fifth 429 stops the command, with nothing written.
import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { apiCall, describeRefusal, type Fetch } from '../api.js';
import { flag, flagList, parseArgs } from '../args.js';
import type { Io } from '../command.js';
import { apiUrl, CliError } from '../env.js';
import { requireSession } from '../session.js';
import { CALIBRATION_LABEL_FORMAT } from './calibrate.js';
import { parseReviewBatch, type ReviewBatchRow } from './review-batch.js';

export const JUDGE_LABELS_USAGE = `usage: tma eval judge labels --judge <id> --batch <file> [--batch <file>]... [--out <labels.jsonl>]
  Reads the labels of the review runs of the batch files from the TMA API (your login) and writes one
  tma-calibration-label/1 row per labeled run: the input of dfl-evals ci/calibration_split.py.
  Per run the latest person label (strong) wins over a workflow label (weak). agent: and user: labels are skipped.
  No task text is read or written. A refused read writes nothing.`;

const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JUDGE_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const PERSON_RE = /^person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKFLOW_RE = /^workflow:[a-z0-9][a-z0-9._-]{1,62}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

export interface ApiLabel {
  runId: string;
  judgeId: string;
  pass: boolean;
  reasonCode: string | null;
  labeler: string | null;
  gradedAt: string;
  strength: 'strong' | 'weak' | null;
}

export interface CalibrationLabelRow {
  schema: typeof CALIBRATION_LABEL_FORMAT;
  judge_id: string;
  run_id: string;
  case_key: string;
  task_id: string;
  label: 'pass' | 'fail';
  labeler: string;
  strength: 'strong' | 'weak';
  reason_code: string;
  run_model_id?: string;
}

export type Skip = 'agent_or_user_labeler' | 'no_label' | 'unknown_labeler';

/** The model id of a run without its route prefix (anthropic/claude-opus-5.5 → claude-opus-5.5), or null. */
export function runModelId(row: ReviewBatchRow): string | null {
  const m = row.pin.record.model_id;
  if (typeof m !== 'string' || m === '') return null;
  const bare = m.includes('/') ? m.slice(m.lastIndexOf('/') + 1) : m;
  return MODEL_RE.test(bare) ? bare : null;
}

export function reasonCodeOf(r: string | null): string {
  if (r === null || r === '') return 'unspecified';
  const c = r.toLowerCase().replace(/_/g, '-');
  return /^[a-z0-9][a-z0-9-]{1,62}$/.test(c) ? c : 'unspecified';
}

/** Pick the one label of a run for a judge: the latest person label, else the latest workflow label. */
export function chooseLabel(labels: ApiLabel[], judgeId: string): { label: ApiLabel | null; skip: Skip | null } {
  const mine = labels.filter((l) => l.judgeId === judgeId);
  const latest = (xs: ApiLabel[]) => [...xs].sort((a, b) => (a.gradedAt < b.gradedAt ? 1 : a.gradedAt > b.gradedAt ? -1 : 0))[0] ?? null;
  const person = latest(mine.filter((l) => PERSON_RE.test(l.labeler ?? '')));
  if (person) return { label: person, skip: null };
  const workflow = latest(mine.filter((l) => WORKFLOW_RE.test(l.labeler ?? '') && (l.strength === 'weak' || l.strength === 'strong')));
  if (workflow) return { label: workflow, skip: null };
  if (mine.some((l) => /^(agent|user):/.test(l.labeler ?? ''))) return { label: null, skip: 'agent_or_user_labeler' };
  if (mine.length > 0) return { label: null, skip: 'unknown_labeler' };
  return { label: null, skip: 'no_label' };
}

export function toRow(l: ApiLabel, judgeId: string, b: ReviewBatchRow): CalibrationLabelRow {
  const person = PERSON_RE.test(l.labeler ?? '');
  const row: CalibrationLabelRow = {
    schema: CALIBRATION_LABEL_FORMAT,
    judge_id: judgeId,
    run_id: l.runId,
    case_key: b.case_key,
    task_id: b.task_ref.id,
    label: l.pass ? 'pass' : 'fail',
    labeler: l.labeler!,
    // A person label is strong; a workflow label keeps the strength the API gives its signal.
    strength: person ? 'strong' : (l.strength as 'strong' | 'weak'),
    reason_code: reasonCodeOf(l.reasonCode),
  };
  const model = runModelId(b);
  if (model) row.run_model_id = model;
  return row;
}

/** The waits after a 429 (seconds); one rate window of the API in all. */
export const RATE_LIMIT_WAITS_S = [60, 120, 240, 480] as const;

const canonical = (row: CalibrationLabelRow) => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1))));

export async function judgeLabelsMain(argv: string[], io: Io, deps: { env?: NodeJS.ProcessEnv; fetchImpl?: Fetch; now?: () => Date; sleep?: (ms: number) => Promise<void> }): Promise<number> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const a = parseArgs(argv, { judge: {}, batch: { repeat: true }, out: {} });
  const judgeId = flag(a, 'judge');
  if (!judgeId) throw new CliError(`give --judge\n${JUDGE_LABELS_USAGE}`);
  if (!JUDGE_RE.test(judgeId)) throw new CliError(`bad judge id: ${judgeId.slice(0, 64)}`);
  const files = flagList(a, 'batch');
  if (files.length === 0) throw new CliError(`give --batch\n${JUDGE_LABELS_USAGE}`);
  const byCase = new Map<string, ReviewBatchRow>();
  for (const f of files) {
    const text = await readFile(resolve(f), 'utf-8').catch(() => null);
    if (text === null) throw new CliError(`cannot read ${f}`);
    for (const r of parseReviewBatch(text, f)) if (!byCase.has(r.case_key)) byCase.set(r.case_key, r);
  }

  const env = deps.env ?? process.env;
  const base = apiUrl(env);
  const token = requireSession(base, (deps.now ?? (() => new Date()))().getTime(), env).session_token;
  const get = async (path: string) => {
    for (let i = 0; ; i++) {
      const r = await apiCall(base, path, { token, fetchImpl: deps.fetchImpl });
      if (r.status !== 429 || i >= RATE_LIMIT_WAITS_S.length) return r;
      io.err(`rate limited (HTTP 429): waiting ${RATE_LIMIT_WAITS_S[i]} s`);
      await sleep(RATE_LIMIT_WAITS_S[i]! * 1000);
    }
  };
  const rows: CalibrationLabelRow[] = [];
  const skips = new Map<string, number>();
  const skip = (k: string) => skips.set(k, (skips.get(k) ?? 0) + 1);
  for (const [caseKey, b] of byCase) {
    const r = await get(`/review-queue/runs?case_key=${encodeURIComponent(caseKey)}`);
    const runs = r.status === 200 && Array.isArray(r.body?.runs) ? (r.body!.runs as Array<{ run_id?: unknown }>) : null;
    if (!runs) throw new CliError(`${caseKey}: run lookup refused: ${describeRefusal(r)}; nothing is written`);
    if (runs.length === 0) {
      skip('not_uploaded');
      continue;
    }
    for (const run of runs) {
      if (typeof run.run_id !== 'string' || !RUN_ID_RE.test(run.run_id)) throw new CliError(`${caseKey}: the API gave a bad run id; nothing is written`);
      const l = await get(`/grader-results/human?run_id=${encodeURIComponent(run.run_id)}`);
      const labels = l.status === 200 && Array.isArray(l.body?.labels) ? (l.body!.labels as ApiLabel[]) : null;
      if (!labels) throw new CliError(`${caseKey}: label read refused: ${describeRefusal(l)}; nothing is written`);
      const c = chooseLabel(labels.filter((x) => x.runId === run.run_id), judgeId);
      if (c.label) rows.push(toRow(c.label, judgeId, b));
      else skip(c.skip!);
    }
  }
  rows.sort((x, y) => (x.task_id + x.run_id < y.task_id + y.run_id ? -1 : 1));
  const out = flag(a, 'out');
  if (out) await writeFile(resolve(out), rows.length ? `${rows.map(canonical).join('\n')}\n` : '', { mode: 0o600 });
  const count = (s: string, lab: string) => rows.filter((x) => x.strength === s && x.label === lab).length;
  io.out(`judge labels ${judgeId}: ${byCase.size} case(s), ${rows.length} labeled run(s): strong pass ${count('strong', 'pass')}, strong fail ${count('strong', 'fail')}, weak pass ${count('weak', 'pass')}, weak fail ${count('weak', 'fail')}`);
  if (skips.size > 0) io.out(`  without a row: ${[...skips.entries()].sort().map(([k, n]) => `${k} ${n}`).join(', ')}`);
  if (out) io.out(`written to ${resolve(out)}`);
  return 0;
}

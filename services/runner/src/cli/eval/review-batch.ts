// `tma eval review-batch` (plan 20261112-tma-c6-judge-calibration, task C6-UPLOAD): many RECORDED sessions become
// review runs in one command. Each row of a batch file (tma-review-batch/1, JSONL) names one pinned session; the
// command uploads it as ONE run of the baseline variant "recorded session" on its own trace_review case, the same
// body that `tma eval upload --mode trace_review` sends for one case folder (assembleRecordedBody).
//
//   no grade    a batch run is not graded yet: graders [], infra_ok false, status invalid, score 0. The API stores it
//               as infra_error, so a model comparison never counts it. A judge result or a human label is added later
//               to the same run (POST /grader-results/human, or a graded re-upload of the same case).
//   task        a recorded fleet task has no task bundle. Its task ref is local: a slug of the task id and three
//               digests of fixed names (tma-recorded-task/1), so every session of one task shares one task row.
//   case        one trace_review case per row. Its manifest (tma-case/1, built in memory, never uploaded) names the pin,
//               the task and the judges of --judge; manifest_sha256 is the digest of its canonical JSON.
//   idempotent  the body of a row depends only on the row, the session file and the flags: a second run of the same
//               batch answers `unchanged` for every row, and the API keeps one run per (case, variant, item, repeat).
//   text        the session text, the prompt, the tool arguments and results stay on the host (Q-T9 = A): only the
//               redacted structural trajectory leaves. A row's task_summary is sent only with --with-summary.
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { validatePin, type AgentVersion, type Trajectory } from '@itera/contracts';
import { CliError } from '../env.js';
import type { TaskRef } from '../tasks.js';
import { caseErrors, sha256, type CaseManifest } from './case.js';
import { assembleRecordedBody, claudeCodeSessionFacts, CLAUDE_CODE_HARNESS, LABEL_CHARSET, RECORDED_SESSION_LABEL } from './trace-review.js';
import { readClaudeCodeSession } from './trajectory.js';
import type { RedactContext } from './redact.js';
import { baseAgentFrom, catalogModelId } from './upload.js';
import { canonicalJson } from './variant.js';
import type { LocalResultV2Plus } from '@itera/contracts';

export const REVIEW_BATCH_FORMAT = 'tma-review-batch/1';
/** The prefix of the fixed names behind the digests of a recorded task. */
export const RECORDED_TASK_DIGEST = 'tma-recorded-task/1';
export const REVIEW_BATCH_MAX_ROWS = 500;

const ROW_KEYS = ['schema', 'case_key', 'use_case', 'task_ref', 'task_label', 'pin', 'session_file', 'task_summary'];
const CASE_KEY = /^[a-z0-9][a-z0-9_-]{2,62}$/;
const USE_CASE = /^[a-z0-9][a-z0-9-]{0,30}\/[a-z0-9][a-z0-9-]{0,30}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TASK_LABEL = /^[A-Za-z0-9._-]{1,40}$/;
const JUDGE = /^([a-z0-9][a-z0-9-]{1,63})@((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface ReviewBatchRow {
  case_key: string;
  use_case: string;
  task_ref: { kind: 'dfl-task' | 'tma-task'; id: string };
  task_label: string | null;
  pin: { pin_sha256: string; record: Record<string, unknown> };
  session_file: string;
  task_summary: { before: string; expected: string } | null;
}

export interface JudgeRef {
  id: string;
  version: string;
}

/** Parse --judge <id>@<semver>. */
export function parseJudge(value: string): JudgeRef {
  const m = JUDGE.exec(value);
  if (!m) throw new CliError(`--judge ${value}: give <judge id>@<semver>, for example async-wait-lifecycle@0.1.0`);
  return { id: m[1]!, version: m[2]! };
}

/** Validate one batch row. Closed keys: a row holds pointers, digests and an optional short summary. */
export function readReviewBatchRow(value: unknown, where: string): ReviewBatchRow {
  if (!isObject(value)) throw new CliError(`${where}: a row is a JSON object`);
  const errors: string[] = [];
  for (const k of Object.keys(value)) if (!ROW_KEYS.includes(k)) errors.push(`${k}: unknown key`);
  const v = value;
  if (v.schema !== REVIEW_BATCH_FORMAT) errors.push(`schema: must be ${REVIEW_BATCH_FORMAT}`);
  if (typeof v.case_key !== 'string' || !CASE_KEY.test(v.case_key)) errors.push('case_key: lowercase letters, digits, _ and -, 3 to 63 characters');
  if (typeof v.use_case !== 'string' || !USE_CASE.test(v.use_case)) errors.push('use_case: the L1 pair <type>/<subtype>');
  const t = v.task_ref;
  if (!isObject(t) || (t.kind !== 'dfl-task' && t.kind !== 'tma-task') || typeof t.id !== 'string' || t.id.length < 3 || t.id.length > 120 || Object.keys(t).some((k) => k !== 'kind' && k !== 'id')) {
    errors.push('task_ref: {kind: dfl-task | tma-task, id: 3 to 120 characters}');
  }
  if (v.task_label !== undefined && v.task_label !== null && (typeof v.task_label !== 'string' || !TASK_LABEL.test(v.task_label))) errors.push('task_label: 1 to 40 of A-Z a-z 0-9 . _ -');
  const p = v.pin;
  if (!isObject(p) || typeof p.pin_sha256 !== 'string' || !isObject(p.record) || Object.keys(p).some((k) => k !== 'pin_sha256' && k !== 'record')) {
    errors.push('pin: {pin_sha256, record} with a tma-pin/1 record');
  } else {
    const checked = validatePin(p.record);
    if (!checked.ok) errors.push(`pin: not a valid tma-pin/1 record: ${checked.errors.slice(0, 3).join('; ')}`);
    else if (checked.value.pin_sha256 !== p.pin_sha256) errors.push('pin: pin_sha256 does not match the record');
    else if (checked.value.harness !== CLAUDE_CODE_HARNESS) errors.push(`pin: harness ${String(checked.value.harness)}; the batch reads Claude Code sessions only`);
  }
  if (typeof v.session_file !== 'string' || !isAbsolute(v.session_file)) errors.push('session_file: an absolute path on this host');
  const s = v.task_summary;
  if (s !== undefined && s !== null && (!isObject(s) || typeof s.before !== 'string' || typeof s.expected !== 'string' || Object.keys(s).some((k) => k !== 'before' && k !== 'expected'))) {
    errors.push('task_summary: {before, expected} or null');
  }
  if (errors.length > 0) throw new CliError(`${where} is not a valid ${REVIEW_BATCH_FORMAT} row:\n  ${errors.join('\n  ')}`);
  return {
    case_key: v.case_key as string,
    use_case: v.use_case as string,
    task_ref: { kind: (t as Record<string, unknown>).kind as 'dfl-task' | 'tma-task', id: (t as Record<string, unknown>).id as string },
    task_label: (v.task_label as string | null | undefined) ?? null,
    pin: { pin_sha256: (p as Record<string, unknown>).pin_sha256 as string, record: (p as Record<string, unknown>).record as Record<string, unknown> },
    session_file: v.session_file as string,
    task_summary: (s as { before: string; expected: string } | null | undefined) ?? null,
  };
}

/** Read a batch file: one row per non-empty line. Refuses a repeated case_key (one case per session). */
export function parseReviewBatch(text: string, source: string): ReviewBatchRow[] {
  const rows: ReviewBatchRow[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new CliError(`${source}:${i + 1} is not JSON`);
    }
    const row = readReviewBatchRow(value, `${source}:${i + 1}`);
    if (seen.has(row.case_key)) throw new CliError(`${source}:${i + 1}: case_key ${row.case_key} repeats an earlier row`);
    seen.add(row.case_key);
    rows.push(row);
  });
  if (rows.length === 0) throw new CliError(`${source} has no row`);
  if (rows.length > REVIEW_BATCH_MAX_ROWS) throw new CliError(`${source} has ${rows.length} rows; one batch takes at most ${REVIEW_BATCH_MAX_ROWS}`);
  return rows;
}

/** The local task ref of a recorded task and its item digest. Digests of fixed names: no content is read. */
export function recordedTaskRef(row: ReviewBatchRow): { task: TaskRef; itemSha256: string } {
  const pin = row.pin.record;
  const id = row.task_ref.id.toLowerCase();
  const slugFromId = `${row.task_ref.kind === 'dfl-task' ? 'dfl-task' : 'tma-task'}-${id.replace(/[^a-z0-9-]/g, '-')}`.slice(0, 63);
  const slug = SLUG.test(slugFromId) ? slugFromId : `task-${sha256(row.task_ref.id).slice(0, 16)}`;
  const name = `Recorded task ${row.task_label ?? row.task_ref.id.slice(0, 8)}`.slice(0, 60);
  const d = (part: string) => sha256(`${RECORDED_TASK_DIGEST}\n${part}`);
  const contract = d(`contract\n${row.task_ref.kind}:${row.task_ref.id}`);
  const environment = d(`environment\n${String(pin.repo ?? '')}@${String(pin.base_sha ?? '')}`);
  const hidden = d('hidden-tests\nnone');
  return {
    task: { local: { slug, name: LABEL_CHARSET.test(name) ? name : `Recorded task ${slug.slice(0, 40)}`, contract_sha256: contract, environment_sha256: environment, hidden_tests_sha256: hidden } } as TaskRef,
    itemSha256: sha256(`tma-recorded-item/1\n${contract}\n${environment}\n${hidden}`),
  };
}

/** The tma-case/1 manifest of a batch row (host only; its digest is the case manifest_sha256). */
export function reviewCaseManifest(row: ReviewBatchRow, judges: JudgeRef[], writtenAt: string): CaseManifest {
  const m: CaseManifest = {
    schema: 'tma-case/1',
    case_key: row.case_key,
    use_case: row.use_case,
    mode: 'trace_review',
    answer_shape: 'open',
    pin: { pin_sha256: row.pin.pin_sha256, record: row.pin.record },
    task_ref: row.task_ref,
    expected: { text: 'A recorded session for judge review. The judges of this case grade it; a person labels it on the review screen.', written_by: 'tma eval review-batch', written_at: writtenAt },
    graders: judges.map((j) => ({ id: j.id, version: j.version, weight: 1, hard_gate: false })),
    split: 'none',
    source: 'trace',
  };
  const errors = caseErrors(m);
  if (errors.length > 0) throw new CliError(`case ${row.case_key}: the manifest is not valid tma-case/1:\n  ${errors.slice(0, 6).join('\n  ')}`);
  return m;
}

/** The task summary as the contract takes it, or null (absent, too long, or outside the upload charset). */
function contractSummary(s: ReviewBatchRow['task_summary']): { before: string; expected: string } | null {
  if (!s) return null;
  const fits = (t: string) => t.length >= 1 && t.length <= 280 && LABEL_CHARSET.test(t);
  return fits(s.before) && fits(s.expected) ? { before: s.before, expected: s.expected } : null;
}

export interface ReviewBatchOptions {
  agentId: string;
  judges: JudgeRef[];
  redact?: RedactContext;
  /** Send each row's task_summary (default: it stays on this host). */
  withSummary?: boolean;
}

/** Build the upload body of ONE batch row from its session file. */
export async function buildReviewBatchBody(row: ReviewBatchRow, o: ReviewBatchOptions): Promise<{ body: LocalResultV2Plus; notes: string[]; trajectory: Trajectory }> {
  if (o.judges.length === 0) throw new CliError('give at least one --judge <id>@<semver>');
  const notes: string[] = [];
  const text = await readFile(row.session_file, 'utf-8').catch(() => null);
  if (text === null) throw new CliError(`case ${row.case_key}: cannot read the session file`);
  const session = claudeCodeSessionFacts(text);
  const { trajectory } = readClaudeCodeSession(text, { redact: o.redact, v2: true });
  if (trajectory.steps.length === 0) throw new CliError(`case ${row.case_key}: the session has no tool step`);
  const record = { ...row.pin.record };
  if (record.model_id === null || record.model_id === undefined) {
    if (!session.model) throw new CliError(`case ${row.case_key}: the pin and the session name no model`);
    record.model_id = catalogModelId(session.model);
    notes.push(`case ${row.case_key}: the pin has no model; the session names ${record.model_id}`);
  }
  const base: AgentVersion = baseAgentFrom(record, `the pin of case ${row.case_key}`);
  const writtenAt = new Date(session.firstMs ?? Date.parse('1970-01-01T00:00:00Z')).toISOString();
  const manifest = reviewCaseManifest(row, o.judges, writtenAt);
  const { task, itemSha256 } = recordedTaskRef(row);
  const summary = o.withSummary ? contractSummary(row.task_summary) : null;
  if (o.withSummary && row.task_summary && !summary) notes.push(`case ${row.case_key}: the task summary has a character outside the upload charset or is too long: it stays on this host`);
  const body = assembleRecordedBody({
    agentId: o.agentId,
    task,
    itemSha256,
    base,
    session,
    trajectory,
    // Not graded yet: the run measured nothing, so no comparison counts it.
    status: 'invalid',
    score: 0,
    manifest: null,
    infraOk: false,
    graders: [],
    fallbackMs: Date.parse('1970-01-01T00:00:00Z'),
    sandboxImageId: null,
    caseRef: { case_key: row.case_key, manifest_sha256: sha256(canonicalJson(manifest)), origin_pin_sha256: row.pin.pin_sha256, mode: 'trace_review', use_case_key: row.use_case },
    summary,
    variantLabel: RECORDED_SESSION_LABEL,
  });
  return { body, notes, trajectory };
}

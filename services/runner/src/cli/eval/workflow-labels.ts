// `tma eval workflow-labels` (plan 20261112-tma-c6-judge-calibration, task C6-T2): weak WORKFLOW labels on the review
// runs of a batch. Q-C6-T2 = A (Tainan, 2026-11-16): workflow signals do not separate the two judge modes, so this
// command writes weak PASS labels only. Strong labels (the test split of T4) come from a person in S13.
//
//   input     the batch file of `tma eval review-batch` (tma-review-batch/1: case key, L1 pair, task, session file) and
//             one or more trace-select candidate files (tma-trace-select/1) that hold the outcome signals of each
//             declared run. A row joins its candidate by (task id, session id, agent id); the session and agent ids come
//             from the Claude Code session path. A later --signals file wins for the same run. Only ids, flags and the
//             PR outcome are read: the task_summary of a candidate is never read.
//   rule      clean-merge (weak pass): pr_outcome merged_green, and every red signal of the run is KNOWN false
//             (revert, red_ci, rerun_task, ci_rerun, correction). A null signal was not measured, so it is not clean:
//             the row gets no label. Nothing else gives a label; there is no fail rule.
//   write     per labeled row and per --judge: GET /review-queue/runs?case_key= finds the run, then POST
//             /grader-results/human {run_id, judge_id, pass: true, reason_code: "other", workflow_signal}. The API
//             stores labeler workflow:<signal> (agent login only) and answers `unchanged` for a label it already holds.
//             reason_code is "other": the closed set of migration 0024 holds failure reasons only, and the signal is in
//             the labeler.
//   output    one line of counts per judge, signal and L1 pair, the skip reasons, and with --out a decisions file
//             (JSONL: ids, the L1 pair, the signals and the decision; no text) for the jq check of the plan.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { apiCall, describeRefusal, type Fetch } from '../api.js';
import { flag, flagList, has, parseArgs } from '../args.js';
import type { Io } from '../command.js';
import { apiUrl, CliError } from '../env.js';
import { requireSession } from '../session.js';
import { parseReviewBatch, type ReviewBatchRow } from './review-batch.js';

export const TRACE_SELECT_FORMAT = 'tma-trace-select/1';
export const WORKFLOW_DECISIONS_FORMAT = 'tma-workflow-label-decision/1';
/** The judges a label may name (the API refuses any other id). */
export const WORKFLOW_LABEL_JUDGES = ['async-wait-lifecycle', 'external-block-handling'] as const;
export const CLEAN_MERGE = 'clean-merge';
export const WORKFLOW_REASON_CODE = 'other';
/** The red signals of a trace-select row. Every one must be KNOWN false for a clean-merge label. */
export const RED_SIGNALS = ['revert', 'red_ci', 'rerun_task', 'ci_rerun', 'correction'] as const;
type RedSignal = (typeof RED_SIGNALS)[number];

const SESSION_PATH = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/subagents\/agent-([A-Za-z0-9]+))?\.jsonl$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface CandidateSignals {
  task_id: string;
  session_id: string;
  agent_id: string | null;
  pr_outcome: string | null;
  signals: Record<RedSignal, boolean | null>;
}

const keyOf = (task: string, session: string, agent: string | null) => `${task.toLowerCase()}|${session.toLowerCase()}|${(agent ?? '').toLowerCase()}`;

/** Read trace-select candidate rows into a map by run. Reads only ids, the PR outcome and the red signals. */
export function parseCandidates(text: string, source: string, into: Map<string, CandidateSignals> = new Map()): Map<string, CandidateSignals> {
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      throw new CliError(`${source}:${i + 1} is not JSON`);
    }
    if (!isObject(v) || v.schema !== TRACE_SELECT_FORMAT) throw new CliError(`${source}:${i + 1}: not a ${TRACE_SELECT_FORMAT} row`);
    if (typeof v.task_id !== 'string' || typeof v.session_id !== 'string') throw new CliError(`${source}:${i + 1}: task_id and session_id are strings`);
    if (v.agent_id !== null && v.agent_id !== undefined && typeof v.agent_id !== 'string') throw new CliError(`${source}:${i + 1}: agent_id is a string or null`);
    const s = isObject(v.signals) ? v.signals : {};
    const signals = Object.fromEntries(RED_SIGNALS.map((k) => [k, typeof s[k] === 'boolean' ? (s[k] as boolean) : null])) as Record<RedSignal, boolean | null>;
    const agent = typeof v.agent_id === 'string' ? v.agent_id : null;
    into.set(keyOf(v.task_id, v.session_id, agent), {
      task_id: v.task_id, session_id: v.session_id, agent_id: agent, pr_outcome: typeof v.pr_outcome === 'string' ? v.pr_outcome : null, signals,
    });
  });
  return into;
}

/** The session id and the sub-agent id of a Claude Code session file, or null for another layout. */
export function sessionOf(sessionFile: string): { session_id: string; agent_id: string | null } | null {
  const m = SESSION_PATH.exec(sessionFile);
  return m ? { session_id: m[1]!, agent_id: m[2] ?? null } : null;
}

export type WorkflowDecision = { label: 'pass'; signal: typeof CLEAN_MERGE; strength: 'weak' } | { label: null; skip: string[] };

/** The weak-pass rule. Fail closed: an unknown signal or another PR outcome gives no label. */
export function workflowDecision(c: CandidateSignals): WorkflowDecision {
  const skip: string[] = [];
  if (c.pr_outcome !== 'merged_green') skip.push(`pr_outcome:${c.pr_outcome ?? 'null'}`);
  for (const k of RED_SIGNALS) {
    if (c.signals[k] === true) skip.push(`${k}:true`);
    else if (c.signals[k] !== false) skip.push(`${k}:unknown`);
  }
  return skip.length === 0 ? { label: 'pass', signal: CLEAN_MERGE, strength: 'weak' } : { label: null, skip };
}

export interface RowDecision {
  schema: typeof WORKFLOW_DECISIONS_FORMAT;
  case_key: string;
  use_case: string;
  task_id: string;
  session_id: string | null;
  agent_id: string | null;
  pr_outcome: string | null;
  signals: Record<RedSignal, boolean | null> | null;
  label: 'pass' | null;
  labeler: string | null;
  strength: 'weak' | null;
  skip: string[];
}

/** One decision per batch row. A row with no Claude Code session path or no candidate is skipped, never labeled. */
export function decideRows(rows: ReviewBatchRow[], candidates: Map<string, CandidateSignals>): RowDecision[] {
  return rows.map((row) => {
    const base = { schema: WORKFLOW_DECISIONS_FORMAT, case_key: row.case_key, use_case: row.use_case, task_id: row.task_ref.id } as const;
    const s = sessionOf(row.session_file);
    if (!s) return { ...base, session_id: null, agent_id: null, pr_outcome: null, signals: null, label: null, labeler: null, strength: null, skip: ['session_not_named'] };
    const c = candidates.get(keyOf(row.task_ref.id, s.session_id, s.agent_id));
    if (!c) return { ...base, ...s, pr_outcome: null, signals: null, label: null, labeler: null, strength: null, skip: ['no_candidate'] };
    const d = workflowDecision(c);
    return d.label === 'pass'
      ? { ...base, ...s, pr_outcome: c.pr_outcome, signals: c.signals, label: 'pass', labeler: `workflow:${d.signal}`, strength: d.strength, skip: [] }
      : { ...base, ...s, pr_outcome: c.pr_outcome, signals: c.signals, label: null, labeler: null, strength: null, skip: d.skip };
  });
}

export const WORKFLOW_LABELS_USAGE = `usage: tma eval workflow-labels --batch <rows.jsonl> --signals <candidates.jsonl> [--signals ...]
                                --judge <id> [--judge ...] [--out <decisions.jsonl>] [--dry-run]
  Writes weak WORKFLOW pass labels (C6-T2, Q-C6-T2 = A) on the review runs of a review-batch file, through
  POST /grader-results/human with an agent login. Rule clean-merge: the delivering PR merged with green CI and every
  red signal of the run (revert, red_ci, rerun_task, ci_rerun, correction) is known false. Any other row gets no label.
  --signals  a trace-select candidates file (${TRACE_SELECT_FORMAT}); a later file wins for the same run
  --judge    a judge id (${WORKFLOW_LABEL_JUDGES.join(', ')}); each labeled run gets one label per judge
  --out      write one decision per row (ids, L1 pair, signals, decision; no text), file mode 600
  --dry-run  print the decisions and counts; no network call
  Idempotent: the API answers unchanged for a label it already holds.`;

export interface WorkflowLabelsDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: Fetch;
  now?: () => Date;
}

export async function workflowLabelsMain(argv: string[], io: Io, deps: WorkflowLabelsDeps = {}): Promise<number> {
  const a = parseArgs(argv, { batch: {}, signals: { repeat: true }, judge: { repeat: true }, out: {}, 'dry-run': { boolean: true } });
  const file = flag(a, 'batch');
  if (!file) throw new CliError(WORKFLOW_LABELS_USAGE);
  const signalFiles = flagList(a, 'signals');
  if (signalFiles.length === 0) throw new CliError(`give at least one --signals <candidates.jsonl>\n${WORKFLOW_LABELS_USAGE}`);
  const judges = flagList(a, 'judge');
  if (judges.length === 0) throw new CliError(`give at least one --judge <id>\n${WORKFLOW_LABELS_USAGE}`);
  for (const j of judges) if (!(WORKFLOW_LABEL_JUDGES as readonly string[]).includes(j)) throw new CliError(`--judge ${j}: one of ${WORKFLOW_LABEL_JUDGES.join(', ')}`);
  if (new Set(judges).size !== judges.length) throw new CliError('--judge repeats a judge');

  const text = await readFile(resolve(file), 'utf-8').catch(() => null);
  if (text === null) throw new CliError(`cannot read ${file}`);
  const rows = parseReviewBatch(text, file);
  const candidates = new Map<string, CandidateSignals>();
  for (const f of signalFiles) {
    const t = await readFile(resolve(f), 'utf-8').catch(() => null);
    if (t === null) throw new CliError(`cannot read ${f}`);
    parseCandidates(t, f, candidates);
  }
  const decisions = decideRows(rows, candidates);
  const out = flag(a, 'out');
  if (out) await writeFile(resolve(out), decisions.map((d) => JSON.stringify(d)).join('\n') + '\n', { mode: 0o600 });

  const skips = new Map<string, number>();
  for (const d of decisions) for (const s of d.skip) skips.set(s, (skips.get(s) ?? 0) + 1);
  const labeled = decisions.filter((d) => d.label === 'pass');
  io.out(`workflow-labels: ${rows.length} row(s), ${labeled.length} weak pass (${CLEAN_MERGE}), ${rows.length - labeled.length} without a label`);
  if (skips.size > 0) io.out(`  skip reasons (a row may have several): ${[...skips.entries()].sort().map(([k, n]) => `${k} ${n}`).join(', ')}`);

  const dryRun = has(a, 'dry-run');
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  let failed = 0;
  if (!dryRun && labeled.length > 0) {
    const env = deps.env ?? process.env;
    const base = apiUrl(env);
    const token = requireSession(base, (deps.now ?? (() => new Date()))().getTime(), env).session_token;
    for (const d of labeled) {
      const r = await apiCall(base, `/review-queue/runs?case_key=${encodeURIComponent(d.case_key)}`, { token, fetchImpl: deps.fetchImpl });
      const runs = r.status === 200 && Array.isArray(r.body?.runs) ? (r.body!.runs as Array<{ run_id?: unknown }>) : null;
      if (!runs) {
        io.err(`${d.case_key}: run lookup refused: ${describeRefusal(r)}`);
        failed += 1;
        continue;
      }
      if (runs.length === 0) {
        io.err(`${d.case_key}: no review run of this case (upload it with tma eval review-batch first)`);
        failed += 1;
        continue;
      }
      for (const run of runs) {
        for (const judge of judges) {
          const w = await apiCall(base, '/grader-results/human', {
            method: 'POST', token, fetchImpl: deps.fetchImpl,
            body: { run_id: run.run_id, judge_id: judge, pass: true, reason_code: WORKFLOW_REASON_CODE, workflow_signal: CLEAN_MERGE },
          });
          if (w.status === 201 || w.status === 200) bump(`${judge} ${CLEAN_MERGE} ${d.use_case} ${w.body?.unchanged === true ? 'unchanged' : 'created'}`);
          else {
            io.err(`${d.case_key} / ${judge}: refused: ${describeRefusal(w)}`);
            failed += 1;
          }
        }
      }
    }
  } else if (dryRun) {
    for (const d of labeled) for (const judge of judges) bump(`${judge} ${CLEAN_MERGE} ${d.use_case} would-write`);
  }
  for (const [k, n] of [...counts.entries()].sort()) io.out(`  ${k} ${n}`);
  const per = new Map<string, number>();
  for (const [k, n] of counts) {
    const [judge, , , state] = k.split(' ');
    per.set(`${judge} ${state}`, (per.get(`${judge} ${state}`) ?? 0) + n);
  }
  io.out(`labels${dryRun ? ' (dry run)' : ''}: ${[...per.entries()].sort().map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}${failed ? `, refused ${failed}` : ''}`);
  return failed === 0 ? 0 : 1;
}

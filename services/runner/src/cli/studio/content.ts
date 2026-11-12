// Read-only content of `tma studio serve` for the studio screens S2 (trace picker) and S3 (trace view)
// (plan 20261112-tma-c5-studio-area-web2, ADR-4, task C5-T11).
//
// Three sources on the content host, all read, never written:
//   - the trace-select output (C2): `candidates-<day>.jsonl` (one row per candidate trace, with its
//     signals and, once C2-T6 lands, its `task_summary`) and `pins-<day>.index.jsonl` (pin status);
//   - the trace index (C1-T3): a SQLite file, opened read-only, that maps a session to its layer-1 file;
//   - the layer-1 trajectory files of `session-trajectory` (one JSONL per session: a `session_tree` row,
//     then one `run` row per main or subagent run, each with its `spans`).
// A layer-1 path from the index is served only when its real path is inside the trajectory root.
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

export interface StudioSources {
  /** The trace index SQLite file (C1-T3). */
  indexPath: string;
  /** The trace-select output folder (C2). */
  selectDir: string;
  /** The root of the layer-1 trajectory files. */
  trajectoryRoot: string;
}

export class NotFound extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** The task summary of parent ADR-27: max 280 characters per field (Q-T16 = A). */
export interface TaskSummary {
  before: string | null;
  expected: string | null;
  outcome: string | null;
}

export const SUMMARY_MAX = 280;
/** A layer-1 file larger than this is refused (one request at a time, in memory). */
export const MAX_TRAJECTORY_BYTES = 64 * 1024 * 1024;
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const CANDIDATES_FILE = /^candidates-(\d{4}-\d{2}-\d{2})\.jsonl$/;

type Row = Record<string, unknown>;

function readJsonl(path: string): Row[] {
  const rows: Row[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const value = JSON.parse(line) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) rows.push(value as Row);
  }
  return rows;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : null);

function clip(v: unknown): string | null {
  const s = str(v);
  return s === null ? null : s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) : s;
}

export function taskSummary(v: unknown): TaskSummary | null {
  const o = obj(v);
  if (!o) return null;
  return { before: clip(o.before), expected: clip(o.expected), outcome: clip(o.outcome) };
}

/** The newest `candidates-<day>.jsonl` in the trace-select folder, with its pins index when present. */
export function latestSelection(selectDir: string): { day: string; candidates: string; pinsIndex: string | null } {
  let names: string[];
  try {
    names = readdirSync(selectDir);
  } catch {
    throw new NotFound('no_trace_selection');
  }
  const days = names.map((n) => CANDIDATES_FILE.exec(n)?.[1]).filter((d): d is string => !!d).sort();
  const day = days.at(-1);
  if (!day) throw new NotFound('no_trace_selection');
  const pins = `pins-${day}.index.jsonl`;
  return { day, candidates: join(selectDir, `candidates-${day}.jsonl`), pinsIndex: names.includes(pins) ? join(selectDir, pins) : null };
}

const key = (sessionId: unknown, agentId: unknown) => `${str(sessionId) ?? ''}\u0000${str(agentId) ?? ''}`;

export interface PinStatus {
  pin_sha256: string | null;
  complete: boolean | null;
  missing: string[];
  layer1: boolean | null;
}

function pinStatuses(pinsIndex: string | null): Map<string, PinStatus> {
  const out = new Map<string, PinStatus>();
  if (!pinsIndex) return out;
  for (const r of readJsonl(pinsIndex)) {
    out.set(key(r.session_id, r.agent_id), {
      pin_sha256: str(r.pin_sha256),
      complete: bool(r.complete),
      missing: Array.isArray(r.missing) ? r.missing.filter((m): m is string => typeof m === 'string') : [],
      layer1: bool(r.layer1),
    });
  }
  return out;
}

/** One candidate row as S2 shows it. Fields are copied by name: an unknown field of the source is not served. */
export function candidateView(r: Row, pin: PinStatus | null, hasTrajectory: boolean) {
  const signals = obj(r.signals);
  return {
    session_id: str(r.session_id),
    agent_id: str(r.agent_id),
    parent_session_id: str(r.parent_session_id),
    run_kind: str(r.run_kind),
    identifier: str(r.identifier),
    task_id: str(r.task_id),
    executor: str(r.executor),
    harness: str(r.harness),
    host: str(r.host),
    model: str(r.model),
    l2_class: str(r.l2_class),
    mode: str(r.mode),
    why: str(r.why),
    red: bool(r.red),
    replayable: bool(r.replayable),
    pr: r.pr ?? null,
    n_delivering_prs: num(r.n_delivering_prs),
    started_at: str(r.started_at),
    signals: signals
      ? Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, typeof v === 'boolean' || v === null ? v : null]))
      : null,
    task_summary: taskSummary(r.task_summary),
    pin,
    has_trajectory: hasTrajectory,
  };
}

// --- the trace index (node:sqlite, read-only) -------------------------------------------------------

interface SqliteDb {
  prepare(sql: string): { all(...params: unknown[]): Row[]; get(...params: unknown[]): Row | undefined };
  close(): void;
}

/** node:sqlite is loaded on first use, so a build or a test that never opens the index never needs it. */
function openReadOnly(path: string): SqliteDb {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string, o: { readOnly: boolean }) => SqliteDb };
  try {
    statSync(path);
  } catch {
    throw new NotFound('no_trace_index');
  }
  return new DatabaseSync(path, { readOnly: true });
}

export interface IndexRow {
  host: string | null;
  harness: string | null;
  kind: string | null;
  first_ts: string | null;
  last_ts: string | null;
  message_count: number | null;
  models: string[];
  state: string | null;
  trajectory_ref: string | null;
}

function indexRow(r: Row): IndexRow {
  let models: string[] = [];
  try {
    const parsed = JSON.parse(str(r.models) ?? '[]') as unknown;
    if (Array.isArray(parsed)) models = parsed.filter((m): m is string => typeof m === 'string');
  } catch {
    models = [];
  }
  return {
    host: str(r.host),
    harness: str(r.harness),
    kind: str(r.kind),
    first_ts: str(r.first_ts),
    last_ts: str(r.last_ts),
    message_count: num(r.message_count),
    models,
    state: str(r.state),
    trajectory_ref: str(r.trajectory_ref),
  };
}

const INDEX_COLUMNS = 'host, harness, kind, first_ts, last_ts, message_count, models, state, trajectory_ref';

/** The main-session row of each session id (the one whose agent_id is null), with a layer-1 file first. */
function lookupSessions(indexPath: string, sessionIds: string[]): Map<string, IndexRow> {
  const out = new Map<string, IndexRow>();
  if (sessionIds.length === 0) return out;
  const db = openReadOnly(indexPath);
  try {
    const stmt = db.prepare(
      `SELECT session_id, ${INDEX_COLUMNS} FROM sessions WHERE session_id = ? ` +
        `ORDER BY (trajectory_ref IS NULL), (agent_id IS NOT NULL), last_ts DESC LIMIT 1`,
    );
    for (const sid of new Set(sessionIds)) {
      const r = stmt.get(sid);
      if (r) out.set(sid, indexRow(r));
    }
  } finally {
    db.close();
  }
  return out;
}

/** The layer-1 file of a trajectory_ref, only when it resolves inside the trajectory root. */
export function safeTrajectoryPath(ref: string | null, trajectoryRoot: string): string | null {
  if (!ref || !ref.endsWith('.jsonl')) return null;
  let real: string;
  let root: string;
  try {
    real = realpathSync(ref);
    root = realpathSync(trajectoryRoot);
  } catch {
    return null;
  }
  return real.startsWith(root + sep) ? real : null;
}

// --- S2: the trace list -------------------------------------------------------------------------------

export interface ListQuery {
  limit: number;
  offset: number;
  l2_class?: string;
  why?: string;
  mode?: string;
}

export function listTraces(src: StudioSources, q: ListQuery) {
  const sel = latestSelection(src.selectDir);
  const pins = pinStatuses(sel.pinsIndex);
  const all = readJsonl(sel.candidates).filter(
    (r) =>
      (q.l2_class === undefined || r.l2_class === q.l2_class) && (q.why === undefined || r.why === q.why) && (q.mode === undefined || r.mode === q.mode),
  );
  const page = all.slice(q.offset, q.offset + q.limit);
  const index = lookupSessions(
    src.indexPath,
    page.map((r) => str(r.session_id)).filter((s): s is string => !!s && SESSION_ID.test(s)),
  );
  return {
    source: { selection_day: sel.day, pins: sel.pinsIndex !== null },
    total: all.length,
    offset: q.offset,
    limit: q.limit,
    rows: page.map((r) => {
      const ix = index.get(str(r.session_id) ?? '');
      return candidateView(r, pins.get(key(r.session_id, r.agent_id)) ?? null, !!safeTrajectoryPath(ix?.trajectory_ref ?? null, src.trajectoryRoot));
    }),
  };
}

// --- S3: one trace ------------------------------------------------------------------------------------

function spanView(s: Row) {
  return {
    seq: num(s.seq),
    turn_seq: num(s.turn_seq),
    ts: str(s.ts),
    ts_end: str(s.ts_end),
    dur_ms: num(s.dur_ms),
    tool: str(s.tool),
    shape: str(s.shape),
    intent: str(s.intent),
    family: str(s.family),
    target_kind: str(s.target_kind),
    target: str(s.target),
    ok: bool(s.ok),
    retry_of: s.retry_of ?? null,
    child_run: s.child_run ?? null,
    preview: str(s.preview),
    bytes_out: num(s.bytes_out),
  };
}

function runView(r: Row) {
  const errors = obj(r.errors);
  return {
    agent_id: str(r.agent_id),
    parent_agent_id: str(r.parent_agent_id),
    is_subagent: bool(r.is_subagent),
    spawn_depth: num(r.spawn_depth),
    agent_type: str(r.agent_type),
    description: str(r.description),
    title: str(r.title),
    started_at: str(r.started_at),
    ended_at: str(r.ended_at),
    duration_s: num(r.duration_s),
    models: Array.isArray(r.models) ? r.models.filter((m): m is string => typeof m === 'string') : [],
    n_tool_calls: num(r.n_tool_calls),
    errors: errors ? num(errors.n) : null,
    spans: (Array.isArray(r.spans) ? r.spans : []).map((s) => spanView(obj(s) ?? {})),
  };
}

function summaryView(t: Row) {
  return {
    title: str(t.title),
    started_at: str(t.started_at),
    ended_at: str(t.ended_at),
    duration_s: num(t.duration_s),
    active_s: num(t.active_s),
    channel: str(t.channel),
    models: Array.isArray(t.models) ? t.models.filter((m): m is string => typeof m === 'string') : [],
    n_runs: num(t.n_runs),
    n_subagent_runs: num(t.n_subagent_runs),
    n_tool_calls: num(t.n_tool_calls),
    tool_counts: obj(t.tool_counts),
    intent_counts: obj(t.intent_counts),
    errors: num(t.errors),
    outcome_signals: obj(t.outcome_signals),
    closure_confidence: str(t.closure_confidence),
    cost_usd: num(t.cost_usd),
    extractor_version: str(t.extractor_version),
  };
}

export function getTrace(src: StudioSources, sessionId: string, agentId?: string) {
  if (!SESSION_ID.test(sessionId)) throw new NotFound('bad_session_id');
  if (agentId !== undefined && !AGENT_ID.test(agentId)) throw new NotFound('bad_agent_id');
  const ix = lookupSessions(src.indexPath, [sessionId]).get(sessionId);
  if (!ix) throw new NotFound('session_not_indexed');
  const file = safeTrajectoryPath(ix.trajectory_ref, src.trajectoryRoot);
  if (!file) throw new NotFound('no_trajectory');
  if (statSync(file).size > MAX_TRAJECTORY_BYTES) throw new NotFound('trajectory_too_large');
  const rows = readJsonl(file);
  const tree = rows.find((r) => r.kind === 'session_tree' && r.session_id === sessionId);
  let runs = rows.filter((r) => r.kind === 'run' && r.session_id === sessionId).map(runView);
  if (agentId !== undefined) {
    runs = runs.filter((r) => r.agent_id === agentId);
    if (runs.length === 0) throw new NotFound('agent_not_in_trajectory');
  }

  let candidate = null;
  let pin = null;
  try {
    const sel = latestSelection(src.selectDir);
    const want = key(sessionId, agentId ?? null);
    const row = readJsonl(sel.candidates).find((r) => key(r.session_id, r.agent_id) === want);
    pin = pinStatuses(sel.pinsIndex).get(want) ?? null;
    if (row) candidate = candidateView(row, pin, true);
  } catch (e) {
    if (!(e instanceof NotFound)) throw e;
  }

  // The first failed step, in time order over the runs shown.
  const failures = runs
    .flatMap((r) => r.spans.filter((s) => s.ok === false).map((s) => ({ agent_id: r.agent_id, ...s })))
    .sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
  const { trajectory_ref: _ref, ...indexShown } = ix;
  return {
    session_id: sessionId,
    agent_id: agentId ?? null,
    index: indexShown,
    candidate,
    pin,
    task_summary: candidate?.task_summary ?? null,
    summary: tree ? summaryView(tree) : null,
    runs,
    first_failure: failures[0] ?? null,
  };
}

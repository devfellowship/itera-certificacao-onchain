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
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
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
/**
 * A larger file is read line by line for ONE sub-agent (S13 "Open the full trace" of a review run): only the
 * session_tree row and the run rows of that agent are parsed and kept. The long claude-main sessions are one file of
 * about 160 MB with about 2,400 sub-agent runs (measured 2026-11-18; the longest line 16 MB). Above this size, refused.
 */
export const MAX_FILTERED_TRAJECTORY_BYTES = 1024 * 1024 * 1024;
/** The bytes of a line that the filter reads to decide: the kind and the agent id come first in a layer-1 row. */
const ROW_HEAD_BYTES = 1024;
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const CANDIDATES_FILE = /^candidates-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * MT-20: one trace = one run (the main run or one subagent run) of a session. Its id is short and stable: the first
 * 12 hex characters of sha256("<session_id>\n<agent_id>"), with an empty agent_id for the main run. The studio URL is
 * /studio/traces/<trace_id>; the session id is a column and a filter, not the trace key. apps/web2/src/studio/traces.ts
 * computes the same id (traceIdOf) for the redirect of an old /studio/traces/<session>?agent_id= URL; both test
 * suites pin the same vector.
 */
export const TRACE_ID = /^[0-9a-f]{12}$/;
export function traceId(sessionId: string, agentId: string | null): string {
  return createHash('sha256').update(`${sessionId}\n${agentId ?? ''}`).digest('hex').slice(0, 12);
}

type Row = Record<string, unknown>;

/**
 * The rows of a large layer-1 file whose head (first ROW_HEAD_BYTES) passes `keep`, read in 4 MiB chunks. A line
 * that fails `keep` is never parsed. The kept rows together may hold at most MAX_TRAJECTORY_BYTES.
 */
export function readJsonlFiltered(path: string, keep: (head: string) => boolean): Row[] {
  const rows: Row[] = [];
  const fd = openSync(path, 'r');
  const chunk = Buffer.alloc(4 * 1024 * 1024);
  let parts: Buffer[] = [];
  let kept = 0;
  const flush = () => {
    if (parts.length === 0) return;
    const line = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
    parts = [];
    if (line.length === 0 || !keep(line.subarray(0, ROW_HEAD_BYTES).toString('utf8'))) return;
    kept += line.length;
    if (kept > MAX_TRAJECTORY_BYTES) throw new NotFound('trajectory_too_large');
    const value = JSON.parse(line.toString('utf8')) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) rows.push(value as Row);
  };
  try {
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      let start = 0;
      for (let i = chunk.indexOf(10, 0); i !== -1 && i < n; i = chunk.indexOf(10, start)) {
        parts.push(Buffer.from(chunk.subarray(start, i)));
        flush();
        start = i + 1;
      }
      if (start < n) parts.push(Buffer.from(chunk.subarray(start, n)));
    }
    flush();
  } finally {
    closeSync(fd);
  }
  return rows;
}

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

/** Every selection day in the folder, newest first, each with its pins index when present. */
function selectionDays(selectDir: string): Array<{ day: string; candidates: string; pinsIndex: string | null }> {
  let names: string[];
  try {
    names = readdirSync(selectDir);
  } catch {
    return [];
  }
  return names
    .map((n) => CANDIDATES_FILE.exec(n)?.[1])
    .filter((d): d is string => !!d)
    .sort()
    .reverse()
    .map((day) => ({ day, candidates: join(selectDir, `candidates-${day}.jsonl`), pinsIndex: names.includes(`pins-${day}.index.jsonl`) ? join(selectDir, `pins-${day}.index.jsonl`) : null }));
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
  const sid = str(r.session_id);
  return {
    // MT-20: the key of the trace (one run). session_id stays a column and a filter.
    trace_id: sid ? traceId(sid, str(r.agent_id)) : null,
    session_id: sid,
    agent_id: str(r.agent_id),
    parent_session_id: str(r.parent_session_id),
    run_kind: str(r.run_kind),
    identifier: str(r.identifier),
    task_id: str(r.task_id),
    // MT-12/13: source-agnostic task fields the selection writes (the DFL source fills them from its task row).
    task_name: str(r.task_name),
    external_id: str(r.external_id),
    external_url: str(r.external_url),
    executor: str(r.executor),
    harness: str(r.harness),
    host: str(r.host),
    model: str(r.model),
    l2_class: str(r.l2_class),
    mode: str(r.mode),
    why: str(r.why),
    red: bool(r.red),
    replayable: bool(r.replayable),
    // MT-11: the selection marks a merged PR of at most 3 files; pr.files_changed / additions / deletions ride in pr.
    small_diff: bool(r.small_diff),
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
  /** MT-11: true keeps the rows marked small_diff; false keeps the rows marked not small. A row with no mark matches neither. */
  small_diff?: boolean;
  /** MT-20: only the runs of this session. */
  session_id?: string;
}

/**
 * The run keys (agent_id, '' for the main run) of a layer-1 file, from the runs_index of its first row (the
 * session_tree). Only the first line is read. null = the file has no readable session_tree first line.
 */
const TREE_LINE_MAX = 16 * 1024 * 1024;
export function runKeysOf(file: string): Set<string> | null {
  const fd = openSync(file, 'r');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      const nl = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, nl === -1 ? n : nl)));
      total += nl === -1 ? n : nl;
      if (nl !== -1) break;
      if (total > TREE_LINE_MAX) return null;
    }
  } finally {
    closeSync(fd);
  }
  try {
    const tree = obj(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!tree || tree.kind !== 'session_tree' || !Array.isArray(tree.runs_index)) return null;
    return new Set(tree.runs_index.map((r) => str(obj(r)?.agent_id) ?? ''));
  } catch {
    return null;
  }
}

export function listTraces(src: StudioSources, q: ListQuery) {
  const sel = latestSelection(src.selectDir);
  const pins = pinStatuses(sel.pinsIndex);
  const all = readJsonl(sel.candidates).filter(
    (r) =>
      (q.l2_class === undefined || r.l2_class === q.l2_class) && (q.why === undefined || r.why === q.why) && (q.mode === undefined || r.mode === q.mode) &&
      (q.small_diff === undefined || r.small_diff === q.small_diff) &&
      (q.session_id === undefined || r.session_id === q.session_id),
  );
  const page = all.slice(q.offset, q.offset + q.limit);
  // MT-20: a row opens only when ITS run is in the layer-1 file (a session file can be older than the selection).
  const keysByFile = new Map<string, Set<string> | null>();
  const hasRun = (ix: IndexRow | undefined, agentId: string | null): boolean => {
    const file = safeTrajectoryPath(ix?.trajectory_ref ?? null, src.trajectoryRoot);
    if (!file) return false;
    if (!keysByFile.has(file)) {
      try {
        keysByFile.set(file, runKeysOf(file));
      } catch {
        keysByFile.set(file, null);
      }
    }
    const keys = keysByFile.get(file);
    // A file with no runs_index (an older extractor): the session check alone, as before.
    return keys ? keys.has(agentId ?? '') : true;
  };
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
      return candidateView(r, pins.get(key(r.session_id, r.agent_id)) ?? null, hasRun(ix, str(r.agent_id)));
    }),
  };
}

// --- S13: a pin of a review run -> its session (task C6-REVIEW-QUEUE-READY) ------------------------------------
//
// A review run in the TMA DB carries only the sha256 of its case pin. The S13 card needs the session behind it (the
// "Open the full trace" link) and, when the run went up without one, the task summary. S2 reads only the NEWEST
// selection day, but the review queue holds runs pinned on older days (2026-11-14, 2026-11-16, ...), so a lookup over
// the newest day finds about 1 in 10 of them. resolvePin reads EVERY `<name>-<day>.index.jsonl` of the folder (pins-*,
// replay30-*) and every `candidates-<day>[-<tag>].jsonl`, newest day first. A replay index row has no session id, so
// the `review-batch-<day>*.jsonl` files (the upload input of `tma eval review-batch`: pin sha, session file, task
// summary) name the session of those pins: the session id and the sub-agent id come from the session file path
// (`<session>.jsonl` or `<session>/subagents/agent-<agent>.jsonl`). The tables are rebuilt only when a file of the
// folder changes (name, size or mtime).

export const PIN_SHA = /^[0-9a-f]{64}$/;
const PIN_INDEX_FILE = /^[a-z0-9]+-(\d{4}-\d{2}-\d{2})\.index\.jsonl$/;
const ANY_CANDIDATES_FILE = /^candidates-(\d{4}-\d{2}-\d{2})(?:-[a-z0-9]+)?\.jsonl$/;
const REVIEW_BATCH_FILE = /^review-batch-(\d{4}-\d{2}-\d{2})[a-z0-9.-]*\.jsonl$/;
const SESSION_FILE = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl|\/subagents\/agent-([A-Za-z0-9_-]{1,80})\.jsonl)$/;
/** The session and sub-agent of a recorded session file path, or null. */
export function sessionOfFile(path: string | null): { session_id: string; agent_id: string | null } | null {
  const m = path ? SESSION_FILE.exec(path) : null;
  return m ? { session_id: m[1]!, agent_id: m[2] ?? null } : null;
}

interface PinEntry {
  session_id: string;
  agent_id: string | null;
  day: string;
  /** The task summary of the review-batch row, when the pin came from one. */
  summary?: TaskSummary | null;
}
interface PinTables {
  sig: string;
  pins: Map<string, PinEntry>;
  /** session\0agent -> the newest candidate row with a task summary (or the newest row when none has one). */
  rows: Map<string, Row>;
}
/** One cache entry per selection folder: the real tree and the fixture tree never share tables. */
const pinTables = new Map<string, PinTables>();

function folderSignature(dir: string, names: string[]): string {
  return names
    .map((n) => {
      const st = statSync(join(dir, n));
      return `${n}:${st.size}:${st.mtimeMs}`;
    })
    .join('|');
}

function loadPinTables(selectDir: string): PinTables {
  let names: string[];
  try {
    names = readdirSync(selectDir);
  } catch {
    throw new NotFound('no_trace_selection');
  }
  const pinFiles = names.filter((n) => PIN_INDEX_FILE.test(n)).sort((a, b) => PIN_INDEX_FILE.exec(b)![1]!.localeCompare(PIN_INDEX_FILE.exec(a)![1]!) || b.localeCompare(a));
  const candFiles = names.filter((n) => ANY_CANDIDATES_FILE.test(n)).sort((a, b) => ANY_CANDIDATES_FILE.exec(b)![1]!.localeCompare(ANY_CANDIDATES_FILE.exec(a)![1]!) || a.localeCompare(b));
  const batchFiles = names.filter((n) => REVIEW_BATCH_FILE.test(n)).sort((a, b) => b.localeCompare(a));
  const sig = folderSignature(selectDir, [...pinFiles, ...candFiles, ...batchFiles]);
  const cached = pinTables.get(selectDir);
  if (cached && cached.sig === sig) return cached;
  const pins = new Map<string, PinEntry>();
  for (const f of pinFiles) {
    const day = PIN_INDEX_FILE.exec(f)![1]!;
    for (const r of readJsonl(join(selectDir, f))) {
      const sha = str(r.pin_sha256);
      const sid = str(r.session_id);
      // Newest day first: the first file that names a pin wins.
      if (sha && PIN_SHA.test(sha) && sid && SESSION_ID.test(sid) && !pins.has(sha)) pins.set(sha, { session_id: sid, agent_id: str(r.agent_id), day });
    }
  }
  for (const f of batchFiles) {
    const day = REVIEW_BATCH_FILE.exec(f)![1]!;
    for (const r of readJsonl(join(selectDir, f))) {
      const sha = str(obj(r.pin)?.pin_sha256);
      const at = sessionOfFile(str(r.session_file));
      if (sha && PIN_SHA.test(sha) && at && !pins.has(sha)) pins.set(sha, { ...at, day, summary: taskSummary(r.task_summary) });
    }
  }
  const rows = new Map<string, Row>();
  for (const f of candFiles) {
    for (const r of readJsonl(join(selectDir, f))) {
      const k = key(r.session_id, r.agent_id);
      const cur = rows.get(k);
      const has = (x: Row | undefined) => !!x && !!taskSummary(x.task_summary) && !!(taskSummary(x.task_summary)!.before || taskSummary(x.task_summary)!.expected);
      if (!cur || (!has(cur) && has(r))) rows.set(k, r);
    }
  }
  const built = { sig, pins, rows };
  pinTables.set(selectDir, built);
  return built;
}

/** GET /v1/pins/:pin_sha256 — the session of a pin, over every selection day, with the task fields of its candidate row. */
export function resolvePin(src: StudioSources, pinSha: string) {
  if (!PIN_SHA.test(pinSha)) throw new NotFound('bad_pin');
  const t = loadPinTables(src.selectDir);
  const hit = t.pins.get(pinSha);
  if (!hit) throw new NotFound('pin_not_found');
  const row = t.rows.get(key(hit.session_id, hit.agent_id)) ?? null;
  const fromRow = row ? taskSummary(row.task_summary) : null;
  const filled = (x: TaskSummary | null | undefined) => !!x && !!(x.before || x.expected);
  const ix = lookupSessions(src.indexPath, [hit.session_id]).get(hit.session_id);
  return {
    pin_sha256: pinSha,
    session_id: hit.session_id,
    agent_id: hit.agent_id,
    selection_day: hit.day,
    task_name: row ? str(row.task_name) : null,
    identifier: row ? str(row.identifier) : null,
    task_summary: filled(fromRow) ? fromRow : filled(hit.summary) ? hit.summary! : fromRow,
    has_trajectory: !!safeTrajectoryPath(ix?.trajectory_ref ?? null, src.trajectoryRoot),
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

/** MT-20: the summary of ONE run, in the shape of summaryView, so a run trace shows its own numbers only. */
function runSummaryView(r: Row, title: string | null) {
  const errors = obj(r.errors);
  return {
    title,
    started_at: str(r.started_at),
    ended_at: str(r.ended_at),
    duration_s: num(r.duration_s),
    active_s: num(r.active_s),
    channel: str(r.channel),
    models: Array.isArray(r.models) ? r.models.filter((m): m is string => typeof m === 'string') : [],
    n_runs: 1,
    n_subagent_runs: null,
    n_tool_calls: num(r.n_tool_calls),
    tool_counts: obj(r.tool_counts),
    intent_counts: obj(r.intent_counts),
    errors: errors ? num(errors.n) : num(r.errors),
    outcome_signals: obj(r.outcome_signals),
    closure_confidence: str(r.closure_confidence),
    cost_usd: num(r.cost_usd),
    extractor_version: str(r.extractor_version),
  };
}

/** The candidate row of one run, newest selection day first, with the pin status of that day. */
export function findCandidate(selectDir: string, sessionId: string, agentId: string | null): { row: Row; pin: PinStatus | null } | null {
  const want = key(sessionId, agentId);
  for (const d of selectionDays(selectDir)) {
    const row = readJsonl(d.candidates).find((r) => key(r.session_id, r.agent_id) === want);
    if (row) return { row, pin: pinStatuses(d.pinsIndex).get(want) ?? null };
  }
  return null;
}

/**
 * MT-05 (Build N cases): the full tma-pin/1 record of one run. The pins index of a day names the pin sha of the run;
 * the record is the row of `pins-<day>.jsonl` (the same folder) with that pin_sha256. Newest day first: the first day
 * whose index names the run wins. Null when no index names the run, or when that day holds no record of its sha.
 */
export function pinRecordOf(selectDir: string, sessionId: string, agentId: string | null): { pin_sha256: string; record: Row | null } | null {
  const want = key(sessionId, agentId);
  for (const d of selectionDays(selectDir)) {
    if (!d.pinsIndex) continue;
    const hit = readJsonl(d.pinsIndex).find((r) => key(r.session_id, r.agent_id) === want);
    const sha = hit ? str(hit.pin_sha256) : null;
    if (!sha || !PIN_SHA.test(sha)) continue;
    const records = d.pinsIndex.replace(/\.index\.jsonl$/, '.jsonl');
    let rows: Row[] = [];
    try {
      rows = readJsonl(records);
    } catch {
      rows = [];
    }
    return { pin_sha256: sha, record: rows.find((r) => str(r.pin_sha256) === sha) ?? null };
  }
  return null;
}

/**
 * MT-20: the run of a trace id. The selection rows first (newest day first), then every session and subagent of the
 * index. A 12-hex id has 48 bits: a collision among the indexed runs is not expected, and the first match wins.
 */
export function resolveTraceId(src: StudioSources, id: string): { sessionId: string; agentId: string | null } {
  if (!TRACE_ID.test(id)) throw new NotFound('bad_trace_id');
  for (const d of selectionDays(src.selectDir)) {
    for (const r of readJsonl(d.candidates)) {
      const sid = str(r.session_id);
      if (sid && SESSION_ID.test(sid) && traceId(sid, str(r.agent_id)) === id) return { sessionId: sid, agentId: str(r.agent_id) };
    }
  }
  const db = openReadOnly(src.indexPath);
  try {
    const rows = db.prepare('SELECT DISTINCT session_id, agent_id FROM sessions WHERE session_id IS NOT NULL').all();
    for (const r of rows) {
      const sid = str(r.session_id);
      if (!sid || !SESSION_ID.test(sid)) continue;
      // The main run of a session has its own trace id, also when the index lists only its subagents.
      if (traceId(sid, null) === id) return { sessionId: sid, agentId: null };
      const aid = str(r.agent_id);
      if (aid && AGENT_ID.test(aid) && traceId(sid, aid) === id) return { sessionId: sid, agentId: aid };
    }
  } finally {
    db.close();
  }
  throw new NotFound('trace_not_found');
}

/** S3 by trace id: exactly one run (the main run when the id is of the main run). */
export function getTraceById(src: StudioSources, id: string) {
  const { sessionId, agentId } = resolveTraceId(src, id);
  return getTrace(src, sessionId, agentId ?? undefined, { oneRun: true });
}

/**
 * S3. With an agent id (or `oneRun`), the trace is that ONE run: its spans, its own summary and the task name as the
 * title. The session is only a reference (`session`). Without both (the old /v1/traces/<session> URL), the whole
 * session, as before.
 */
export function getTrace(src: StudioSources, sessionId: string, agentId?: string, opts: { oneRun?: boolean } = {}) {
  if (!SESSION_ID.test(sessionId)) throw new NotFound('bad_session_id');
  if (agentId !== undefined && !AGENT_ID.test(agentId)) throw new NotFound('bad_agent_id');
  const ix = lookupSessions(src.indexPath, [sessionId]).get(sessionId);
  if (!ix) throw new NotFound('session_not_indexed');
  const file = safeTrajectoryPath(ix.trajectory_ref, src.trajectoryRoot);
  if (!file) throw new NotFound('no_trajectory');
  const size = statSync(file).size;
  let rows: Row[];
  if (size <= MAX_TRAJECTORY_BYTES) rows = readJsonl(file);
  else if (agentId !== undefined && size <= MAX_FILTERED_TRAJECTORY_BYTES) {
    // One sub-agent of a long session: keep the session_tree row and that agent's run rows only.
    const mine = new RegExp(`"agent_id"\\s*:\\s*"${agentId}"`);
    rows = readJsonlFiltered(file, (head) => /"kind"\s*:\s*"session_tree"/.test(head) || mine.test(head));
  } else throw new NotFound('trajectory_too_large');
  const tree = rows.find((r) => r.kind === 'session_tree' && r.session_id === sessionId);
  const runRows = rows.filter((r) => r.kind === 'run' && r.session_id === sessionId);
  const oneRun = agentId !== undefined || opts.oneRun === true;
  const own = oneRun
    ? runRows.filter((r) => (agentId === undefined ? str(r.agent_id) === null && r.is_subagent !== true : str(r.agent_id) === agentId))
    : runRows;
  if (oneRun && own.length === 0) throw new NotFound(agentId === undefined ? 'main_run_not_in_trajectory' : 'agent_not_in_trajectory');
  const runs = own.map(runView);

  const found = (() => {
    try {
      return findCandidate(src.selectDir, sessionId, agentId ?? null);
    } catch (e) {
      if (e instanceof NotFound) return null;
      throw e;
    }
  })();
  const candidate = found ? candidateView(found.row, found.pin, true) : null;
  const pin = found?.pin ?? null;

  // The first failed step, in time order over the runs shown.
  const failures = runs
    .flatMap((r) => r.spans.filter((s) => s.ok === false).map((s) => ({ agent_id: r.agent_id, ...s })))
    .sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
  const { trajectory_ref: _ref, ...indexShown } = ix;
  const run = oneRun ? own[0]! : null;
  // The title of a run trace: its task name, else the brief description of the subagent; the session title only
  // for the main run. The session title never names a subagent trace (MT-20: "O Mark no Alien" on a T1 run).
  const runTitle = run
    ? candidate?.task_name?.trim() || (agentId === undefined ? str(tree?.title) : str(run.description) || str(run.title))
    : null;
  return {
    trace_id: traceId(sessionId, agentId ?? null),
    scope: oneRun ? ('run' as const) : ('session' as const),
    session_id: sessionId,
    agent_id: agentId ?? null,
    session: {
      session_id: sessionId,
      title: tree ? str(tree.title) : null,
      n_runs: tree ? num(tree.n_runs) : null,
      n_subagent_runs: tree ? num(tree.n_subagent_runs) : null,
    },
    index: indexShown,
    candidate,
    pin,
    task_summary: candidate?.task_summary ?? null,
    summary: run ? runSummaryView(run, runTitle ?? null) : tree ? summaryView(tree) : null,
    runs,
    first_failure: failures[0] ?? null,
  };
}

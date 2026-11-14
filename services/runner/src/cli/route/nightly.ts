// The nightly regression of the live routes (plan 20261112-tma-c8-routing-from-evals, T6, ADR-2, ADR-7).
// Each night, for each LIVE route: run the golden set of its use case with the routed agent, upload the runs and
// compare with the verdict the route cites. A drop under the picked rule MARKS the route needs_check; nothing here
// changes a route value or a route file (ADR-7).
//
// This module holds the parts without a network or a sandbox: the golden set reader (dfl-evals
// sets/golden/<type>/<subtype>.jsonl + cases/<type>/<subtype>/<case_key>/case.json), the held-out proof, the
// profile bars, the verdict, and the state file (tma-route-nightly-state/1). The command is in commands/route.ts;
// the default run path (case folder, sandbox, upload) is in route/nightly-run.ts.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { routeVerdictPasses, type Route } from '@itera/contracts';
import { absoluteVerdict, relativeVerdict, type CaseRun } from '@itera/contracts/compare';
import { caseErrors, type CaseManifest } from '../eval/case.js';

export const NIGHTLY_STATE_FORMAT = 'tma-route-nightly-state/1';
export const GOLDEN_ROW_SCHEMA = 'tma-golden-row/1';
/** The default and the largest --repeat. */
export const NIGHTLY_DEFAULT_REPEAT = 3;
export const NIGHTLY_MAX_REPEAT = 10;
/** The library defaults (compare.js): used when the use case has no profile.json. */
export const DEFAULT_BARS = { same: 95, close: 85 } as const;
export const DEFAULT_MIN_RUNS = 5;
export const DEFAULT_MARGIN = 5;

/** A route whose model calls a local host (ALIEN01). */
export const LOCAL_MODEL_RE = /^(?:ollama|local)\//;

export interface GoldenCase {
  case_key: string;
  /** The absolute path of the case.json. */
  file: string;
  manifest: CaseManifest;
}

export type GoldenRead = { ok: true; cases: GoldenCase[] } | { ok: false; note: string };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const CASE_KEY_RE = /^[a-z0-9][a-z0-9_-]{2,62}$/;
const USE_CASE_RE = /^[a-z0-9][a-z0-9-]{0,30}\/[a-z0-9][a-z0-9-]{0,30}$/;

/** The golden file of a use case, relative to the dfl-evals checkout. */
export const goldenSetPath = (useCase: string) => join('sets', 'golden', `${useCase}.jsonl`);
export const goldenCasePath = (useCase: string, caseKey: string) => join('cases', useCase, caseKey, 'case.json');
export const profilePath = (useCase: string) => join('use-cases', useCase, 'profile.json');

/**
 * Read the golden set of a use case. Only tma-golden-row/1 rows count (a legacy row is ignored). A `draft` row
 * refuses the whole set (the content is Tainan's: an unapproved set never runs). Each case file must be a valid
 * tma-case/1 manifest with split golden, the same case_key and the same use case.
 */
export async function readGoldenSet(goldenDir: string, useCase: string): Promise<GoldenRead> {
  if (!USE_CASE_RE.test(useCase)) return { ok: false, note: 'golden_case_invalid: the use case is not a type/subtype pair' };
  const text = await readFile(join(goldenDir, goldenSetPath(useCase)), 'utf-8').catch(() => null);
  if (text === null) return { ok: false, note: 'no_golden_set' };
  const rows: Array<{ case_key: string; state: string }> = [];
  const lines = text.split('\n');
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      return { ok: false, note: `golden_case_invalid: line ${i + 1} is not JSON` };
    }
    if (!isObj(v) || v.schema !== GOLDEN_ROW_SCHEMA) continue; // a legacy row
    const keys = Object.keys(v).sort().join(',');
    if (keys !== 'approved_by,case_key,schema,state') return { ok: false, note: `golden_case_invalid: line ${i + 1} must have exactly schema, case_key, state, approved_by` };
    if (typeof v.case_key !== 'string' || !CASE_KEY_RE.test(v.case_key)) return { ok: false, note: `golden_case_invalid: line ${i + 1} has a bad case_key` };
    if (v.state !== 'draft' && v.state !== 'approved') return { ok: false, note: `golden_case_invalid: line ${i + 1} state must be draft or approved` };
    if (v.state === 'approved' && (typeof v.approved_by !== 'string' || v.approved_by.trim() === '')) {
      return { ok: false, note: `golden_case_invalid: ${v.case_key} is approved without approved_by` };
    }
    if (rows.some((r) => r.case_key === v.case_key)) return { ok: false, note: `golden_case_invalid: ${v.case_key} is listed twice` };
    rows.push({ case_key: v.case_key, state: v.state });
  }
  if (rows.length === 0) return { ok: false, note: 'no_golden_set' };
  const draft = rows.find((r) => r.state === 'draft');
  if (draft) return { ok: false, note: `golden_draft: ${draft.case_key}` };
  const cases: GoldenCase[] = [];
  for (const r of rows) {
    const file = join(goldenDir, goldenCasePath(useCase, r.case_key));
    const body = await readFile(file, 'utf-8').catch(() => null);
    if (body === null) return { ok: false, note: `golden_case_invalid: ${r.case_key} has no case.json` };
    let v: unknown;
    try {
      v = JSON.parse(body);
    } catch {
      return { ok: false, note: `golden_case_invalid: ${r.case_key} case.json is not JSON` };
    }
    const errors = caseErrors(v);
    if (errors.length) return { ok: false, note: `golden_case_invalid: ${r.case_key} ${errors[0]!.slice(0, 120)}` };
    const m = v as CaseManifest;
    if (m.split !== 'golden') return { ok: false, note: `golden_case_invalid: ${r.case_key} split is ${m.split}, not golden` };
    if (m.case_key !== r.case_key) return { ok: false, note: `golden_case_invalid: ${r.case_key} case.json names case_key ${m.case_key}` };
    if (m.use_case !== useCase) return { ok: false, note: `golden_case_invalid: ${r.case_key} case.json names use case ${m.use_case}` };
    cases.push({ case_key: r.case_key, file, manifest: m });
  }
  return { ok: true, cases };
}

// ---- held-out proof ----

export interface EvidenceRun {
  id?: string;
  caseId?: string;
  caseKey?: string;
}
export interface EvidenceCase {
  id: string;
  caseKey: string;
  originPinSha256: string | null;
  taskSlug: string | null;
}

/** The task of a case as a comparable token: the slug of a tma-task (before @), else the dfl-task id. */
export function taskToken(ref: CaseManifest['task_ref']): string {
  return ref.kind === 'tma-task' ? ref.id.split('@')[0]! : ref.id;
}

/**
 * The golden cases must share NO case_key, NO pin_sha256 and NO task with an evidence case of the route.
 * Returns null when held out, or the note of the skip. Evidence that the reader cannot see fails closed.
 */
export function heldOutNote(route: Route, golden: readonly GoldenCase[], runs: readonly EvidenceRun[], cases: readonly EvidenceCase[] | null): string | null {
  const ids = route.evidence_run_ids ?? [];
  if (ids.length === 0) return 'held_out_unprovable: the route cites no evidence run';
  const byId = new Map(runs.filter((r) => typeof r.id === 'string').map((r) => [r.id!, r]));
  const evid: EvidenceCase[] = [];
  for (const id of ids) {
    const run = byId.get(id);
    if (!run || !run.caseId || !run.caseKey) return `held_out_unprovable: evidence run ${id.slice(0, 8)} is not in the run rows`;
    if (cases === null) return 'held_out_unprovable: the eval cases could not be read';
    const c = cases.find((x) => x.id === run.caseId);
    if (!c) return `held_out_unprovable: the case of evidence run ${id.slice(0, 8)} is not in the eval cases`;
    evid.push({ ...c, caseKey: run.caseKey });
  }
  const keys = new Set(evid.map((c) => c.caseKey));
  const pins = new Set(evid.map((c) => c.originPinSha256).filter((p): p is string => typeof p === 'string'));
  const tasks = new Set(evid.map((c) => c.taskSlug).filter((t): t is string => typeof t === 'string' && t !== ''));
  for (const g of golden) {
    if (keys.has(g.case_key)) return `golden_not_held_out: ${g.case_key} (case_key)`;
    const pin = g.manifest.pin?.pin_sha256;
    if (pin && pins.has(pin)) return `golden_not_held_out: ${g.case_key} (pin_sha256)`;
    if (tasks.has(taskToken(g.manifest.task_ref)) || tasks.has(g.manifest.task_ref.id)) return `golden_not_held_out: ${g.case_key} (task_ref)`;
  }
  return null;
}

// ---- profile ----

export interface Bars {
  same: number;
  close: number;
  minRuns: number;
  margin: number;
}

/** The bars of a use case: profile.json when present (absolute_bars, min_runs_per_cell, relative_margin_points), else the defaults. */
export async function readBars(goldenDir: string, useCase: string): Promise<{ ok: true; bars: Bars } | { ok: false; note: string }> {
  const text = await readFile(join(goldenDir, profilePath(useCase)), 'utf-8').catch(() => null);
  const bars: Bars = { same: DEFAULT_BARS.same, close: DEFAULT_BARS.close, minRuns: DEFAULT_MIN_RUNS, margin: DEFAULT_MARGIN };
  if (text === null) return { ok: true, bars };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, note: 'profile_invalid: profile.json is not JSON' };
  }
  if (!isObj(v)) return { ok: false, note: 'profile_invalid: profile.json is not an object' };
  const num = (x: unknown, lo: number, hi: number) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
  if (v.absolute_bars !== undefined) {
    const b = v.absolute_bars;
    if (!isObj(b) || !num(b.same, 0, 100) || !num(b.close, 0, 100) || (b.close as number) > (b.same as number)) return { ok: false, note: 'profile_invalid: absolute_bars' };
    bars.same = b.same as number;
    bars.close = b.close as number;
  }
  if (v.min_runs_per_cell !== undefined) {
    if (!num(v.min_runs_per_cell, 1, 1000) || !Number.isInteger(v.min_runs_per_cell)) return { ok: false, note: 'profile_invalid: min_runs_per_cell' };
    bars.minRuns = v.min_runs_per_cell as number;
  }
  if (v.relative_margin_points !== undefined) {
    if (!num(v.relative_margin_points, 0, 100)) return { ok: false, note: 'profile_invalid: relative_margin_points' };
    bars.margin = v.relative_margin_points as number;
  }
  return { ok: true, bars };
}

// ---- verdict ----

/** One graded golden run. */
export interface GoldenRun {
  case_key: string;
  /** The case score 0..100, or null when the grading gave none. */
  score: number | null;
  hardGatesOk: boolean;
  infraOk: boolean;
}

/** A run with no score is not measured: it is left out like a platform fault. */
export const toCaseRun = (r: GoldenRun): CaseRun => ({ score: r.score ?? 0, hardGatesOk: r.hardGatesOk, infraOk: r.infraOk && r.score !== null });

/** The effective scores per case of the counted runs (a failed hard gate scores 0, as relativeVerdict counts it). */
export function scoresByCase(runs: readonly GoldenRun[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const r of runs) {
    const c = toCaseRun(r);
    if (c.infraOk === false) continue;
    (out[r.case_key] ??= []).push(c.hardGatesOk ? c.score : 0);
  }
  return out;
}

export type NightVerdict =
  | { kind: 'refused'; label: 'refused'; note: string }
  | { kind: 'baseline'; label: 'baseline_recorded'; baseline: Record<string, number[]> }
  | { kind: 'compared'; label: string; drop: boolean; notes: string[] };

/**
 * The verdict of one night.
 *   absolute: absoluteVerdict(tonight, bars). The labels are SAME | CLOSE | NOT YET | refused; the stored route
 *             verdicts are same | close (routeVerdictPasses compares in lower case). A drop = the label does not
 *             pass under the absolute rule, so NOT YET is a drop. refused = no verdict.
 *   relative: the first night with enough runs stores tonight's scores as the baseline (no mark). Later nights:
 *             relativeVerdict(baseline, tonight). better | tie | worse | refused; only worse is a drop (tie is the
 *             stored "same"). Only the case keys of the baseline are compared.
 */
export function nightVerdict(route: Route, runs: readonly GoldenRun[], bars: Bars, baseline: Record<string, number[]> | null): NightVerdict {
  const tonight = runs.map(toCaseRun);
  if (route.picked_rule === 'absolute') {
    const side = absoluteVerdict(tonight, { same: bars.same, close: bars.close, minRuns: bars.minRuns });
    if (side.label === 'refused') return { kind: 'refused', label: 'refused', note: `n_below_minimum (n=${side.n}, min ${bars.minRuns})` };
    return { kind: 'compared', label: side.label, drop: !routeVerdictPasses('absolute', side.label), notes: [] };
  }
  if (baseline === null) {
    const scores = scoresByCase(runs);
    const n = Object.values(scores).reduce((s, x) => s + x.length, 0);
    if (n < bars.minRuns) return { kind: 'refused', label: 'refused', note: `n_below_minimum (n=${n}, min ${bars.minRuns})` };
    return { kind: 'baseline', label: 'baseline_recorded', baseline: scores };
  }
  const notes: string[] = [];
  const keys = Object.keys(baseline).sort();
  const tonightKeys = [...new Set(runs.map((r) => r.case_key))].sort();
  if (keys.join(',') !== tonightKeys.join(',')) notes.push('golden_set_changed: only the baseline case keys are compared');
  const base: CaseRun[] = keys.flatMap((k) => baseline[k]!.map((score) => ({ score, hardGatesOk: true, infraOk: true })));
  const tonightKept = runs.filter((r) => keys.includes(r.case_key)).map(toCaseRun);
  const v = relativeVerdict(base, tonightKept, { margin: bars.margin, minRuns: bars.minRuns });
  if (v.label === 'refused') return { kind: 'refused', label: 'refused', note: `n_below_minimum (base ${v.nBase}, tonight ${v.nVariant}, min ${bars.minRuns})` };
  return { kind: 'compared', label: v.label, drop: v.label === 'worse', notes };
}

// ---- the state file (tma-route-nightly-state/1) ----

export interface NightlyRouteState {
  /** Relative rule: the golden scores of the first successful night, per case key; null until then (and for absolute). */
  baseline: Record<string, number[]> | null;
  last_run_at: string | null;
  last_label: string | null;
  last_scores: Record<string, number[]> | null;
}

export interface NightlyState {
  format: typeof NIGHTLY_STATE_FORMAT;
  routes: Record<string, NightlyRouteState>;
  /** Paid runs of an earlier night that ran but did not upload: the budget counts them until a person clears them. */
  unuploaded_paid_runs: number;
}

export function emptyNightlyState(): NightlyState {
  return { format: NIGHTLY_STATE_FORMAT, routes: {}, unuploaded_paid_runs: 0 };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const LABEL_RE = /^[A-Za-z_ ]{1,40}$/;
const MAX_ROUTES = 10000;
const sameKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).sort().join(',') === [...keys].sort().join(',');

function scoresMapError(v: unknown, at: string): string | null {
  if (v === null) return null;
  if (!isObj(v) || Object.keys(v).length > 1000) return `${at} must be null or an object of at most 1000 case keys`;
  for (const [k, list] of Object.entries(v)) {
    if (!CASE_KEY_RE.test(k)) return `${at} has a bad case key`;
    if (!Array.isArray(list) || list.length > 1000 || !list.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 100)) {
      return `${at}/${k} must be a list of scores 0..100`;
    }
  }
  return null;
}

/** Validate a parsed state file (closed). Returns the state, or the first problem as a short path + reason. */
export function validateNightlyState(value: unknown): { ok: true; value: NightlyState } | { ok: false; error: string } {
  if (!isObj(value) || !sameKeys(value, ['format', 'routes', 'unuploaded_paid_runs'])) {
    return { ok: false, error: '/ must have exactly the keys format, routes and unuploaded_paid_runs' };
  }
  if (value.format !== NIGHTLY_STATE_FORMAT) return { ok: false, error: `/format must be ${NIGHTLY_STATE_FORMAT}` };
  const u = value.unuploaded_paid_runs;
  if (typeof u !== 'number' || !Number.isInteger(u) || u < 0 || u > 100000) return { ok: false, error: '/unuploaded_paid_runs must be an integer >= 0' };
  if (!isObj(value.routes)) return { ok: false, error: '/routes must be an object' };
  const ids = Object.keys(value.routes);
  if (ids.length > MAX_ROUTES) return { ok: false, error: `/routes has more than ${MAX_ROUTES} routes` };
  for (const id of ids) {
    const at = `/routes/${id.slice(0, 40)}`;
    if (!UUID_RE.test(id)) return { ok: false, error: `${at} is not a route id` };
    const r = value.routes[id];
    if (!isObj(r) || !sameKeys(r, ['baseline', 'last_run_at', 'last_label', 'last_scores'])) {
      return { ok: false, error: `${at} must have exactly the keys baseline, last_run_at, last_label, last_scores` };
    }
    const b = scoresMapError(r.baseline, `${at}/baseline`);
    if (b) return { ok: false, error: b };
    const s = scoresMapError(r.last_scores, `${at}/last_scores`);
    if (s) return { ok: false, error: s };
    if (r.last_run_at !== null && (typeof r.last_run_at !== 'string' || !TS_RE.test(r.last_run_at))) return { ok: false, error: `${at}/last_run_at must be null or a timestamp` };
    if (r.last_label !== null && (typeof r.last_label !== 'string' || !LABEL_RE.test(r.last_label))) return { ok: false, error: `${at}/last_label must be null or a label` };
  }
  return { ok: true, value: value as unknown as NightlyState };
}

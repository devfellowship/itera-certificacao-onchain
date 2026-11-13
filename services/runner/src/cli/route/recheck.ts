// The route recheck engine (plan 20261112-tma-c8-routing-from-evals, T5; ADR-3, ADR-7). Pure and deterministic:
// no I/O, no clock. It compares today's observation (tma-route-observation/1) with the baseline it stored the first
// time it saw each live route, and with the agent that each live route row names, and returns the routes to mark
// needs_check. A trigger MARKS a route; it never changes a route file or a route value (ADR-7).
//
// The four triggers, per live route:
//   model_or_price  the model list + price digest differs from the baseline digest;
//   task_mix        the share of the route's L1 pair moved by MORE than 10 points from the baseline share;
//   grader_version  the grader map of the route's pair differs from the baseline map (a version, a new or a removed id);
//   agent_change    the harness commit, the rules digest or the skills digest of the route's harness differs from the
//                   route row (only when both sides are known).
import type { Route, RouteObservation } from '@itera/contracts';

export const RECHECK_STATE_FORMAT = 'tma-route-recheck-state/1';
/** The task_mix rule: a shift of MORE than this many points triggers. */
export const MIX_SHIFT_POINTS = 10;

export type TriggerKind = 'model_or_price' | 'task_mix' | 'grader_version' | 'agent_change';
export const TRIGGER_KINDS: readonly TriggerKind[] = ['model_or_price', 'task_mix', 'grader_version', 'agent_change'];

/** What the recheck saw the first time a route was live. */
export interface RouteBaseline {
  models_digest: string;
  /** The share of the route's pair, or null when the pair was absent (counts as 0). */
  mix_share: number | null;
  /** The declared runs in the window at that time; 0 = no data (the mix baseline is filled at the first data). */
  mix_total: number;
  /** The observed grader map of the route's pair, or {}. */
  graders: Record<string, string>;
  first_seen_at: string;
}

export interface RecheckState {
  format: typeof RECHECK_STATE_FORMAT;
  routes: Record<string, RouteBaseline>;
}

export interface Trigger {
  kind: TriggerKind;
  /** Short structured text from tokens only: digest prefixes, shares, grader ids and versions. */
  detail: string;
}

export interface Mark {
  route_id: string;
  use_case_key: string;
  triggers: Trigger[];
}

/** Per live route: what the recheck could not compare, and whether it was the first sight. */
export interface RouteCheck {
  route_id: string;
  use_case_key: string;
  first_sight: boolean;
  triggers: Trigger[];
  notes: string[];
}

export interface RecheckResult {
  marks: Mark[];
  checks: RouteCheck[];
  nextState: RecheckState;
}

export function emptyRecheckState(): RecheckState {
  return { format: RECHECK_STATE_FORMAT, routes: {} };
}

const p12 = (s: string) => s.slice(0, 12);
/** A share as a short token: at most 2 decimals, no trailing zeros. */
const pct = (n: number) => String(Math.round(n * 100) / 100);

function graderMap(observed: RouteObservation, pair: string): Record<string, string> {
  const m = Object.prototype.hasOwnProperty.call(observed.graders, pair) ? observed.graders[pair] : undefined;
  return m ? { ...m } : {};
}

function shareOf(observed: RouteObservation, pair: string): number | null {
  return Object.prototype.hasOwnProperty.call(observed.mix.shares, pair) ? observed.mix.shares[pair]! : null;
}

function baselineOf(observed: RouteObservation, pair: string): RouteBaseline {
  return {
    models_digest: observed.models.digest,
    mix_share: shareOf(observed, pair),
    mix_total: observed.mix.total,
    graders: graderMap(observed, pair),
    first_seen_at: observed.observed_at,
  };
}

function graderDiff(before: Record<string, string>, after: Record<string, string>): string | null {
  const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const parts: string[] = [];
  for (const id of ids) {
    const a = before[id];
    const b = after[id];
    if (a !== b) parts.push(`${id} ${a ?? 'none'} -> ${b ?? 'none'}`);
  }
  return parts.length ? parts.join(', ') : null;
}

function agentCheck(route: Route, observed: RouteObservation, notes: string[]): Trigger | null {
  if (!route.harness) {
    notes.push('agent unknown: the route names no harness');
    return null;
  }
  const seen = observed.agents[route.harness];
  if (!seen) {
    notes.push(`agent unknown: no observation for harness ${route.harness}`);
    return null;
  }
  const routeSkills = Array.isArray(route.skills_sha256) && route.skills_sha256.length === 1 ? route.skills_sha256[0]! : null;
  const pairs: Array<[string, string | null | undefined, string | null]> = [
    ['harness_repo_sha', route.harness_repo_sha, seen.harness_repo_sha],
    ['rules_sha256', route.rules_sha256, seen.rules_sha256],
    ['skills_sha256', routeSkills, seen.skills_sha256],
  ];
  const changed: string[] = [];
  const unknown: string[] = [];
  for (const [key, mine, theirs] of pairs) {
    if (mine === null || mine === undefined || theirs === null) {
      const side = mine === null || mine === undefined ? (theirs === null ? 'route and observation' : 'route') : 'observation';
      const why = key === 'skills_sha256' && Array.isArray(route.skills_sha256) && route.skills_sha256.length > 1 ? ` (route names ${route.skills_sha256.length} digests)` : '';
      unknown.push(`${key} (${side})${why}`);
      continue;
    }
    if (mine !== theirs) changed.push(`${key} ${p12(mine)} -> ${p12(theirs)}`);
  }
  if (unknown.length) notes.push(`agent digest unknown, not compared: ${unknown.join(', ')}`);
  return changed.length ? { kind: 'agent_change', detail: `${route.harness} ${changed.join(', ')}` } : null;
}

/**
 * Compare today's observation with the stored baselines and with each live route's agent.
 * Routes absent from `liveRoutes` are dropped from the next state. The first sight of a route records its baseline
 * and runs only the agent trigger (there is nothing older to compare for the other three).
 */
export function recheck(liveRoutes: readonly Route[], observed: RouteObservation, state: RecheckState): RecheckResult {
  const next: RecheckState = { format: RECHECK_STATE_FORMAT, routes: {} };
  const marks: Mark[] = [];
  const checks: RouteCheck[] = [];
  for (const route of liveRoutes) {
    const pair = route.use_case_key;
    const triggers: Trigger[] = [];
    const notes: string[] = [];
    const stored = Object.prototype.hasOwnProperty.call(state.routes, route.id) ? state.routes[route.id] : undefined;
    const firstSight = stored === undefined;
    let baseline: RouteBaseline = stored ? { ...stored, graders: { ...stored.graders } } : baselineOf(observed, pair);

    if (firstSight) {
      notes.push('first sight: baseline recorded, model, mix and grader triggers start next run');
    } else {
      // 1. model_or_price
      if (observed.models.digest !== baseline.models_digest) {
        triggers.push({ kind: 'model_or_price', detail: `models ${p12(baseline.models_digest)} -> ${p12(observed.models.digest)}` });
      }
      // 2. task_mix
      if (observed.mix.total === 0) {
        notes.push('mix: no data (total 0), not compared');
      } else if (baseline.mix_total === 0) {
        // The baseline was taken without data: today's share becomes the mix baseline, no trigger.
        baseline = { ...baseline, mix_share: shareOf(observed, pair), mix_total: observed.mix.total };
        notes.push('mix: first data since the baseline, mix baseline recorded');
      } else {
        const before = baseline.mix_share ?? 0;
        const today = shareOf(observed, pair) ?? 0;
        if (Math.abs(today - before) > MIX_SHIFT_POINTS) {
          triggers.push({ kind: 'task_mix', detail: `share ${pct(before)} -> ${pct(today)} (${observed.mix.window_days}d, n=${observed.mix.total})` });
        }
      }
      // 3. grader_version
      const diff = graderDiff(baseline.graders, graderMap(observed, pair));
      if (diff !== null) triggers.push({ kind: 'grader_version', detail: diff });
    }
    // 4. agent_change (also on first sight: it compares with the route row)
    const agent = agentCheck(route, observed, notes);
    if (agent) triggers.push(agent);

    next.routes[route.id] = baseline;
    checks.push({ route_id: route.id, use_case_key: pair, first_sight: firstSight, triggers, notes });
    if (triggers.length) marks.push({ route_id: route.id, use_case_key: pair, triggers });
  }
  return { marks, checks, nextState: next };
}

// --- The state file (tma-route-recheck-state/1). A small closed check: the file is ours, but a bad file must
// never be overwritten silently.

const SHA256_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GRADER_RE = /^[a-z0-9][a-z0-9._/-]{0,99}$/;
const SEMVER_RE = /^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(-[0-9A-Za-z][0-9A-Za-z.-]{0,39})?$/;
const TS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const MAX_STATE_ROUTES = 10000;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (o: Record<string, unknown>, keys: string[]) => {
  const k = Object.keys(o).sort();
  return k.length === keys.length && [...keys].sort().every((x, i) => x === k[i]);
};

/** Validate a parsed state file. Returns the state, or the first problem as a short path + reason. */
export function validateRecheckState(value: unknown): { ok: true; value: RecheckState } | { ok: false; error: string } {
  if (!isObj(value) || !sameKeys(value, ['format', 'routes'])) return { ok: false, error: '/ must have exactly the keys format and routes' };
  if (value.format !== RECHECK_STATE_FORMAT) return { ok: false, error: `/format must be ${RECHECK_STATE_FORMAT}` };
  if (!isObj(value.routes)) return { ok: false, error: '/routes must be an object' };
  const ids = Object.keys(value.routes);
  if (ids.length > MAX_STATE_ROUTES) return { ok: false, error: `/routes has more than ${MAX_STATE_ROUTES} routes` };
  for (const id of ids) {
    const at = `/routes/${id.slice(0, 40)}`;
    if (!UUID_RE.test(id)) return { ok: false, error: `${at} is not a route id` };
    const b = value.routes[id];
    if (!isObj(b) || !sameKeys(b, ['models_digest', 'mix_share', 'mix_total', 'graders', 'first_seen_at'])) {
      return { ok: false, error: `${at} must have exactly the keys models_digest, mix_share, mix_total, graders, first_seen_at` };
    }
    if (typeof b.models_digest !== 'string' || !SHA256_RE.test(b.models_digest)) return { ok: false, error: `${at}/models_digest is not a sha256` };
    if (b.mix_share !== null && (typeof b.mix_share !== 'number' || !(b.mix_share >= 0 && b.mix_share <= 100))) return { ok: false, error: `${at}/mix_share must be null or 0..100` };
    if (typeof b.mix_total !== 'number' || !Number.isInteger(b.mix_total) || b.mix_total < 0) return { ok: false, error: `${at}/mix_total must be an integer >= 0` };
    if (typeof b.first_seen_at !== 'string' || !TS_RE.test(b.first_seen_at)) return { ok: false, error: `${at}/first_seen_at is not a timestamp` };
    if (!isObj(b.graders) || Object.keys(b.graders).length > 50) return { ok: false, error: `${at}/graders must be an object of at most 50 graders` };
    for (const [g, v] of Object.entries(b.graders)) {
      if (!GRADER_RE.test(g) || typeof v !== 'string' || !SEMVER_RE.test(v)) return { ok: false, error: `${at}/graders has a bad grader id or version` };
    }
  }
  return { ok: true, value: value as unknown as RecheckState };
}

/** The one stdout line of a checked route (tokens only). */
export function triggersText(triggers: readonly Trigger[]): string {
  return triggers.map((t) => `${t.kind}: ${t.detail}`).join('; ');
}

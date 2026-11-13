// Synthetic fixtures: invented ids and digests only.
import { describe, expect, it } from 'vitest';
import type { Route, RouteObservation } from '@itera/contracts';
import { emptyRecheckState, recheck, validateRecheckState, type RecheckState } from './recheck.js';

const H = (c: string) => c.repeat(64);
const G = (c: string) => c.repeat(40);
const ID = '7c1e2a90-4b3d-4f6e-9a8b-0c1d2e3f4a5b';
const PAIR = 'content/report-html';

const route = (over: Partial<Route> = {}): Route => ({
  format: 'tma-route/2',
  id: ID,
  tenant: 'dfl',
  use_case_key: PAIR,
  route_target: 'env:DFL_ROUTE_HTML_REPORT',
  target_value: 'sonnet',
  rollback_value: 'deepseek',
  model_id: 'claude-sonnet-5-5',
  agent_sha256: H('a'),
  harness: 'claude-code',
  harness_repo_sha: G('1'),
  rules_sha256: H('2'),
  skills_sha256: [H('3')],
  picked_rule: 'absolute',
  verdict: 'same',
  n: 5,
  evidence_run_ids: [],
  compare_profile_sha256: H('b'),
  policy_version: 'c7-1',
  state: 'live',
  pr_url: 'https://github.com/devfellowship/dfl-infra/pull/101',
  approved_by_actor: 'example-approver',
  approved_at: '2026-11-12T18:30:00Z',
  live_at: '2026-11-13T10:00:00Z',
  rollback_pr_url: null,
  rolled_back_at: null,
  ...over,
});

const observed = (over: Partial<RouteObservation> = {}): RouteObservation => ({
  format: 'tma-route-observation/1',
  observed_at: '2026-11-14T06:00:00Z',
  models: { digest: H('d') },
  mix: { window_days: 14, total: 100, shares: { [PAIR]: 30 } },
  graders: { [PAIR]: { 'html-structure': '1.2.0' } },
  agents: { 'claude-code': { harness_repo_sha: G('1'), rules_sha256: H('2'), skills_sha256: H('3') } },
  ...over,
});

/** The state after a first run on the default observation. */
const baseState = (): RecheckState => ({
  format: 'tma-route-recheck-state/1',
  routes: { [ID]: { models_digest: H('d'), mix_share: 30, mix_total: 100, graders: { 'html-structure': '1.2.0' }, first_seen_at: '2026-11-13T06:00:00Z' } },
});

const kinds = (r: ReturnType<typeof recheck>) => r.marks.flatMap((m) => m.triggers.map((t) => t.kind));

describe('recheck: no trigger', () => {
  it('an unchanged observation sets no mark and keeps the baseline', () => {
    const r = recheck([route()], observed(), baseState());
    expect(r.marks).toEqual([]);
    expect(r.nextState).toEqual(baseState());
  });
});

describe('recheck: each trigger alone marks the route', () => {
  it('model_or_price', () => {
    const r = recheck([route()], observed({ models: { digest: H('e') } }), baseState());
    expect(r.marks).toEqual([{ route_id: ID, use_case_key: PAIR, triggers: [{ kind: 'model_or_price', detail: `models ${'d'.repeat(12)} -> ${'e'.repeat(12)}` }] }]);
  });

  it('task_mix', () => {
    const r = recheck([route()], observed({ mix: { window_days: 14, total: 80, shares: { [PAIR]: 45.5 } } }), baseState());
    expect(r.marks).toEqual([{ route_id: ID, use_case_key: PAIR, triggers: [{ kind: 'task_mix', detail: 'share 30 -> 45.5 (14d, n=80)' }] }]);
  });

  it('grader_version: a changed version, a new id, a removed id', () => {
    const changed = recheck([route()], observed({ graders: { [PAIR]: { 'html-structure': '1.3.0' } } }), baseState());
    expect(changed.marks[0]!.triggers).toEqual([{ kind: 'grader_version', detail: 'html-structure 1.2.0 -> 1.3.0' }]);
    const added = recheck([route()], observed({ graders: { [PAIR]: { 'html-structure': '1.2.0', 'judge/visual': '0.1.0' } } }), baseState());
    expect(added.marks[0]!.triggers).toEqual([{ kind: 'grader_version', detail: 'judge/visual none -> 0.1.0' }]);
    const removed = recheck([route()], observed({ graders: {} }), baseState());
    expect(removed.marks[0]!.triggers).toEqual([{ kind: 'grader_version', detail: 'html-structure 1.2.0 -> none' }]);
  });

  it('agent_change: harness commit, rules digest, skills digest', () => {
    const agent = (o: Record<string, string | null>) =>
      observed({ agents: { 'claude-code': { harness_repo_sha: G('1'), rules_sha256: H('2'), skills_sha256: H('3'), ...o } } });
    expect(recheck([route()], agent({ harness_repo_sha: G('9') }), baseState()).marks[0]!.triggers).toEqual([
      { kind: 'agent_change', detail: `claude-code harness_repo_sha ${'1'.repeat(12)} -> ${'9'.repeat(12)}` },
    ]);
    expect(kinds(recheck([route()], agent({ rules_sha256: H('8') }), baseState()))).toEqual(['agent_change']);
    expect(kinds(recheck([route()], agent({ skills_sha256: H('7') }), baseState()))).toEqual(['agent_change']);
  });

  it('two triggers give one mark with two kinds', () => {
    const r = recheck([route()], observed({ models: { digest: H('e') }, graders: { [PAIR]: { 'html-structure': '2.0.0' } } }), baseState());
    expect(r.marks).toHaveLength(1);
    expect(kinds(r)).toEqual(['model_or_price', 'grader_version']);
  });
});

describe('recheck: the 10-point edge and no data', () => {
  const mix = (share: number | undefined, total = 100) => observed({ mix: { window_days: 14, total, shares: share === undefined ? {} : { [PAIR]: share } } });
  it('exactly 10 points: no trigger; 10.01: trigger (both directions)', () => {
    expect(recheck([route()], mix(40), baseState()).marks).toEqual([]);
    expect(recheck([route()], mix(20), baseState()).marks).toEqual([]);
    expect(kinds(recheck([route()], mix(40.01), baseState()))).toEqual(['task_mix']);
    expect(kinds(recheck([route()], mix(19.99), baseState()))).toEqual(['task_mix']);
  });

  it('an absent pair counts as 0', () => {
    const r = recheck([route()], mix(undefined), baseState());
    expect(r.marks[0]!.triggers).toEqual([{ kind: 'task_mix', detail: 'share 30 -> 0 (14d, n=100)' }]);
    const s = baseState();
    s.routes[ID]!.mix_share = null;
    expect(recheck([route()], mix(5), s).marks).toEqual([]);
    expect(kinds(recheck([route()], mix(10.5), s))).toEqual(['task_mix']);
  });

  it('total 0: no mix trigger, and the check says so', () => {
    const r = recheck([route()], mix(undefined, 0), baseState());
    expect(r.marks).toEqual([]);
    expect(r.checks[0]!.notes).toContain('mix: no data (total 0), not compared');
  });

  it('a baseline without data takes the first data as the mix baseline, no trigger', () => {
    const s = baseState();
    s.routes[ID] = { ...s.routes[ID]!, mix_share: null, mix_total: 0 };
    const r = recheck([route()], mix(60), s);
    expect(r.marks).toEqual([]);
    expect(r.nextState.routes[ID]).toMatchObject({ mix_share: 60, mix_total: 100 });
    expect(kinds(recheck([route()], mix(75), r.nextState))).toEqual(['task_mix']);
  });
});

describe('recheck: first sight', () => {
  it('records the baseline from today and sets no model, mix or grader mark', () => {
    const r = recheck([route()], observed(), emptyRecheckState());
    expect(r.marks).toEqual([]);
    expect(r.checks[0]!.first_sight).toBe(true);
    expect(r.nextState.routes[ID]).toEqual({ models_digest: H('d'), mix_share: 30, mix_total: 100, graders: { 'html-structure': '1.2.0' }, first_seen_at: '2026-11-14T06:00:00Z' });
  });

  it('an absent pair gives mix_share null and graders {}', () => {
    const r = recheck([route({ use_case_key: 'plan/write-plan' })], observed(), emptyRecheckState());
    expect(r.nextState.routes[ID]).toMatchObject({ mix_share: null, graders: {} });
  });

  it('still runs the agent trigger (it compares with the route row)', () => {
    const r = recheck([route()], observed({ agents: { 'claude-code': { harness_repo_sha: G('9'), rules_sha256: H('2'), skills_sha256: H('3') } } }), emptyRecheckState());
    expect(kinds(r)).toEqual(['agent_change']);
    expect(r.nextState.routes[ID]).toBeDefined();
  });
});

describe('recheck: unknown agent digests never trigger', () => {
  it('a null on the observation side', () => {
    const r = recheck([route()], observed({ agents: { 'claude-code': { harness_repo_sha: null, rules_sha256: null, skills_sha256: null } } }), baseState());
    expect(r.marks).toEqual([]);
    expect(r.checks[0]!.notes.join(' ')).toMatch(/agent digest unknown, not compared: harness_repo_sha \(observation\), rules_sha256 \(observation\), skills_sha256 \(observation\)/);
  });

  it('a null on the route side, and a route with two skills digests', () => {
    const r = recheck([route({ harness_repo_sha: null, rules_sha256: null, skills_sha256: [H('3'), H('4')] })], observed({ agents: { 'claude-code': { harness_repo_sha: G('9'), rules_sha256: H('8'), skills_sha256: H('7') } } }), baseState());
    expect(r.marks).toEqual([]);
    expect(r.checks[0]!.notes.join(' ')).toMatch(/harness_repo_sha \(route\), rules_sha256 \(route\), skills_sha256 \(route\) \(route names 2 digests\)/);
  });

  it('no harness on the route, or no observation for the harness', () => {
    expect(recheck([route({ harness: null })], observed(), baseState()).checks[0]!.notes).toContain('agent unknown: the route names no harness');
    expect(recheck([route({ harness: 'codex' })], observed(), baseState()).checks[0]!.notes).toContain('agent unknown: no observation for harness codex');
  });
});

describe('recheck: the state', () => {
  it('drops routes that are no longer live and keeps the baseline of a marked route', () => {
    const s = baseState();
    s.routes['11111111-1111-4111-8111-111111111111'] = { ...s.routes[ID]! };
    const r = recheck([route()], observed({ models: { digest: H('e') } }), s);
    expect(Object.keys(r.nextState.routes)).toEqual([ID]);
    expect(r.nextState.routes[ID]!.models_digest).toBe(H('d'));
  });

  it('is pure: the input state is not changed', () => {
    const s = baseState();
    const copy = JSON.parse(JSON.stringify(s));
    recheck([route()], observed({ mix: { window_days: 14, total: 1, shares: {} }, graders: {} }), s);
    expect(s).toEqual(copy);
  });

  it('validateRecheckState accepts a written state and refuses a bad one', () => {
    expect(validateRecheckState(baseState()).ok).toBe(true);
    expect(validateRecheckState(emptyRecheckState()).ok).toBe(true);
    expect(validateRecheckState({ format: 'x', routes: {} }).ok).toBe(false);
    expect(validateRecheckState({ ...baseState(), extra: 1 }).ok).toBe(false);
    const bad = baseState();
    (bad.routes[ID] as any).models_digest = 'abc';
    expect(validateRecheckState(bad).ok).toBe(false);
    expect(validateRecheckState({ format: 'tma-route-recheck-state/1', routes: { 'not-a-uuid': baseState().routes[ID] } }).ok).toBe(false);
  });
});

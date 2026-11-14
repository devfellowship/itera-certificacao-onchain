// The pure parts of the nightly regression (T6): verdict, held-out proof, state file. Invented values only.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Route } from '@itera/contracts';
import { DEFAULT_BARS, DEFAULT_MARGIN, DEFAULT_MIN_RUNS, heldOutNote, nightVerdict, validateNightlyState, type GoldenRun } from './nightly.js';

const LIVE = JSON.parse(readFileSync(join(resolve(import.meta.dirname, '../../../examples/route'), 'route.live.json'), 'utf-8')) as Route;
const BARS = { ...DEFAULT_BARS, minRuns: DEFAULT_MIN_RUNS, margin: DEFAULT_MARGIN };
const runs = (scores: number[], over: Partial<GoldenRun> = {}): GoldenRun[] => scores.map((score, i) => ({ case_key: `case-${i % 2}`, score, hardGatesOk: true, infraOk: true, ...over }));

describe('nightVerdict', () => {
  it('absolute: a failed hard gate is NOT YET (a drop) even with high scores', () => {
    const v = nightVerdict(LIVE, [...runs([99, 99, 99, 99]), { case_key: 'case-0', score: 99, hardGatesOk: false, infraOk: true }], BARS, null);
    expect(v).toMatchObject({ kind: 'compared', label: 'NOT YET', drop: true });
  });
  it('absolute: infra failures and runs without a score are left out', () => {
    const v = nightVerdict(LIVE, [...runs([99, 99, 99, 99, 99]), ...runs([0], { infraOk: false }), ...runs([0], { score: null })], BARS, null);
    expect(v).toMatchObject({ kind: 'compared', label: 'SAME', drop: false });
  });
  it('relative: below the minimum n, no baseline is recorded', () => {
    expect(nightVerdict({ ...LIVE, picked_rule: 'relative' }, runs([80, 80]), BARS, null)).toMatchObject({ kind: 'refused' });
  });
  it('relative: better is not a drop', () => {
    const v = nightVerdict({ ...LIVE, picked_rule: 'relative' }, runs([90, 91, 92, 93, 94, 95]), BARS, { 'case-0': [50, 51, 52], 'case-1': [50, 51, 52] });
    expect(v).toMatchObject({ kind: 'compared', label: 'better', drop: false });
  });
});

describe('heldOutNote', () => {
  it('a route with no evidence run is unprovable', () => {
    expect(heldOutNote({ ...LIVE, evidence_run_ids: [] }, [], [], [])).toMatch(/^held_out_unprovable/);
  });
  it('unreadable eval cases are unprovable', () => {
    const rows = LIVE.evidence_run_ids.map((id) => ({ id, caseId: 'c', caseKey: 'k-k' }));
    expect(heldOutNote(LIVE, [], rows, null)).toBe('held_out_unprovable: the eval cases could not be read');
  });
});

describe('validateNightlyState', () => {
  const ok = { format: 'tma-route-nightly-state/1', routes: { [LIVE.id]: { baseline: { 'case-a1': [80] }, last_run_at: '2026-11-13T03:00:00.000Z', last_label: 'NOT YET', last_scores: null } }, unuploaded_paid_runs: 0 };
  it('accepts a good file', () => expect(validateNightlyState(ok).ok).toBe(true));
  it('refuses an unknown key, a bad score, a negative count', () => {
    expect(validateNightlyState({ ...ok, extra: 1 }).ok).toBe(false);
    expect(validateNightlyState({ ...ok, unuploaded_paid_runs: -1 }).ok).toBe(false);
    expect(validateNightlyState({ ...ok, routes: { [LIVE.id]: { ...ok.routes[LIVE.id], baseline: { 'case-a1': [101] } } } }).ok).toBe(false);
    expect(validateNightlyState({ ...ok, routes: { 'not-a-uuid': ok.routes[LIVE.id] } }).ok).toBe(false);
  });
});

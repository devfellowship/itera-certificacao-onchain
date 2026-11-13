// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
import { describe, expect, it } from 'vitest';
import {
  isSwapPending,
  ROUTE_FORMAT, ROUTE_FORMAT_V1, ROUTE_FORMAT_V2, ROUTE_MAX_BYTES, parseRouteText, routeSchema, routeSchemaV2, routeVerdictPasses, validateRoute,
} from './index.js';

// Synthetic fixture: invented ids and hashes only.
const H = (c: string) => c.repeat(64);
const route = (over: Record<string, unknown> = {}): Record<string, any> => ({
  id: '1a2b3c4d-0000-4000-8000-000000000001',
  tenant: 'dfl',
  use_case_key: 'content/report-html',
  route_target: 'env:DFL_ROUTE_HTML_REPORT',
  target_value: 'sonnet',
  rollback_value: 'deepseek',
  model_id: 'claude-sonnet-5-5',
  agent_sha256: H('a'),
  fallback_model_id: null,
  picked_rule: 'absolute',
  verdict: 'same',
  n: 5,
  evidence_run_ids: ['1a2b3c4d-0000-4000-8000-0000000000aa'],
  compare_profile_sha256: H('b'),
  policy_version: 'c7-1',
  state: 'approved',
  pr_url: null,
  approved_by_actor: 'example-approver',
  approved_at: '2026-11-12T18:30:00Z',
  ...over,
});

describe('tma-route/1', () => {
  it('accepts a valid approved route, with or without format', () => {
    expect(validateRoute(route()).ok).toBe(true);
    expect(validateRoute(route({ format: 'tma-route/1', pr_url: 'https://github.com/devfellowship/dfl-infra/pull/12' })).ok).toBe(true);
    expect(routeSchema.additionalProperties).toBe(false);
  });

  it('refuses an unknown key (closed schema)', () => {
    const r = validateRoute(route({ note: 'free text' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toMatchObject({ code: 'unknown_key', path: '/note' });
  });

  it('refuses a value that could break a .env line or a Markdown cell', () => {
    for (const v of ['son net', 'a\nB=1', 'x`y', '"q"', '']) expect(validateRoute(route({ target_value: v })).ok).toBe(false);
  });

  it('refuses a bad target, use case, state or rule', () => {
    expect(validateRoute(route({ route_target: 'file:/etc/passwd' })).ok).toBe(false);
    expect(validateRoute(route({ use_case_key: 'content' })).ok).toBe(false);
    expect(validateRoute(route({ state: 'done' })).ok).toBe(false);
    expect(validateRoute(route({ picked_rule: 'majority' })).ok).toBe(false);
  });

  it('an approved route names its approver and time; a proposed one may not', () => {
    const r = validateRoute(route({ approved_by_actor: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toMatchObject({ code: 'inconsistent', path: '/approved_by_actor' });
    expect(validateRoute(route({ state: 'proposed', approved_by_actor: null, approved_at: null })).ok).toBe(true);
  });

  it('passing verdicts per rule', () => {
    expect(routeVerdictPasses('absolute', 'same')).toBe(true);
    expect(routeVerdictPasses('absolute', 'close')).toBe(true);
    expect(routeVerdictPasses('absolute', 'better')).toBe(false);
    expect(routeVerdictPasses('absolute', 'NOT YET')).toBe(false);
    expect(routeVerdictPasses('relative', 'Better')).toBe(true);
    expect(routeVerdictPasses('relative', 'close')).toBe(false);
    expect(routeVerdictPasses('other', 'same')).toBe(false);
  });

  it('parseRouteText refuses non-JSON and a too large text', () => {
    expect(parseRouteText('{').ok).toBe(false);
    expect(parseRouteText(' '.repeat(ROUTE_MAX_BYTES + 1)).ok).toBe(false);
    expect(parseRouteText(JSON.stringify(route())).ok).toBe(true);
  });
});

const PR = (n: number) => `https://github.com/example-org/infra/pull/${n}`;
const v2 = (over: Record<string, unknown> = {}): Record<string, any> =>
  route({ format: 'tma-route/2', policy_version: 'c8-1', live_at: null, rollback_pr_url: null, rolled_back_at: null, ...over });
const issuesOf = (value: unknown) => {
  const r = validateRoute(value);
  return r.ok ? [] : r.issues;
};

describe('tma-route/2', () => {
  it('exports both formats; the current one is tma-route/2; both schemas are closed', () => {
    expect(ROUTE_FORMAT_V1).toBe('tma-route/1');
    expect(ROUTE_FORMAT_V2).toBe('tma-route/2');
    expect(ROUTE_FORMAT).toBe(ROUTE_FORMAT_V2);
    expect(routeSchemaV2.additionalProperties).toBe(false);
    expect(routeSchemaV2.$id).toMatch(/route-v2\.schema\.json$/);
    expect(routeSchemaV2.required).toEqual(expect.arrayContaining(['format', 'live_at', 'rollback_pr_url', 'rolled_back_at']));
  });

  it('accepts a valid approved, live and rolled_back row', () => {
    expect(issuesOf(v2())).toEqual([]);
    expect(issuesOf(v2({ state: 'live', pr_url: PR(1), live_at: '2026-11-13T10:00:00Z' }))).toEqual([]);
    expect(
      issuesOf(v2({ state: 'rolled_back', pr_url: PR(1), live_at: '2026-11-13T10:00:00Z', rollback_pr_url: PR(2), rolled_back_at: '2026-11-13T11:00:00.123Z' })),
    ).toEqual([]);
    expect(issuesOf(v2({ state: 'proposed', approved_by_actor: null, approved_at: null }))).toEqual([]);
  });

  it('refuses a v2 row without one of the three keys', () => {
    for (const k of ['live_at', 'rollback_pr_url', 'rolled_back_at']) {
      const r = v2();
      delete r[k];
      const issues = issuesOf(r);
      expect(issues.length, k).toBeGreaterThan(0);
      expect(issues[0]).toMatchObject({ code: 'invalid' });
    }
  });

  it('refuses a v2 row without format (it is read as v1, which has no live_at)', () => {
    const r = v2();
    delete r.format;
    expect(issuesOf(r).map((i) => i.code)).toContain('unknown_key');
  });

  it('a live row needs pr_url and live_at', () => {
    expect(issuesOf(v2({ state: 'live', pr_url: PR(1), live_at: null }))).toEqual([
      expect.objectContaining({ code: 'inconsistent', path: '/live_at' }),
    ]);
    expect(issuesOf(v2({ state: 'live', pr_url: null, live_at: '2026-11-13T10:00:00Z' }))).toEqual([
      expect.objectContaining({ code: 'inconsistent', path: '/pr_url' }),
    ]);
    const noPr = v2({ state: 'live', live_at: '2026-11-13T10:00:00Z' });
    delete noPr.pr_url;
    expect(issuesOf(noPr)).toEqual([expect.objectContaining({ code: 'inconsistent', path: '/pr_url' })]);
  });

  it('a rolled_back row needs rollback_pr_url and rolled_back_at', () => {
    const base = { state: 'rolled_back', pr_url: PR(1), live_at: '2026-11-13T10:00:00Z' };
    expect(issuesOf(v2({ ...base, rollback_pr_url: null, rolled_back_at: '2026-11-13T11:00:00Z' }))).toEqual([
      expect.objectContaining({ code: 'inconsistent', path: '/rollback_pr_url' }),
    ]);
    expect(issuesOf(v2({ ...base, rollback_pr_url: PR(2), rolled_back_at: null }))).toEqual([
      expect.objectContaining({ code: 'inconsistent', path: '/rolled_back_at' }),
    ]);
  });

  it('refuses a bad rollback PR URL or timestamp', () => {
    expect(validateRoute(v2({ rollback_pr_url: 'https://example.com/pull/1' })).ok).toBe(false);
    expect(validateRoute(v2({ live_at: '2026-11-13' })).ok).toBe(false);
  });

  it('refuses an unknown key (closed schema)', () => {
    expect(issuesOf(v2({ note: 'x' }))[0]).toMatchObject({ code: 'unknown_key', path: '/note' });
  });

  it('a v1 row stays exactly as before: no format and format tma-route/1 validate; v1 with live_at is refused', () => {
    expect(issuesOf(route())).toEqual([]);
    expect(issuesOf(route({ format: 'tma-route/1' }))).toEqual([]);
    // v1 has no live/rolled_back column checks.
    expect(issuesOf(route({ state: 'live', pr_url: null }))).toEqual([]);
    expect(issuesOf(route({ format: 'tma-route/1', live_at: '2026-11-13T10:00:00Z' }))[0]).toMatchObject({ code: 'unknown_key', path: '/live_at' });
    expect(issuesOf(route({ live_at: null }))[0]).toMatchObject({ code: 'unknown_key', path: '/live_at' });
  });

  it('refuses an unknown format', () => {
    expect(validateRoute(route({ format: 'tma-route/3' })).ok).toBe(false);
    expect(validateRoute(v2({ format: 'tma-route/3' })).ok).toBe(false);
    expect(validateRoute(null).ok).toBe(false);
  });

  it('parseRouteText reads a v2 row', () => {
    expect(parseRouteText(JSON.stringify(v2())).ok).toBe(true);
  });
});

describe('isSwapPending (Q d881e5df = C)', () => {
  it('is true only for state approved with a pr_url', () => {
    const pr = 'https://github.com/example-org/infra/pull/7';
    expect(isSwapPending({ state: 'approved', pr_url: pr })).toBe(true);
    expect(isSwapPending({ state: 'approved', pr_url: null })).toBe(false);
    expect(isSwapPending({ state: 'approved', pr_url: '' })).toBe(false);
    for (const state of ['proposed', 'live', 'needs_check', 'rolled_back']) expect(isSwapPending({ state, pr_url: pr })).toBe(false);
    expect(isSwapPending(null)).toBe(false);
    expect(isSwapPending(undefined)).toBe(false);
  });
});

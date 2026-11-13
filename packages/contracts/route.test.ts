// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
import { describe, expect, it } from 'vitest';
import { ROUTE_MAX_BYTES, parseRouteText, routeSchema, routeVerdictPasses, validateRoute } from './index.js';

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

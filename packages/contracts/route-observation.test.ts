// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
import { describe, expect, it } from 'vitest';
import {
  ROUTE_OBSERVATION_FORMAT, ROUTE_OBSERVATION_MAX_BYTES, parseRouteObservationText, routeObservationSchema, validateRouteObservation,
} from './index.js';

// Synthetic fixture: invented digests only.
const H = (c: string) => c.repeat(64);
const G = (c: string) => c.repeat(40);
const obs = (over: Record<string, unknown> = {}): Record<string, any> => ({
  format: 'tma-route-observation/1',
  observed_at: '2026-11-13T06:00:00Z',
  models: { digest: H('1') },
  mix: { window_days: 14, total: 120, shares: { 'content/report-html': 25, 'plan/write-plan': 12.5 } },
  graders: { 'content/report-html': { 'html-structure': '1.2.0', 'judge/visual': '0.3.1-rc.1' } },
  agents: { 'claude-code': { harness_repo_sha: G('a'), rules_sha256: H('b'), skills_sha256: H('c') }, codex: { harness_repo_sha: null, rules_sha256: null, skills_sha256: null } },
  ...over,
});

describe('tma-route-observation/1', () => {
  it('accepts a valid observation, an empty one and nulls', () => {
    expect(ROUTE_OBSERVATION_FORMAT).toBe('tma-route-observation/1');
    expect(validateRouteObservation(obs()).ok).toBe(true);
    expect(validateRouteObservation(obs({ mix: { window_days: 14, total: 0, shares: {} }, graders: {}, agents: {} })).ok).toBe(true);
    expect(routeObservationSchema.additionalProperties).toBe(false);
  });

  it('is closed at every level', () => {
    for (const bad of [
      obs({ note: 'free text' }),
      obs({ models: { digest: H('1'), note: 'x' } }),
      obs({ mix: { window_days: 14, total: 1, shares: {}, extra: 1 } }),
      obs({ agents: { 'claude-code': { harness_repo_sha: null, rules_sha256: null, skills_sha256: null, model: 'x' } } }),
    ]) {
      const r = validateRouteObservation(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.some((i) => i.code === 'unknown_key')).toBe(true);
    }
  });

  it('refuses a missing key or a missing agent digest key', () => {
    const { graders: _g, ...noGraders } = obs();
    expect(validateRouteObservation(noGraders).ok).toBe(false);
    expect(validateRouteObservation(obs({ agents: { codex: { harness_repo_sha: null, rules_sha256: null } } })).ok).toBe(false);
  });

  it('refuses a bad pattern, range or enum', () => {
    const bad: Array<Record<string, unknown>> = [
      { format: 'tma-route-observation/2' },
      { observed_at: 'yesterday' },
      { models: { digest: 'abc' } },
      { models: { digest: H('A') } },
      { mix: { window_days: 7, total: 1, shares: {} } },
      { mix: { window_days: 14, total: -1, shares: {} } },
      { mix: { window_days: 14, total: 1.5, shares: {} } },
      { mix: { window_days: 14, total: 1, shares: { content: 5 } } },
      { mix: { window_days: 14, total: 1, shares: { 'content/x': 100.5 } } },
      { mix: { window_days: 14, total: 1, shares: { 'content/x': -1 } } },
      { graders: { 'content/x': { 'Bad Id': '1.0.0' } } },
      { graders: { 'content/x': { g: '1.0' } } },
      { graders: { 'content/x': { g: 'v1.0.0' } } },
      { graders: { 'content/x': { g: '1.0.0 beta' } } },
      { graders: { 'content x': { g: '1.0.0' } } },
      { agents: { cursor: { harness_repo_sha: null, rules_sha256: null, skills_sha256: null } } },
      { agents: { codex: { harness_repo_sha: G('a').slice(0, 39), rules_sha256: null, skills_sha256: null } } },
      { agents: { codex: { harness_repo_sha: null, rules_sha256: null, skills_sha256: [H('c')] } } },
    ];
    for (const over of bad) expect(validateRouteObservation(obs(over)).ok, JSON.stringify(over)).toBe(false);
  });

  it('enforces the limits: 200 pairs, 50 graders per pair', () => {
    const pairs = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`t/p${i}`, 0]));
    expect(validateRouteObservation(obs({ mix: { window_days: 14, total: 1, shares: pairs(200) } })).ok).toBe(true);
    expect(validateRouteObservation(obs({ mix: { window_days: 14, total: 1, shares: pairs(201) } })).ok).toBe(false);
    const graders = (n: number) => ({ 't/p': Object.fromEntries(Array.from({ length: n }, (_, i) => [`g${i}`, '1.0.0'])) });
    expect(validateRouteObservation(obs({ graders: graders(50) })).ok).toBe(true);
    expect(validateRouteObservation(obs({ graders: graders(51) })).ok).toBe(false);
    expect(validateRouteObservation(obs({ graders: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`t/p${i}`, {}])) })).ok).toBe(false);
  });

  it('parseRouteObservationText: not JSON, too large, valid', () => {
    expect(parseRouteObservationText('{').ok).toBe(false);
    const big = parseRouteObservationText(' '.repeat(ROUTE_OBSERVATION_MAX_BYTES + 1));
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.issues[0]!.code).toBe('too_large');
    expect(parseRouteObservationText(JSON.stringify(obs())).ok).toBe(true);
  });
});

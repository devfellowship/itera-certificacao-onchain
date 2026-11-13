// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// trajectory-shapes/1 (plan 20261112-tma-c9-trajectory-analytics, T3): every golden fixture, the coverage of the spec
// tables, the wall-only fallback, and the Python reference checker on the same spec + fixtures.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  STEP_KINDS,
  TRAJECTORY_SHAPES_SPEC as SPEC,
  firstFailure,
  kindOfStep,
  kindString,
  pathMap,
  shapeOf,
  type FirstFailure,
  type ShapeStep,
} from './index.js';

interface ShapeCase {
  name: string;
  input: { steps: ShapeStep[] };
  expect: { kind_string: string; truncated: boolean; shape: string; first_failure: FirstFailure | null };
}
interface PathMapCase {
  name: string;
  kind_strings: string[];
  expect: { nodes: Array<{ path: string; n: number }> };
}
const fixtures = JSON.parse(readFileSync(new URL('./trajectory-shapes/fixtures.json', import.meta.url), 'utf-8')) as {
  schema: string;
  cases: ShapeCase[];
  path_map_cases: PathMapCase[];
};

describe('trajectory-shapes/1 golden fixtures', () => {
  it('has at least 25 cases and 4 path map cases, on the same schema as the spec', () => {
    expect(fixtures.schema).toBe(SPEC.schema);
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(25);
    expect(fixtures.path_map_cases.length).toBeGreaterThanOrEqual(4);
  });
  for (const c of fixtures.cases) {
    it(c.name, () => {
      const ks = kindString(c.input.steps);
      expect({ ...ks, shape: shapeOf(ks.kind_string), first_failure: firstFailure(c.input.steps) }).toEqual(c.expect);
    });
  }
  for (const c of fixtures.path_map_cases) {
    it(`path map: ${c.name}`, () => {
      expect(pathMap(c.kind_strings)).toEqual(c.expect);
    });
  }
});

describe('trajectory-shapes/1 spec tables', () => {
  it('step_kind_map covers exactly the tma-trajectory/2 STEP_KINDS', () => {
    expect(Object.keys(SPEC.step_kind_map).sort()).toEqual([...STEP_KINDS].sort());
  });
  it('intent_map keys + the fallback intents (other, unlabeled) equal the 28 layer-1 intents', () => {
    expect(SPEC.layer1_intents).toHaveLength(28);
    expect(new Set(SPEC.layer1_intents).size).toBe(28);
    expect(SPEC.tool_fallback.applies_to.sort()).toEqual(['other', 'unlabeled']);
    expect([...Object.keys(SPEC.intent_map), ...SPEC.tool_fallback.applies_to].sort()).toEqual([...SPEC.layer1_intents].sort());
  });
  it('every letter in a table is in the alphabet', () => {
    const letters = new Set(Object.keys(SPEC.alphabet));
    const fb = SPEC.tool_fallback;
    for (const l of [...Object.values(SPEC.step_kind_map), ...Object.values(SPEC.intent_map), ...Object.values(fb.family), ...Object.values(fb.tool), fb.default]) {
      expect(letters.has(l), l).toBe(true);
    }
  });
  it('the fixtures use every intent, every step_kind and every fallback tool and family', () => {
    const steps = fixtures.cases.flatMap((c) => c.input.steps);
    const used = (src: string) => new Set(steps.filter((s) => s.kind_source === src).map((s) => s.value));
    expect([...used('intent')].sort()).toEqual([...SPEC.layer1_intents].sort());
    expect([...used('step_kind')].sort()).toEqual([...STEP_KINDS].sort());
    const fbSteps = steps.filter((s) => s.kind_source === 'intent' && SPEC.tool_fallback.applies_to.includes(s.value));
    for (const tool of Object.keys(SPEC.tool_fallback.tool)) expect(fbSteps.some((s) => s.tool === tool && !(s.family !== undefined && s.family in SPEC.tool_fallback.family)), tool).toBe(true);
    for (const family of Object.keys(SPEC.tool_fallback.family)) expect(fbSteps.some((s) => s.family === family), family).toBe(true);
  });
  it('the fixtures reach every shape', () => {
    const shapes = new Set(fixtures.cases.map((c) => c.expect.shape));
    for (const r of SPEC.shape_rules) expect(shapes.has(r.name), r.name).toBe(true);
    expect(shapes.has(SPEC.empty_shape)).toBe(true);
  });
  it('declares the wall-only fallback: named_shapes is false while the gate failed', () => {
    expect(SPEC.named_shapes).toBe(false);
    expect(SPEC.fallback).toBe('wall-only');
    expect(SPEC.gate).toMatchObject({ min_spread_points: 15, min_n_per_shape: 20, result: 'fail' });
  });
  it('refuses an unknown step_kind or intent', () => {
    expect(() => kindOfStep({ kind_source: 'step_kind', value: 'nope', ok: true })).toThrow(/unknown step_kind/);
    expect(() => kindOfStep({ kind_source: 'intent', value: 'nope', ok: true })).toThrow(/unknown intent/);
    expect(() => kindOfStep({ kind_source: 'intent', value: 'toString', ok: true })).toThrow(/unknown intent/);
  });
});

const python = spawnSync('python3', ['--version']).status === 0;
describe.skipIf(!python)('trajectory-shapes/1 Python reference checker', () => {
  it('passes every fixture (python3 -I check_fixtures.py)', () => {
    const script = fileURLToPath(new URL('./trajectory-shapes/check_fixtures.py', import.meta.url));
    const r = spawnSync('python3', ['-I', script], { encoding: 'utf-8' });
    expect(r.stdout + r.stderr).toMatch(/0 failed/);
    expect(r.status).toBe(0);
  });
});

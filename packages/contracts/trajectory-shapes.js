// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// trajectory-shapes/1 (plan 20261112-tma-c9-trajectory-analytics, T3, ADR-3, ADR-6): the kind string, shape,
// first failure and path map of a trajectory. Every table comes from trajectory-shapes/spec.json, the one source that
// the fleet snapshot (Python, trajectory-shapes/check_fixtures.py) also reads. A rule change = a spec version bump +
// new fixtures in trajectory-shapes/fixtures.json; both sides follow.
// While TRAJECTORY_SHAPES_SPEC.named_shapes is false (gate C9-T2 failed), a consumer MUST NOT label runs by shape.
import { readFileSync } from 'node:fs';

/** @type {import('./index.js').TrajectoryShapesSpec} */
export const TRAJECTORY_SHAPES_SPEC = Object.freeze(
  JSON.parse(readFileSync(new URL('./trajectory-shapes/spec.json', import.meta.url), 'utf-8')),
);
const SPEC = TRAJECTORY_SHAPES_SPEC;

/** @param {Record<string, string>} table @param {string | undefined} key */
function lookup(table, key) {
  return key !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/**
 * The letter of one step.
 * @param {import('./index.js').ShapeStep} step
 * @returns {string}
 */
export function kindOfStep(step) {
  if (step.kind_source === 'step_kind') {
    const letter = lookup(SPEC.step_kind_map, step.value);
    if (letter === undefined) throw new Error(`unknown step_kind ${step.value}`);
    return letter;
  }
  if (step.kind_source !== 'intent') throw new Error(`unknown kind_source ${String(step.kind_source)}`);
  const fb = SPEC.tool_fallback;
  if (fb.applies_to.includes(step.value)) {
    return lookup(fb.family, step.family) ?? lookup(fb.tool, step.tool) ?? fb.default;
  }
  const letter = lookup(SPEC.intent_map, step.value);
  if (letter === undefined) throw new Error(`unknown intent ${step.value}`);
  return letter;
}

/**
 * One letter per step, repeats kept, cut at spec.kind_string.max_chars.
 * @param {readonly import('./index.js').ShapeStep[]} steps
 * @returns {{ kind_string: string, truncated: boolean }}
 */
export function kindString(steps) {
  const full = steps.map(kindOfStep).join('');
  const cap = SPEC.kind_string.max_chars;
  return { kind_string: full.slice(0, cap), truncated: full.length > cap };
}

/** [start, end) of every maximal run of `letter`. @param {string} ks @param {string} letter */
function runsOf(ks, letter) {
  /** @type {Array<[number, number]>} */
  const out = [];
  for (let i = 0; i < ks.length; ) {
    if (ks[i] !== letter) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < ks.length && ks[j] === letter) j += 1;
    out.push([i, j]);
    i = j;
  }
  return out;
}

/** @param {import('./index.js').ShapeRule} rule @param {string} ks */
function ruleMatches(rule, ks) {
  switch (rule.name) {
    case 'test-loop': {
      const runs = runsOf(ks, /** @type {string} */ (rule.letter));
      if (runs.length < /** @type {number} */ (rule.min_runs)) return false;
      return runs.slice(1).some((r, i) => ks.slice(/** @type {[number, number]} */ (runs[i])[1], r[0]).includes(/** @type {string} */ (rule.between)));
    }
    case 'tool-storm':
      return runsOf(ks.slice(0, rule.window), /** @type {string} */ (rule.letter)).some(([s, e]) => e - s >= /** @type {number} */ (rule.min_run));
    case 'search-first':
      return ks.slice(0, 1) === rule.letter;
    case 'straight':
      return true;
    default:
      throw new Error(`unknown shape rule ${rule.name}`);
  }
}

/**
 * The shape of a kind string: the first matching rule of spec.shape_rules, or spec.empty_shape for ''.
 * Do not show it on a screen while TRAJECTORY_SHAPES_SPEC.named_shapes is false.
 * @param {string} ks
 * @returns {string}
 */
export function shapeOf(ks) {
  if (ks === '') return SPEC.empty_shape;
  for (const rule of SPEC.shape_rules) if (ruleMatches(rule, ks)) return rule.name;
  throw new Error(`no shape rule matched ${ks}`);
}

/**
 * The first step with ok = false (known limit: an MCP error payload that returns success counts as ok).
 * @param {readonly import('./index.js').ShapeStep[]} steps
 * @returns {import('./index.js').FirstFailure | null}
 */
export function firstFailure(steps) {
  const i = steps.findIndex((s) => s.ok === false);
  if (i < 0) return null;
  return {
    first_fail_seq: i,
    first_fail_kind: kindOfStep(/** @type {import('./index.js').ShapeStep} */ (steps[i])),
    last_good_kind: i === 0 ? SPEC.first_failure.start_token : kindOfStep(/** @type {import('./index.js').ShapeStep} */ (steps[i - 1])),
  };
}

/** @param {string} ks */
function collapse(ks) {
  let out = '';
  for (let i = 0; i < ks.length; i += 1) if (i === 0 || ks[i - 1] !== ks[i]) out += ks[i];
  return out;
}

/** Code-unit order, the same as Python's sorted() on these ASCII paths. @param {string} a @param {string} b */
function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The pruned prefix tree of many kind strings (spec.path_map_prune).
 * @param {readonly string[]} kindStrings
 * @returns {{ nodes: Array<{ path: string, n: number }> }}
 */
export function pathMap(kindStrings) {
  const p = SPEC.path_map_prune;
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const ks of kindStrings) {
    const path = p.collapse_repeats ? collapse(ks) : ks;
    for (let d = 1; d <= Math.min(path.length, p.max_depth); d += 1) {
      const key = path.slice(0, d);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const total = kindStrings.length;
  const nodes = [...counts]
    .filter(([, n]) => n >= p.min_runs && n * 100 >= p.min_share_pct * total)
    .map(([path, n]) => ({ path, n }))
    .sort((a, b) => byCodeUnit(a.path, b.path));
  return { nodes };
}

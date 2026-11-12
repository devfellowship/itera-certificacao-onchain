// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// The structural trajectory (tma-trajectory/1): one step per tool call of one run, structure, numbers
// and digests only (plan 20261112-tma-c4-result-store-trajectory-upload, T1, ADR-2 and ADR-3). The
// closed schema is schemas/trajectory.schema.json. A tma-local-result/2 run carries one of these; the
// API writes each step as a run_actions row. This file adds the checks a JSON Schema cannot say.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** @type {typeof import('ajv/dist/2020.js').default} */
const Ajv2020 = require('ajv/dist/2020.js');

export const TRAJECTORY_FORMAT = 'tma-trajectory/1';
/** The most steps (tool calls) that one run may carry. */
export const TRAJECTORY_MAX_STEPS = 2000;
/** The longest target_redacted. */
export const TRAJECTORY_MAX_TARGET = 120;
export const TOOL_FAMILIES = /** @type {const} */ (['builtin', 'shell', 'git', 'gh', 'ssh', 'web', 'skill-bash', 'mcp', 'agent', 'other']);
export const STEP_STATUSES = /** @type {const} */ (['ok', 'error', 'denied', 'timeout']);
export const STEP_ERROR_CLASSES = /** @type {const} */ ([
  'tool_error', 'invalid_args', 'not_found', 'permission', 'timeout', 'rate_limited', 'network', 'interrupted', 'other',
]);
export const TARGET_KINDS = /** @type {const} */ (['file', 'dir', 'url', 'host', 'repo', 'agent', 'skill', 'mcp', 'command', 'pattern', 'none']);

export const trajectorySchema = JSON.parse(readFileSync(new URL('./schemas/trajectory.schema.json', import.meta.url), 'utf-8'));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
const validateFn = ajv.compile(trajectorySchema);

/**
 * @typedef {{ code: 'unknown_key' | 'invalid' | 'inconsistent', path: string, message: string }} TrajectoryIssue
 */

/**
 * @param {import('ajv').ErrorObject[] | null | undefined} errors
 * @returns {TrajectoryIssue[]}
 */
function issuesOf(errors) {
  /** @type {TrajectoryIssue[]} */
  const out = [];
  for (const e of errors ?? []) {
    if (e.keyword === 'additionalProperties') {
      const key = /** @type {{ additionalProperty: string }} */ (e.params).additionalProperty;
      out.push({ code: 'unknown_key', path: `${e.instancePath}/${key}`, message: 'unknown key (a trajectory holds structure, numbers and digests only)' });
      continue;
    }
    out.push({ code: 'invalid', path: e.instancePath || '/', message: e.message ?? 'is invalid' });
  }
  return out;
}

/**
 * The cross-step rules of a schema-valid step list: seq is 1..n in order; parent_seq and retry_of
 * point to an earlier step; an ok step has no error_class and every other step has one; target_kind
 * none has no target and every other kind has one.
 * @param {ReadonlyArray<any>} steps
 * @param {string} [base] the JSON pointer of the step list, for the issue paths
 * @returns {TrajectoryIssue[]}
 */
export function trajectoryStepIssues(steps, base = '/steps') {
  /** @type {TrajectoryIssue[]} */
  const issues = [];
  steps.forEach((s, i) => {
    const at = `${base}/${i}`;
    if (s.seq !== i + 1) issues.push({ code: 'inconsistent', path: `${at}/seq`, message: `is ${s.seq}; steps are numbered 1..n in order, so it must be ${i + 1}` });
    if (s.parent_seq !== null && s.parent_seq >= s.seq) issues.push({ code: 'inconsistent', path: `${at}/parent_seq`, message: 'must point to an earlier step' });
    if (s.retry_of !== null && s.retry_of >= s.seq) issues.push({ code: 'inconsistent', path: `${at}/retry_of`, message: 'must point to an earlier step' });
    if (s.status === 'ok' && s.error_class !== null) issues.push({ code: 'inconsistent', path: `${at}/error_class`, message: 'must be null when status is ok' });
    if (s.status !== 'ok' && s.error_class === null) issues.push({ code: 'inconsistent', path: `${at}/error_class`, message: `must name the error class when status is ${s.status}` });
    if (s.target_kind === 'none' && s.target_redacted !== null) issues.push({ code: 'inconsistent', path: `${at}/target_redacted`, message: 'must be null when target_kind is none' });
    if (s.target_kind !== 'none' && s.target_redacted === null) issues.push({ code: 'inconsistent', path: `${at}/target_kind`, message: 'must be none when target_redacted is null' });
  });
  return issues;
}

/**
 * Validate a parsed tma-trajectory/1 record: the closed schema, then the cross-step rules.
 * @param {unknown} value
 */
export function validateTrajectory(value) {
  if (!validateFn(value)) {
    const issues = issuesOf(validateFn.errors);
    return { ok: /** @type {const} */ (false), issues, errors: issues.map((i) => `${i.path} ${i.message}`) };
  }
  const v = /** @type {any} */ (value);
  const issues = trajectoryStepIssues(v.steps);
  if (issues.length > 0) return { ok: /** @type {const} */ (false), issues, errors: issues.map((i) => `${i.path} ${i.message}`) };
  return { ok: /** @type {const} */ (true), value: v };
}

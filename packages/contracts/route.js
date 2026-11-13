// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// The route row (tma-route/1): one approved model route with the verdict it cites
// (plan 20261112-tma-c8-routing-from-evals, T1, T2, T4; ADR-4, ADR-5). The closed schema is
// schemas/route-v1.schema.json. This file adds the check a JSON Schema does not say well: a route past
// `proposed` names who approved it and when.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** @type {typeof import('ajv/dist/2020.js').default} */
const Ajv2020 = require('ajv/dist/2020.js');

export const ROUTE_FORMAT = 'tma-route/1';
/** The largest route text that parseRouteText accepts (64 KiB; 1000 evidence ids are about 39 KiB). */
export const ROUTE_MAX_BYTES = 64 * 1024;
export const ROUTE_STATES = /** @type {const} */ (['proposed', 'approved', 'live', 'needs_check', 'rolled_back']);
export const ROUTE_RULES = /** @type {const} */ (['absolute', 'relative']);
/** The verdicts that pass under each rule (C7 ADR-8; plan C8 ADR-5). Compared in lower case. */
export const ROUTE_PASSING_VERDICTS = Object.freeze({ absolute: Object.freeze(['same', 'close']), relative: Object.freeze(['better', 'same']) });
/** The smallest n per cell that may back a route (C7 ADR-8). */
export const ROUTE_MIN_N = 5;

export const routeSchema = JSON.parse(readFileSync(new URL('./schemas/route-v1.schema.json', import.meta.url), 'utf-8'));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
const validateFn = ajv.compile(routeSchema);

/**
 * @typedef {{ code: 'unknown_key' | 'invalid' | 'too_large' | 'not_json' | 'inconsistent', path: string, message: string }} RouteIssue
 */

/** @param {RouteIssue[]} issues */
function failed(issues) {
  return { ok: /** @type {const} */ (false), issues, errors: issues.map((i) => `${i.path} ${i.message}`) };
}

/**
 * True when the verdict passes under the picked rule.
 * @param {string} rule
 * @param {string} verdict
 */
export function routeVerdictPasses(rule, verdict) {
  const list = /** @type {Record<string, readonly string[]>} */ (ROUTE_PASSING_VERDICTS)[rule];
  return Array.isArray(list) && list.includes(String(verdict).trim().toLowerCase());
}

/**
 * Validate a parsed route row: the closed schema, then the approver of an approved route.
 * @param {unknown} value
 */
export function validateRoute(value) {
  if (!validateFn(value)) {
    /** @type {RouteIssue[]} */
    const issues = [];
    for (const e of validateFn.errors ?? []) {
      if (e.keyword === 'additionalProperties') {
        const key = /** @type {{ additionalProperty: string }} */ (e.params).additionalProperty;
        issues.push({ code: 'unknown_key', path: `${e.instancePath}/${key}`, message: 'unknown key (a route row holds identifiers, digests and numbers only)' });
      } else issues.push({ code: 'invalid', path: e.instancePath || '/', message: e.message ?? 'is invalid' });
    }
    return failed(issues);
  }
  const v = /** @type {any} */ (value);
  /** @type {RouteIssue[]} */
  const issues = [];
  if (v.state !== 'proposed') {
    if (v.approved_by_actor === null) issues.push({ code: 'inconsistent', path: '/approved_by_actor', message: `is null: a route in state ${v.state} names its approver` });
    if (v.approved_at === null) issues.push({ code: 'inconsistent', path: '/approved_at', message: `is null: a route in state ${v.state} has an approval time` });
  }
  if (issues.length > 0) return failed(issues);
  return { ok: /** @type {const} */ (true), value: v };
}

/**
 * Parse and validate the raw text of one route. Refuses a text above ROUTE_MAX_BYTES before it parses it.
 * @param {string} text
 */
export function parseRouteText(text) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > ROUTE_MAX_BYTES) return failed([{ code: 'too_large', path: '/', message: `is ${bytes} bytes; the limit is ${ROUTE_MAX_BYTES}` }]);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return failed([{ code: 'not_json', path: '/', message: 'is not JSON' }]);
  }
  return validateRoute(value);
}

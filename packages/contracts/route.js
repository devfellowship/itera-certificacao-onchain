// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// The route row: one approved model route with the verdict it cites
// (plan 20261112-tma-c8-routing-from-evals, T1, T2, T4; ADR-4, ADR-5; Q3 = A). Two closed schemas:
// schemas/route-v1.schema.json (tma-route/1, format optional) and schemas/route-v2.schema.json (tma-route/2 = /1 plus
// live_at, rollback_pr_url, rolled_back_at, format required). validateRoute picks the schema by `format`: tma-route/2
// → v2; tma-route/1 or no format → v1 (every /1 row and file stays readable). This file adds the checks a JSON Schema
// does not say well: a route past `proposed` names who approved it and when; in v2 a live route names pr_url and
// live_at, and a rolled_back route names rollback_pr_url and rolled_back_at (the eval_routes CHECKs of 0026).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** @type {typeof import('ajv/dist/2020.js').default} */
const Ajv2020 = require('ajv/dist/2020.js');

export const ROUTE_FORMAT_V1 = 'tma-route/1';
export const ROUTE_FORMAT_V2 = 'tma-route/2';
/** The current route format (what the API answers). */
export const ROUTE_FORMAT = ROUTE_FORMAT_V2;
/** The largest route text that parseRouteText accepts (64 KiB; 1000 evidence ids are about 39 KiB). */
export const ROUTE_MAX_BYTES = 64 * 1024;
export const ROUTE_STATES = /** @type {const} */ (['proposed', 'approved', 'live', 'needs_check', 'rolled_back']);
export const ROUTE_RULES = /** @type {const} */ (['absolute', 'relative']);
/** The verdicts that pass under each rule (C7 ADR-8; plan C8 ADR-5). Compared in lower case. */
export const ROUTE_PASSING_VERDICTS = Object.freeze({ absolute: Object.freeze(['same', 'close']), relative: Object.freeze(['better', 'same']) });
/** The smallest n per cell that may back a route (C7 ADR-8). */
export const ROUTE_MIN_N = 5;

/** The tma-route/1 schema. */
export const routeSchema = JSON.parse(readFileSync(new URL('./schemas/route-v1.schema.json', import.meta.url), 'utf-8'));
/** The tma-route/2 schema. */
export const routeSchemaV2 = JSON.parse(readFileSync(new URL('./schemas/route-v2.schema.json', import.meta.url), 'utf-8'));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
const validateV1 = ajv.compile(routeSchema);
const validateV2 = ajv.compile(routeSchemaV2);

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
 * The schema validator for this row: tma-route/2 → v2; anything else (tma-route/1, no format, an unknown format) → v1,
 * which refuses an unknown format through its const.
 * @param {unknown} value
 */
function validatorOf(value) {
  const format = value !== null && typeof value === 'object' && !Array.isArray(value) ? /** @type {any} */ (value).format : undefined;
  return format === ROUTE_FORMAT_V2 ? validateV2 : validateV1;
}

/**
 * Validate a parsed route row: the closed schema of its format, then the approver of an approved route, and in v2
 * the apply-path columns of a live or rolled_back route.
 * @param {unknown} value
 */
export function validateRoute(value) {
  const validateFn = validatorOf(value);
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
  if (v.format === ROUTE_FORMAT_V2) {
    /** @param {string} key @param {string} why */
    const need = (key, why) => {
      if (v[key] === null || v[key] === undefined) issues.push({ code: 'inconsistent', path: `/${key}`, message: `is null: a route in state ${v.state} ${why}` });
    };
    if (v.state === 'live') {
      need('pr_url', 'names the PR that applied it');
      need('live_at', 'has a live time');
    }
    if (v.state === 'rolled_back') {
      need('rollback_pr_url', 'names the PR that rolled it back');
      need('rolled_back_at', 'has a rollback time');
    }
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

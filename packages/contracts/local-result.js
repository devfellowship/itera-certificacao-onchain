// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// The self-declared local result (tma-local-result/1): the ONE body that POST /self-declared-results
// accepts (plan 20261026-tma-local-runner-and-self-declared-results, ADR-1). Numbers and identifiers
// only. The closed schema is schemas/local-result.schema.json (a port of the retired operator import's
// parser, services/runner/src/bench-import.ts). This file adds the checks a JSON Schema cannot say.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isProviderKey, isRouteKey, PROVIDER_KEYS, ROUTE_KEYS } from './model-catalog.js';

const require = createRequire(import.meta.url);
/** @type {typeof import('ajv/dist/2020.js').default} */
const Ajv2020 = require('ajv/dist/2020.js');

export const LOCAL_RESULT_FORMAT = 'tma-local-result/1';
/** The largest body that the API accepts (1 MiB, the route limit of POST /self-declared-results). */
export const LOCAL_RESULT_MAX_BYTES = 1024 * 1024;
export const METRICS_SHAPES = /** @type {const} */ (['tma-score/1', 'transcript-mining/1', 'trajectory/1']);

export const localResultSchema = JSON.parse(readFileSync(new URL('./schemas/local-result.schema.json', import.meta.url), 'utf-8'));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
const validateFn = ajv.compile(localResultSchema);

/**
 * @typedef {{ code: 'unknown_key' | 'invalid' | 'too_large' | 'not_json' | 'unknown_provider' | 'unknown_route' | 'inconsistent', path: string, message: string }} LocalResultIssue
 */

/**
 * @param {import('ajv').ErrorObject[] | null | undefined} errors
 * @returns {LocalResultIssue[]}
 */
function issuesOf(errors) {
  /** @type {LocalResultIssue[]} */
  const out = [];
  for (const e of errors ?? []) {
    // `if` only reports that its `then` failed; the `then` errors themselves carry the detail.
    if (e.keyword === 'if') continue;
    if (e.keyword === 'additionalProperties') {
      const key = /** @type {{ additionalProperty: string }} */ (e.params).additionalProperty;
      out.push({ code: 'unknown_key', path: `${e.instancePath}/${key}`, message: 'unknown key (a local result holds numbers and identifiers only)' });
      continue;
    }
    out.push({ code: 'invalid', path: e.instancePath || '/', message: e.message ?? 'is invalid' });
  }
  return out;
}

/** @param {LocalResultIssue[]} issues */
function failed(issues) {
  return { ok: /** @type {const} */ (false), issues, errors: issues.map((i) => `${i.path} ${i.message}`) };
}

/**
 * Validate a parsed local result: the closed schema, then the catalog enums (provider, route) and the
 * cross-field rules (summary.runs = the length of runs, ran_from <= ran_to).
 * @param {unknown} value
 */
export function validateLocalResult(value) {
  if (!validateFn(value)) return failed(issuesOf(validateFn.errors));
  const v = /** @type {any} */ (value);
  /** @type {LocalResultIssue[]} */
  const issues = [];
  if (v.executor.provider !== null && !isProviderKey(v.executor.provider)) {
    issues.push({ code: 'unknown_provider', path: '/executor/provider', message: `must be one of ${PROVIDER_KEYS.join(', ')} or null` });
  }
  if (!isRouteKey(v.executor.route)) {
    issues.push({ code: 'unknown_route', path: '/executor/route', message: `must be one of ${ROUTE_KEYS.join(', ')}` });
  }
  if (v.summary.runs !== v.runs.length) {
    issues.push({ code: 'inconsistent', path: '/summary/runs', message: `says ${v.summary.runs}, the list has ${v.runs.length}` });
  }
  if (Date.parse(v.ran_from) > Date.parse(v.ran_to)) {
    issues.push({ code: 'inconsistent', path: '/ran_from', message: 'is after ran_to' });
  }
  if (issues.length > 0) return failed(issues);
  return { ok: /** @type {const} */ (true), value: v };
}

/**
 * Parse and validate the raw text of a local result (a CLI file, a request body). Refuses a text
 * above LOCAL_RESULT_MAX_BYTES before it parses it.
 * @param {string} text
 */
export function parseLocalResultText(text) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > LOCAL_RESULT_MAX_BYTES) {
    return failed([{ code: 'too_large', path: '/', message: `is ${bytes} bytes; the limit is ${LOCAL_RESULT_MAX_BYTES}` }]);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return failed([{ code: 'not_json', path: '/', message: 'is not JSON' }]);
  }
  return validateLocalResult(value);
}

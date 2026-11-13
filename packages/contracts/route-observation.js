// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// The route observation (plan 20261112-tma-c8-routing-from-evals, T5; ADR-3, ADR-7): what a host-side collector
// observed today, for `tma route recheck`. One closed schema: schemas/route-observation-v1.schema.json
// (tma-route-observation/1). Digests, numbers and short tokens only.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** @type {typeof import('ajv/dist/2020.js').default} */
const Ajv2020 = require('ajv/dist/2020.js');

export const ROUTE_OBSERVATION_FORMAT = 'tma-route-observation/1';
/** The largest observation text that parseRouteObservationText accepts (1 MiB). */
export const ROUTE_OBSERVATION_MAX_BYTES = 1024 * 1024;

/** The tma-route-observation/1 schema. */
export const routeObservationSchema = JSON.parse(readFileSync(new URL('./schemas/route-observation-v1.schema.json', import.meta.url), 'utf-8'));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
const validateFn = ajv.compile(routeObservationSchema);

/**
 * @typedef {{ code: 'unknown_key' | 'invalid' | 'too_large' | 'not_json', path: string, message: string }} RouteObservationIssue
 */

/** @param {RouteObservationIssue[]} issues */
function failed(issues) {
  return { ok: /** @type {const} */ (false), issues, errors: issues.map((i) => `${i.path} ${i.message}`) };
}

/**
 * Validate a parsed route observation against the closed schema.
 * @param {unknown} value
 */
export function validateRouteObservation(value) {
  if (validateFn(value)) return { ok: /** @type {const} */ (true), value: /** @type {any} */ (value) };
  /** @type {RouteObservationIssue[]} */
  const issues = [];
  for (const e of validateFn.errors ?? []) {
    if (e.keyword === 'additionalProperties') {
      const key = /** @type {{ additionalProperty: string }} */ (e.params).additionalProperty;
      issues.push({ code: 'unknown_key', path: `${e.instancePath}/${key}`, message: 'unknown key (an observation holds digests, numbers and short tokens only)' });
    } else issues.push({ code: 'invalid', path: e.instancePath || '/', message: e.message ?? 'is invalid' });
  }
  return failed(issues);
}

/**
 * Parse and validate the raw text of one observation. Refuses a text above ROUTE_OBSERVATION_MAX_BYTES first.
 * @param {string} text
 */
export function parseRouteObservationText(text) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > ROUTE_OBSERVATION_MAX_BYTES) return failed([{ code: 'too_large', path: '/', message: `is ${bytes} bytes; the limit is ${ROUTE_OBSERVATION_MAX_BYTES}` }]);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return failed([{ code: 'not_json', path: '/', message: 'is not JSON' }]);
  }
  return validateRouteObservation(value);
}

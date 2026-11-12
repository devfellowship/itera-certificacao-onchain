// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// The pin recipe (tma-pin/1): the context of one recorded agent session as a list of digests
// (plan 20261112-tma-c2-trace-selection-pin, T2; parent plan 20261112-tma-eval-studio-real-trace-evals,
// ADR-7). Digests and identifiers only. The closed schema is schemas/pin.schema.json. This file adds
// the checks a JSON Schema cannot say (skills_sha256 is sorted, pin_sha256 matches the record) and
// the canonical digest that a pin builder writes into pin_sha256.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** @type {typeof import('ajv/dist/2020.js').default} */
const Ajv2020 = require('ajv/dist/2020.js');

export const PIN_FORMAT = 'tma-pin/1';
/** The largest pin text that parsePinText accepts (64 KiB; 512 skill digests are about 35 KiB). */
export const PIN_MAX_BYTES = 64 * 1024;
/** The pinned fields. Each one has a completeness flag. */
export const PIN_FIELDS = /** @type {const} */ ([
  'repo',
  'base_sha',
  'harness',
  'harness_version',
  'harness_repo_sha',
  'rules_sha256',
  'skills_sha256',
  'model_id',
  'mcp_manifest_sha256',
  'input_sha256',
]);
export const PIN_COMPLETENESS = /** @type {const} */ (['exact', 'derived', 'missing']);

export const pinSchema = JSON.parse(readFileSync(new URL('./schemas/pin.schema.json', import.meta.url), 'utf-8'));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
const validateFn = ajv.compile(pinSchema);

/**
 * RFC 8785 (JCS) canonical JSON. Object keys sort by UTF-16 code units (the default string sort);
 * strings, numbers and literals serialize as JSON.stringify does, which is what JCS specifies.
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON has no NaN or Infinity');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot hold a ${typeof value}`);
}

/**
 * The canonical text that pin_sha256 digests: the JCS form of the record without the pin_sha256 key.
 * @param {Record<string, unknown>} record
 */
export function canonicalPinJson(record) {
  const { pin_sha256: _ignored, ...rest } = record;
  return canonicalJson(rest);
}

/**
 * sha256 (hex) of canonicalPinJson(record). Key order and a present pin_sha256 do not change it.
 * @param {Record<string, unknown>} record
 */
export function pinDigest(record) {
  return createHash('sha256').update(canonicalPinJson(record), 'utf8').digest('hex');
}

/**
 * Return the record with pin_sha256 set to its digest (for a pin builder).
 * @template {Record<string, unknown>} T
 * @param {T} record
 * @returns {T & { pin_sha256: string }}
 */
export function sealPin(record) {
  return { ...record, pin_sha256: pinDigest(record) };
}

/**
 * True when no completeness flag is missing (parent ADR-7: a partial pin is not used for replay).
 * @param {{ completeness: Record<string, string> }} pin a valid pin
 */
export function pinReplayable(pin) {
  return PIN_FIELDS.every((f) => pin.completeness[f] === 'exact' || pin.completeness[f] === 'derived');
}

/**
 * @typedef {{ code: 'unknown_key' | 'invalid' | 'too_large' | 'not_json' | 'inconsistent', path: string, message: string }} PinIssue
 */

/**
 * @param {import('ajv').ErrorObject[] | null | undefined} errors
 * @returns {PinIssue[]}
 */
function issuesOf(errors) {
  /** @type {PinIssue[]} */
  const out = [];
  for (const e of errors ?? []) {
    // `if` only reports that its `then` or `else` failed; those errors carry the detail.
    if (e.keyword === 'if') continue;
    if (e.keyword === 'additionalProperties') {
      const key = /** @type {{ additionalProperty: string }} */ (e.params).additionalProperty;
      out.push({ code: 'unknown_key', path: `${e.instancePath}/${key}`, message: 'unknown key (a pin holds digests and identifiers only)' });
      continue;
    }
    if (e.keyword === 'type' && e.schemaPath.includes('/then/')) {
      out.push({ code: 'inconsistent', path: e.instancePath, message: 'must be null: its completeness flag is missing' });
      continue;
    }
    if (e.keyword === 'not' && e.schemaPath.includes('/else/')) {
      out.push({ code: 'inconsistent', path: e.instancePath, message: 'is null: its completeness flag must be missing' });
      continue;
    }
    out.push({ code: 'invalid', path: e.instancePath || '/', message: e.message ?? 'is invalid' });
  }
  return out;
}

/** @param {PinIssue[]} issues */
function failed(issues) {
  return { ok: /** @type {const} */ (false), issues, errors: issues.map((i) => `${i.path} ${i.message}`) };
}

/**
 * Validate a parsed pin: the closed schema, then the order of skills_sha256 and the pin digest.
 * @param {unknown} value
 */
export function validatePin(value) {
  if (!validateFn(value)) return failed(issuesOf(validateFn.errors));
  const v = /** @type {any} */ (value);
  /** @type {PinIssue[]} */
  const issues = [];
  if (Array.isArray(v.skills_sha256)) {
    for (let i = 1; i < v.skills_sha256.length; i++) {
      if (v.skills_sha256[i - 1] > v.skills_sha256[i]) {
        issues.push({ code: 'inconsistent', path: `/skills_sha256/${i}`, message: 'the list must be sorted ascending' });
        break;
      }
    }
  }
  const digest = pinDigest(v);
  if (v.pin_sha256 !== digest) {
    issues.push({ code: 'inconsistent', path: '/pin_sha256', message: `does not match the record (expected ${digest})` });
  }
  if (issues.length > 0) return failed(issues);
  return { ok: /** @type {const} */ (true), value: v };
}

/**
 * Parse and validate the raw text of one pin. Refuses a text above PIN_MAX_BYTES before it parses it.
 * @param {string} text
 */
export function parsePinText(text) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > PIN_MAX_BYTES) {
    return failed([{ code: 'too_large', path: '/', message: `is ${bytes} bytes; the limit is ${PIN_MAX_BYTES}` }]);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return failed([{ code: 'not_json', path: '/', message: 'is not JSON' }]);
  }
  return validatePin(value);
}

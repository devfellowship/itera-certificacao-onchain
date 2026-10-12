// @itera/contracts — JSON Schemas (draft 2020-12) of the testmyagent contracts, and Ajv validators.
// Plain ESM JavaScript with a hand-written index.d.ts: no build step, so the runner (tsx), the
// evaluator CLI (tsx) and the API (tsc output) all import the same file.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** @type {typeof import('ajv/dist/2020.js').default} */
const Ajv2020 = require('ajv/dist/2020.js');

/** @param {string} name */
function loadSchema(name) {
  return JSON.parse(readFileSync(new URL(`./schemas/${name}`, import.meta.url), 'utf-8'));
}

export const taskSchema = loadSchema('task.schema.json');
export const evidenceManifestSchema = loadSchema('evidence-manifest.schema.json');
export const evidenceStatementSchema = loadSchema('evidence-statement.schema.json');
export const apiSchemas = {
  runDetail: loadSchema('api/run-detail.schema.json'),
  evaluationView: loadSchema('api/evaluation-view.schema.json'),
  evaluationList: loadSchema('api/evaluation-list.schema.json'),
};

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
ajv.addSchema(evidenceManifestSchema, 'evidence-manifest.json');
const validateTaskFn = ajv.compile(taskSchema);
const validateManifestFn = ajv.getSchema('evidence-manifest.json');
const validateStatementFn = ajv.compile(evidenceStatementSchema);
const apiValidators = Object.fromEntries(Object.entries(apiSchemas).map(([k, s]) => [k, ajv.compile(s)]));

/**
 * @param {import('ajv').ErrorObject[] | null | undefined} errors
 * @returns {string[]}
 */
function formatErrors(errors) {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`.trim());
}

/**
 * @param {import('ajv').ValidateFunction} fn
 * @param {unknown} value
 */
function check(fn, value) {
  if (fn(value)) return { ok: true, value: /** @type {any} */ (value) };
  return { ok: false, errors: formatErrors(fn.errors) };
}

/** Validate a parsed task.json against schemas/task.schema.json. @param {unknown} value */
export function validateTaskContract(value) {
  return check(validateTaskFn, value);
}

/** Validate a runs.evidence_manifest (the per-run EvalLog). @param {unknown} value */
export function validateEvidenceManifest(value) {
  return check(/** @type {any} */ (validateManifestFn), value);
}

/** True when the value is a graded EvalLog (replaces the old isGradedManifest guard). @param {unknown} value */
export function isEvidenceManifest(value) {
  return /** @type {any} */ (validateManifestFn)(value) === true;
}

/** Validate a pinned evidence document of schema itera-evidence/v2 (in-toto Statement v1). @param {unknown} value */
export function validateEvidenceStatement(value) {
  return check(validateStatementFn, value);
}

/**
 * Validate an API response body against schemas/api/<name>.
 * @param {'runDetail' | 'evaluationView' | 'evaluationList'} name
 * @param {unknown} value
 */
export function validateApiResponse(name, value) {
  const fn = apiValidators[name];
  if (!fn) throw new Error(`unknown API schema ${name}`);
  return check(fn, value);
}

/**
 * Operational state and verdict of a run, kept apart (analysis vocabulary).
 * @param {string} status runs.status
 * @param {{ result?: { state: string, verdict: string, scored: boolean } } | null | undefined} [manifest]
 * @returns {{ state: string, verdict: string | null, scored: boolean }}
 */
export function runResult(status, manifest) {
  if (manifest && manifest.result && typeof manifest.result.verdict === 'string') {
    const { state, verdict, scored } = manifest.result;
    return { state, verdict, scored };
  }
  switch (status) {
    case 'pending':
    case 'queued':
      return { state: 'queued', verdict: null, scored: false };
    case 'running':
      return { state: 'running', verdict: null, scored: false };
    case 'cancelled':
      return { state: 'cancelled', verdict: null, scored: false };
    case 'pass':
    case 'fail':
    case 'invalid':
      return { state: 'completed', verdict: status, scored: true };
    case 'timeout':
      // The agent ran out of time; its partial patch was graded. Same outcome as the evaluations
      // roll-up (timeout → INVALID).
      return { state: 'timeout', verdict: 'invalid', scored: true };
    default:
      // infra_error and anything unknown: the run measured nothing.
      return { state: 'infra_error', verdict: 'inconclusive', scored: false };
  }
}
export { validateRunProfile, runProfileSchema } from './run-profile.js';

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

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
const validateTaskFn = ajv.compile(taskSchema);

/**
 * @param {import('ajv').ErrorObject[] | null | undefined} errors
 * @returns {string[]}
 */
function formatErrors(errors) {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`.trim());
}

/**
 * Validate a parsed task.json against schemas/task.schema.json.
 * @param {unknown} value
 * @returns {{ ok: true, value: import('./index.js').TaskContract } | { ok: false, errors: string[] }}
 */
export function validateTaskContract(value) {
  if (validateTaskFn(value)) return { ok: true, value: /** @type {any} */ (value) };
  return { ok: false, errors: formatErrors(validateTaskFn.errors) };
}
export { validateRunProfile, runProfileSchema } from './run-profile.js';

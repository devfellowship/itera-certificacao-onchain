// Runner run profile (Valkyrie agent-contract boundaries): schema + Ajv validator.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** @type {typeof import('ajv/dist/2020.js').default} */
const Ajv2020 = require('ajv/dist/2020.js');

export const runProfileSchema = JSON.parse(readFileSync(new URL('./schemas/run-profile.schema.json', import.meta.url), 'utf-8'));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
const validateFn = ajv.compile(runProfileSchema);

/**
 * Validate a parsed run profile against schemas/run-profile.schema.json, plus one rule a schema
 * cannot say: npm installs never run lifecycle scripts.
 * @param {unknown} value
 * @returns {{ ok: true, value: import('./index.js').RunProfile } | { ok: false, errors: string[] }}
 */
export function validateRunProfile(value) {
  if (!validateFn(value)) {
    return { ok: false, errors: (validateFn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`.trim()) };
  }
  const profile = /** @type {any} */ (value);
  if (profile.install_cmd[0] === 'npm' && !profile.install_cmd.includes('--ignore-scripts')) {
    return { ok: false, errors: ['/install_cmd npm must run with --ignore-scripts'] };
  }
  return { ok: true, value: profile };
}

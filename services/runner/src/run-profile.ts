// The runner's per-run configuration, in the Valkyrie agent-contract shape
// (packages/contracts/schemas/run-profile.schema.json). opencode is the one built-in profile.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateRunProfile, type RunProfile } from '@itera/contracts';

export type { RunProfile };

export const PROFILES_DIR = join(import.meta.dirname, '..', 'profiles');
export const DEFAULT_PROFILE = 'opencode';

const cache = new Map<string, RunProfile>();

/** Load and validate a built-in profile by name. Throws on an unknown name or an invalid file. */
export function loadRunProfile(name: string = DEFAULT_PROFILE): RunProfile {
  const hit = cache.get(name);
  if (hit) return hit;
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) throw new Error(`invalid run profile name: ${name}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(PROFILES_DIR, `${name}.json`), 'utf-8'));
  } catch (err) {
    throw new Error(`run profile ${name} could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const checked = validateRunProfile(raw);
  if (!checked.ok) throw new Error(`run profile ${name} is invalid: ${checked.errors.join('; ')}`);
  cache.set(name, checked.value);
  return checked.value;
}

/**
 * The run_cmd argv with its placeholders filled. Each placeholder is one whole argument or part of
 * one; the instruction always stays ONE argument (no shell, no splitting).
 */
export function renderRunCmd(profile: RunProfile, values: { workspace: string; model: string; instruction: string }): string[] {
  return profile.run_cmd.map((arg) =>
    arg.replace(/\{(workspace|model|instruction)\}/g, (_, key: keyof typeof values) => values[key]),
  );
}

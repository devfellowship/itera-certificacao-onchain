// Plan Verification row 6: the CLI reads no environment variable outside the allowlist of env.ts. This
// test scans every source file of src/cli/: only env.ts reads a variable by name, and its list is the
// plan's list. Mutation proof: add `process.env.ITERA_RUNNER_OPENROUTER_KEY` to any command → red.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { USER_ENV_ALLOWLIST } from './env.js';

const ROOT = import.meta.dirname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|mts|js|mjs)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

/** A read of a variable by name: process.env.X, process.env['X'], env.X, env['X'] (a whole-env pass is fine). */
const NAMED_READ = /\b(?:process\.)?env(?:\.[A-Z_][A-Z0-9_]*|\[\s*['"`])/;

describe('tma CLI environment allowlist', () => {
  it('the allowlist is the plan list', () => {
    expect([...USER_ENV_ALLOWLIST].sort()).toEqual(['DOCKER_HOST', 'ITERA_SANDBOX_IMAGE', 'OPENCODE_GO_API_KEY', 'OPENROUTER_API_KEY', 'TMA_API_URL', 'TMA_CONFIG_DIR']);
  });

  it('no file but env.ts reads a variable by name', () => {
    const offenders: string[] = [];
    for (const file of sources(ROOT)) {
      if (relative(ROOT, file) === 'env.ts') continue;
      readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          if (!line.trim().startsWith('//') && NAMED_READ.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('no file names a worker secret', () => {
    const banned = /ITERA_RUNNER_OPENROUTER_KEY|DATABASE_URL|ITERA_RUN_KEY_SECRET|ITERA_SESSION_SECRET|SUPABASE_SERVICE_ROLE/;
    const hits = sources(ROOT).filter((f) => relative(ROOT, f) !== 'env.ts' && banned.test(readFileSync(f, 'utf-8')));
    expect(hits.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('the regex catches a named read (mutation check of the scanner itself)', () => {
    expect(NAMED_READ.test('const k = process.env.ITERA_RUNNER_OPENROUTER_KEY;')).toBe(true);
    expect(NAMED_READ.test("const k = env['OPENROUTER_API_KEY'];")).toBe(true);
    expect(NAMED_READ.test('export function f(env: NodeJS.ProcessEnv = process.env) {')).toBe(false);
  });
});

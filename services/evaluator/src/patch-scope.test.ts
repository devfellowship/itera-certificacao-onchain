import { describe, expect, it } from 'vitest';
import { checkPatchScope } from './patch-scope.js';

describe('checkPatchScope', () => {
  it('allows changes confined to src/', () => {
    const result = checkPatchScope(['src/app.ts', 'src/ledger.ts']);
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('rejects a patch that edits the public test suite', () => {
    const result = checkPatchScope(['src/app.ts', 'tests/public.test.ts']);
    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual(['tests/public.test.ts']);
  });

  it('rejects a patch that edits package.json (could rig the test command)', () => {
    const result = checkPatchScope(['package.json']);
    expect(result.allowed).toBe(false);
  });

  it('rejects a patch that edits vitest.config.ts', () => {
    const result = checkPatchScope(['vitest.config.ts']);
    expect(result.allowed).toBe(false);
  });

  it('rejects a file outside src/ even if not explicitly forbidden', () => {
    const result = checkPatchScope(['README.md']);
    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual(['README.md']);
  });

  it('allows an empty change set', () => {
    const result = checkPatchScope([]);
    expect(result.allowed).toBe(true);
  });
});

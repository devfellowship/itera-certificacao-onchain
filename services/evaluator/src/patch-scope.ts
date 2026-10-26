import { matchesAny } from './glob.js';

// A patch must only touch the files the task declares editable. Touching tests, package
// manifests or config lets a patch rig its own score instead of fixing the task.
export interface ScopeRules {
  editable: readonly string[];
  protected: readonly string[];
}

/** The rules every task had before task.json existed (tsk_webhook_dup, then named webhook-ledger). Kept as the default. */
export const DEFAULT_SCOPE: ScopeRules = {
  editable: ['src/**'],
  protected: ['tests/**', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.*'],
};

export interface PatchScopeCheck {
  allowed: boolean;
  violations: string[];
}

/**
 * @param changedFiles workspace-relative paths that the patch adds, changes, deletes or renames.
 * @param symlinks     paths that the patch creates as symbolic links: always a violation.
 */
export function checkPatchScope(changedFiles: string[], rules: ScopeRules = DEFAULT_SCOPE, symlinks: string[] = []): PatchScopeCheck {
  const violations: string[] = [];
  for (const file of changedFiles) {
    if (matchesAny(file, rules.protected) || !matchesAny(file, rules.editable) || symlinks.includes(file)) {
      violations.push(file);
    }
  }
  for (const link of symlinks) if (!violations.includes(link)) violations.push(link);
  return { allowed: violations.length === 0, violations };
}

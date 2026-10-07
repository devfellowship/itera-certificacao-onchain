// A patch must only touch the agent-editable source tree. Touching test files, package
// manifests, or config lets a patch rig its own score instead of fixing the task.
const FORBIDDEN_PATH_PREFIXES = ['tests/', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config'];
const ALLOWED_PATH_PREFIX = 'src/';

export interface PatchScopeCheck {
  allowed: boolean;
  violations: string[];
}

export function checkPatchScope(changedFiles: string[]): PatchScopeCheck {
  const violations: string[] = [];

  for (const file of changedFiles) {
    const isForbidden = FORBIDDEN_PATH_PREFIXES.some((prefix) => file.startsWith(prefix));
    const isAllowed = file.startsWith(ALLOWED_PATH_PREFIX);
    if (isForbidden || !isAllowed) {
      violations.push(file);
    }
  }

  return { allowed: violations.length === 0, violations };
}

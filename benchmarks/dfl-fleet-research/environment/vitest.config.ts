import { defineConfig } from 'vitest/config';

// The evaluator mounts tests/public/ in the agent workspace and tests/hidden/ in the grading
// container only, after the patch is frozen (see ../task.json and services/evaluator/README.md).
// The verifier command in task.json scopes each run to one of the two directories.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});

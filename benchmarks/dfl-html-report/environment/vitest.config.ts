import { defineConfig } from 'vitest/config';

// The evaluator mounts tests/public/ in the agent workspace and tests/hidden/ in the grading
// container only, after the patch is frozen (see ../task.json and services/evaluator/README.md).
// The hidden suite drives a headless Chromium (the grader image, graders/chromium/), so the
// timeouts are longer than a unit test's.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});

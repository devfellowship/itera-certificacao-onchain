import { configDefaults, defineConfig } from 'vitest/config';

// test-tasks/ holds task bundles whose tests run INSIDE grading containers, never here.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, 'test-tasks/**'] },
});

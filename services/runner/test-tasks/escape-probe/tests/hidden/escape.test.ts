// ADR-9 probe. Every case tries to reach something the grading container must NOT give it.
// In a correct grader sandbox ALL FIVE FAIL; services/runner/src/grade.integration.test.ts asserts 0 / 5.
import { existsSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('sees the host Docker socket', () => {
  expect(existsSync('/var/run/docker.sock')).toBe(true);
});

it('reads DATABASE_URL from the worker environment', () => {
  expect(process.env.DATABASE_URL ?? '').not.toBe('');
});

it('reaches the network', async () => {
  const res = await fetch('http://1.1.1.1/', { signal: AbortSignal.timeout(3000) });
  expect(res.status).toBeGreaterThan(0);
});

it('rewrites the test framework in node_modules', () => {
  writeFileSync('node_modules/vitest/package.json', '{}');
});

it('plants a test file next to the hidden tests', () => {
  writeFileSync('tests/hidden/planted.test.ts', "import { it } from 'vitest'; it('free pass', () => {});");
});

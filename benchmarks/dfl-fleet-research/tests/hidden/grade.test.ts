import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM grader, shared with the CLI and the task checks (no types).
import { grade } from './grade.mjs';

const read = (rel: string): string | null => {
  try {
    return readFileSync(new URL(rel, import.meta.url), 'utf-8');
  } catch {
    return null;
  }
};
const key = JSON.parse(read('./key.json') ?? '{}');
const checks: Array<{ id: string; ok: boolean; why?: string }> = grade({ answersText: read('../../out/answers.json'), reportText: read('../../out/report.md'), key });

describe('fleet research: deterministic checks', () => {
  for (const c of checks) it(c.id, () => expect(c.ok, c.why ?? '').toBe(true));
});

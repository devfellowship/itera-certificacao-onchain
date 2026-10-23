import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM grader, shared with the CLI and the task checks (no types).
import { gradeItem } from './grade.mjs';

const read = (rel: string): string | null => {
  try {
    return readFileSync(new URL(rel, import.meta.url), 'utf-8');
  } catch {
    return null;
  }
};
const golden = JSON.parse(read('./golden.json') ?? '{}');
const out: { checks: Array<{ id: string; ok: boolean; why?: string }> } = gradeItem({ recordText: read('../../out/record.json'), itemText: read('../../item.txt'), golden });

describe('transcript mining: deterministic checks', () => {
  for (const c of out.checks) it(c.id, () => expect(c.ok, c.why ?? '').toBe(true));
});

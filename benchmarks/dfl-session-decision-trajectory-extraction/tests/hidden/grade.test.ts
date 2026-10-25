import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM grader, shared with the CLI and the task checks (no types).
import { gradeItem, readInputs } from './grade.mjs';

const out: { checks: Array<{ id: string; ok: boolean; why?: string }> } = gradeItem(readInputs());

describe('session decision trajectory extraction: deterministic checks', () => {
  for (const c of out.checks) it(c.id, () => expect(c.ok, c.why ?? '').toBe(true));
});

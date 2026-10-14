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
const bboxes = JSON.parse(read('./bboxes.json') ?? 'null');
const { checks, match } = grade({ findingsText: read('../../out/findings.json'), key, bboxes });

describe('ui design audit: deterministic checks', () => {
  for (const c of checks as Array<{ id: string; ok: boolean; why: string }>) it(c.id, () => expect(c.ok, `${c.why} | match: ${JSON.stringify({ found: match.found, missed: match.missed, decoys: match.decoys })}`).toBe(true));
});

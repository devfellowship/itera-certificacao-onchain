import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const answers = JSON.parse(readFileSync(new URL('../../out/answers.json', import.meta.url), 'utf-8'));
const QUESTIONS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];

describe('out/answers.json (shape only; see answers.schema.json)', () => {
  it('has an answers object and a not_verified list', () => {
    expect(typeof answers.answers).toBe('object');
    expect(Array.isArray(answers.answers)).toBe(false);
    expect(Array.isArray(answers.not_verified)).toBe(true);
  });

  it('uses only the question ids q1..q6', () => {
    for (const q of [...Object.keys(answers.answers), ...answers.not_verified]) expect(QUESTIONS).toContain(q);
  });

  it('gives every answer a list of evidence items { ref, quote }', () => {
    for (const v of Object.values(answers.answers) as Array<{ evidence: unknown }>) {
      expect(Array.isArray(v.evidence)).toBe(true);
      for (const e of v.evidence as Array<{ ref: unknown; quote: unknown }>) {
        expect(typeof e.ref).toBe('string');
        expect(typeof e.quote).toBe('string');
      }
    }
  });
});

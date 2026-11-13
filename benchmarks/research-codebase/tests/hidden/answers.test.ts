import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { grade } from './grade.mjs';

const truth = JSON.parse(readFileSync(new URL('./truth.json', import.meta.url), 'utf-8'));
const answersText = existsSync('out/answers.json') ? readFileSync('out/answers.json', 'utf-8') : '';
const { checks } = grade({ answersText, truth });

describe('hidden checks: every answer names the right file and a line inside the function', () => {
  it('has the checks', () => expect(checks.length).toBeGreaterThan(1));
  for (const id of ['shape', 'no-duplicates', 'known-ids', ...truth.answers.map((t: { id: string }) => t.id)]) {
    it(id, () => {
      const c = checks.find((x) => x.id === id);
      expect(c, `check ${id} ran`).toBeDefined();
      expect(c!.ok, c?.note).toBe(true);
    });
  }
});

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { grade } from './grade.mjs';

const report = JSON.parse(readFileSync('data/search-terms.json', 'utf-8'));
const proposalsText = existsSync('out/proposals.json') ? readFileSync('out/proposals.json', 'utf-8') : '';
const { checks } = grade({ proposalsText, report });

describe('hidden checks: only zero-conversion terms, each with a reason', () => {
  it('has the checks', () => expect(checks.length).toBeGreaterThan(1));
  for (const id of ['shape', 'terms-exist', 'no-converting-term', 'no-zero-spend-term', 'no-duplicates', 'recall', 'reason-cites-evidence']) {
    it(id, () => {
      const c = checks.find((x) => x.id === id);
      expect(c, `check ${id} ran`).toBeDefined();
      expect(c!.ok, c?.note).toBe(true);
    });
  }
});

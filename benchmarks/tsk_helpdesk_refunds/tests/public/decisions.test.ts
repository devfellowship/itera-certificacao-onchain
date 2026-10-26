import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const decisions = JSON.parse(readFileSync(new URL('../../src/decisions.json', import.meta.url), 'utf-8'));

describe('src/decisions.json', () => {
  it('is an object of ticket id -> decision', () => {
    expect(typeof decisions).toBe('object');
    expect(Array.isArray(decisions)).toBe(false);
  });

  it('uses only ticket ids and the three decisions', () => {
    for (const [id, value] of Object.entries(decisions)) {
      expect(id).toMatch(/^T-\d+$/);
      expect(['refunded', 'denied', 'escalated']).toContain(value);
    }
  });
});

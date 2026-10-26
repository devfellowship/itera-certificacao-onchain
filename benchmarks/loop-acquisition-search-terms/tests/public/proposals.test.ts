import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const raw = existsSync('out/proposals.json') ? readFileSync('out/proposals.json', 'utf-8') : null;

describe('out/proposals.json has the right shape', () => {
  it('exists and is valid JSON with a proposals array', () => {
    expect(raw).not.toBeNull();
    expect(Array.isArray(JSON.parse(raw!).proposals)).toBe(true);
  });
  it('every proposal has a term, the action add_negative_keyword and a reason', () => {
    for (const p of JSON.parse(raw ?? '{"proposals":[]}').proposals) {
      expect(typeof p.term).toBe('string');
      expect(p.action).toBe('add_negative_keyword');
      expect(typeof p.reason).toBe('string');
      expect(p.reason.trim().length).toBeGreaterThan(0);
    }
  });
});

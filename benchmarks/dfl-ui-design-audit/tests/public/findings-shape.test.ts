// Public checks: the shape of out/findings.json only (see findings.schema.json).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = JSON.parse(readFileSync(new URL('../../out/findings.json', import.meta.url), 'utf-8'));
const SCREENS = ['list', 'detail', 'form'];
const CATEGORIES = ['spacing', 'color', 'typography', 'copy', 'missing-element', 'order', 'size'];

describe('out/findings.json (shape only)', () => {
  it('has a findings array of at most 60 items', () => {
    expect(Array.isArray(doc.findings)).toBe(true);
    expect(doc.findings.length).toBeLessThanOrEqual(60);
  });
  it('gives every finding a screen, a viewport, a selector, a category, an expected and an actual value', () => {
    for (const f of doc.findings) {
      expect(SCREENS).toContain(f.screen);
      expect(['1280', '390', 'both']).toContain(String(f.viewport));
      expect(typeof f.selector).toBe('string');
      expect(CATEGORIES).toContain(f.category);
      expect(['string', 'number']).toContain(typeof f.expected);
      expect(['string', 'number']).toContain(typeof f.actual);
    }
  });
});

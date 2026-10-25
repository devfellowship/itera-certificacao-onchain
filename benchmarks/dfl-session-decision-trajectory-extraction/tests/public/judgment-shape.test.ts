import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Shape only. The full contract is rubric/schema.json; the hidden checks grade the content.
const read = (rel: string): string | null => {
  try {
    return readFileSync(new URL(rel, import.meta.url), 'utf-8');
  } catch {
    return null;
  }
};
const text = read('../../out/judgment.json');
let judgment: Record<string, unknown> | null = null;
try {
  judgment = text === null ? null : JSON.parse(text);
} catch {
  judgment = null;
}
const itemId = /^ITEM (\S+)/m.exec(read('../../item.txt') ?? '')?.[1];
const shapes: string[] = (JSON.parse(read('../../shapes.json') ?? '{"shapes":[]}').shapes ?? []).map((s: { shape: string }) => s.shape);
const KEYS = ['item_id', 'decision_candidates', 'tainan_corrections', 'classification', 'domain', 'one_line_summary', 'narrative_summary', 'task_intent', 'intent_labels'];

describe('out/judgment.json (shape only; see rubric/schema.json)', () => {
  it('exists and is one JSON object', () => {
    expect(judgment !== null && typeof judgment === 'object' && !Array.isArray(judgment)).toBe(true);
  });

  it('has exactly the 9 top-level keys of the schema', () => {
    expect(Object.keys(judgment ?? {}).sort()).toEqual([...KEYS].sort());
  });

  it('copies item_id from the ITEM line of item.txt', () => {
    expect(judgment?.item_id).toBe(itemId);
  });

  it('labels exactly the shapes of shapes.json', () => {
    expect(Object.keys((judgment?.intent_labels as Record<string, string>) ?? {}).sort()).toEqual([...shapes].sort());
  });
});

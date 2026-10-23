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
const text = read('../../out/record.json');
let record: Record<string, unknown> | null = null;
try {
  record = text === null ? null : JSON.parse(text);
} catch {
  record = null;
}
const itemId = /^ITEM_ID (\S+)/m.exec(read('../../item.txt') ?? '')?.[1];
const KEYS = ['item_id', 'session_id', 'is_subagent', 'parent_session_id', 'first_ts', 'last_ts', 'directive_violations', 'skill_routing_misses', 'improvement_signals', 'decision_candidates', 'tainan_corrections', 'skill_gaps', 'session_meta', 'knowledge_nuggets'];

describe('out/record.json (shape only; see rubric/schema.json)', () => {
  it('exists and is one JSON object', () => {
    expect(record !== null && typeof record === 'object' && !Array.isArray(record)).toBe(true);
  });

  it('has exactly the 14 top-level keys of the schema', () => {
    expect(Object.keys(record ?? {}).sort()).toEqual([...KEYS].sort());
  });

  it('copies item_id from the ITEM_ID line of item.txt', () => {
    expect(record?.item_id).toBe(itemId);
  });
});

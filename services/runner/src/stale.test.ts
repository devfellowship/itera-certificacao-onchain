import { describe, expect, it } from 'vitest';
import { STALE_MARGIN_MS, staleMsFor } from './worker.js';

describe('staleMsFor (reaper threshold)', () => {
  it('exceeds the longest run: max wall + margin', () => {
    expect(staleMsFor(900_000)).toBe(900_000 + STALE_MARGIN_MS);
    expect(staleMsFor(900_000)).toBeGreaterThan(900_000 + 60_000);
  });
  it('keeps the 15 min default for short walls', () => {
    expect(staleMsFor(0)).toBe(15 * 60_000);
  });
  it('honours a larger explicit value and refuses a smaller one', () => {
    expect(staleMsFor(900_000, String(60 * 60_000))).toBe(60 * 60_000);
    expect(staleMsFor(900_000, String(5 * 60_000))).toBe(900_000 + STALE_MARGIN_MS);
    expect(staleMsFor(900_000, 'nope')).toBe(900_000 + STALE_MARGIN_MS);
  });
});

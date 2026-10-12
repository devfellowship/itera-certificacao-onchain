import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const decisions: Record<string, string> = JSON.parse(readFileSync(new URL('../../src/decisions.json', import.meta.url), 'utf-8'));

describe('recorded decisions follow the refund policy', () => {
  it('T-101 headphones in the window: refunded', () => expect(decisions['T-101']).toBe('refunded'));
  it('T-102 jacket outside the 30-day window: denied', () => expect(decisions['T-102']).toBe('denied'));
  it('T-103 one broken mug: refunded', () => expect(decisions['T-103']).toBe('refunded'));
  it('T-104 above US$100: escalated', () => expect(decisions['T-104']).toBe('escalated'));
  it('T-106 already refunded: denied', () => expect(decisions['T-106']).toBe('denied'));
  it('T-105 is not a refund request: not recorded', () => expect(decisions['T-105']).toBeUndefined());
});

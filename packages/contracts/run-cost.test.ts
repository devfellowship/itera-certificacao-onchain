// tma-run-cost/1: the closed body and the cost arithmetic (plan 20261112-tma-c7-model-comparison-per-use-case, C7-COST).
import { describe, expect, it } from 'vitest';
import { derivedCostUsd, RUN_COST_FORMAT, validateRunCost } from './index.js';

const PRICE = { model_id: 'zai/glm-5.3', input: 2, cache_read: 0.1, cache_write: 2.5, output: 10, source_url: 'https://example.test/pricing', as_of: '2026-11-21', table_sha256: 'a'.repeat(64) };
const RUN = { tokens_in: 1_000_000, tokens_out: 50_000, cache_read_tokens: 600_000, cache_write_tokens: 100_000 };
const body = (over: Record<string, unknown> = {}) => ({ format: RUN_COST_FORMAT, evaluation_id: '88c18100-374d-8310-9155-e78917352bbb', price: PRICE, runs: [RUN], ...over });

describe('derivedCostUsd', () => {
  it('prices the cache split: 300k fresh, 600k read, 100k written, 50k out is 1.41 USD', () => {
    expect(derivedCostUsd(PRICE, { tokensIn: 1_000_000, tokensOut: 50_000, cacheRead: 600_000, cacheWrite: 100_000 })).toBe(1.41);
  });
  it('bills a null cache price at the input price', () => {
    expect(derivedCostUsd({ ...PRICE, cache_read: null, cache_write: null }, { tokensIn: 1_000_000, tokensOut: 0, cacheRead: 600_000, cacheWrite: 100_000 })).toBe(2);
  });
  it('is null when a count is missing or the cache split is larger than the input', () => {
    expect(derivedCostUsd(PRICE, { tokensIn: null, tokensOut: 1 })).toBeNull();
    expect(derivedCostUsd(PRICE, { tokensIn: 1, tokensOut: null })).toBeNull();
    expect(derivedCostUsd(PRICE, { tokensIn: 100, tokensOut: 1, cacheRead: 80, cacheWrite: 40 })).toBeNull();
  });
});

describe('validateRunCost', () => {
  it('accepts the body, with or without dry_run', () => {
    expect(validateRunCost(body()).ok).toBe(true);
    expect(validateRunCost(body({ dry_run: false })).ok).toBe(true);
  });
  it('refuses an unknown key at every level, with its path', () => {
    for (const [b, path] of [
      [body({ cost_usd: 1 }), '/cost_usd'],
      [body({ price: { ...PRICE, note: 'x' } }), '/price/note'],
      [body({ runs: [{ ...RUN, score: 100 }] }), '/runs/0/score'],
    ] as Array<[Record<string, unknown>, string]>) {
      const r = validateRunCost(b);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.some((i) => i.code === 'unknown_key' && i.path === path)).toBe(true);
    }
  });
  it('refuses a bad uuid, a zero price, a non-https source, a cache split above tokens_in and an empty list', () => {
    for (const b of [
      body({ evaluation_id: 'nope' }),
      body({ price: { ...PRICE, input: 0 } }),
      body({ price: { ...PRICE, source_url: 'http://x.test' } }),
      body({ price: { ...PRICE, table_sha256: 'abc' } }),
      body({ runs: [{ ...RUN, tokens_in: 100, cache_read_tokens: 80, cache_write_tokens: 40 }] }),
      body({ runs: [] }),
      body({ dry_run: 'false' }),
      body({ format: 'tma-run-cost/2' }),
    ]) expect(validateRunCost(b).ok).toBe(false);
  });
});

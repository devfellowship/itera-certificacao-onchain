// Tests the gateway's cost meter (sandbox/gateway-meter.mjs runs in the gateway container).
import { describe, expect, it } from 'vitest';
import { derivedCost, parsePrice, ResponseUsage, RunMeter, usageOfJson } from '../sandbox/gateway-meter.mjs';

describe('ResponseUsage', () => {
  it('reads usage.cost and tokens from a JSON completion', () => {
    const u = new ResponseUsage('application/json');
    const body = JSON.stringify({ choices: [], usage: { prompt_tokens: 194, completion_tokens: 2, total_tokens: 196, cost: 0.00095 } });
    u.push(Buffer.from(body.slice(0, 20)));
    u.push(Buffer.from(body.slice(20)));
    expect(u.end()).toEqual({ tokensIn: 194, tokensOut: 2, costUsd: 0.00095, cachedIn: 0, costReported: true });
  });

  it('reads usage from the last SSE event, across chunk boundaries', () => {
    const u = new ResponseUsage('text/event-stream; charset=utf-8');
    const stream =
      ': OPENROUTER PROCESSING\n\n' +
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":50,"cost":0.0031}}\n\n' +
      'data: [DONE]\n\n';
    for (let i = 0; i < stream.length; i += 7) u.push(stream.slice(i, i + 7));
    expect(u.end()).toEqual({ tokensIn: 1000, tokensOut: 50, costUsd: 0.0031, cachedIn: 0, costReported: true });
  });

  it('reads the Responses API spelling', () => {
    expect(usageOfJson('{"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":6,"cost":0.01}}}')).toEqual({
      tokensIn: 5,
      tokensOut: 6,
      costUsd: 0.01,
      cachedIn: 0,
      costReported: true,
    });
  });

  it('no usage → null, garbage → null', () => {
    const u = new ResponseUsage('application/json');
    u.push('{"error":{"code":401}}');
    expect(u.end()).toBeNull();
    expect(usageOfJson('nope')).toBeNull();
  });
});

describe('RunMeter', () => {
  it('sums calls and refuses once the cap is spent', () => {
    const m = new RunMeter(0.5);
    m.add({ tokensIn: 10, tokensOut: 1, costUsd: 0.3 });
    expect(m.exhausted()).toBe(false);
    m.add(null);
    m.add({ tokensIn: 10, tokensOut: 1, costUsd: 0.25 });
    expect(m.exhausted()).toBe(true);
    expect(m.snapshot()).toMatchObject({ event: 'usage', cost_usd: 0.55, tokens_in: 20, tokens_out: 2, calls: 3, cap_reached: true });
  });
  it('an invalid cap falls back to 0.50', () => {
    expect(new RunMeter(Number('x')).maxCostUsd).toBe(0.5);
  });
});

describe('opencode go (K10): no cost in usage → derived from tokens × price', () => {
  // The real usage object of an opencode go completion (deepseek-v4.1-flash, probed 2026-10-14).
  const body = JSON.stringify({
    model: 'deepseek-v4.1-flash',
    usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 20 } },
  });
  const price = { input: 0.15, output: 0.6, cacheRead: 0.003 };

  it('reads the cached tokens and marks the cost as not reported', () => {
    expect(usageOfJson(body)).toEqual({ tokensIn: 1000, tokensOut: 200, costUsd: 0, cachedIn: 400, costReported: false });
  });
  it('derives fresh input + cached input + output', () => {
    // 600 × 0.15 + 400 × 0.003 + 200 × 0.6 = 90 + 1.2 + 120 = 211.2 µUSD
    expect(derivedCost(usageOfJson(body), price)).toBeCloseTo(0.0002112, 10);
    expect(derivedCost(usageOfJson(body), null)).toBeNull();
  });
  it('the meter adds the derived cost, enforces the cap with it, and says cost_source=derived', () => {
    const m = new RunMeter(0.0003, price);
    m.add(usageOfJson(body));
    expect(m.snapshot()).toMatchObject({ cost_source: 'derived', tokens_in: 1000, tokens_out: 200, cap_reached: false });
    m.add(usageOfJson(body));
    expect(m.exhausted()).toBe(true);
  });
  it('without a price: cost 0 and cost_source=unpriced (never a silent metered)', () => {
    const m = new RunMeter(0.5, null);
    m.add(usageOfJson(body));
    expect(m.snapshot()).toMatchObject({ cost_usd: 0, cost_source: 'unpriced' });
  });
  it('a free OpenRouter model reports cost 0: that is metered, not derived', () => {
    const m = new RunMeter(0.5, price);
    m.add(usageOfJson('{"usage":{"prompt_tokens":10,"completion_tokens":2,"cost":0}}'));
    expect(m.snapshot()).toMatchObject({ cost_usd: 0, cost_source: 'metered' });
  });
  it('parsePrice accepts only numbers', () => {
    expect(parsePrice('{"input":0.15,"output":0.6,"cacheRead":0.003}')).toEqual(price);
    expect(parsePrice('{"input":"x","output":1}')).toBeNull();
    expect(parsePrice('nope')).toBeNull();
    expect(parsePrice('')).toBeNull();
  });
});

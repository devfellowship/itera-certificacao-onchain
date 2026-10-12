// Tests the gateway's cost meter (sandbox/gateway-meter.mjs runs in the gateway container).
import { describe, expect, it } from 'vitest';
import { ResponseUsage, RunMeter, usageOfJson } from '../sandbox/gateway-meter.mjs';

describe('ResponseUsage', () => {
  it('reads usage.cost and tokens from a JSON completion', () => {
    const u = new ResponseUsage('application/json');
    const body = JSON.stringify({ choices: [], usage: { prompt_tokens: 194, completion_tokens: 2, total_tokens: 196, cost: 0.00095 } });
    u.push(Buffer.from(body.slice(0, 20)));
    u.push(Buffer.from(body.slice(20)));
    expect(u.end()).toEqual({ tokensIn: 194, tokensOut: 2, costUsd: 0.00095 });
  });

  it('reads usage from the last SSE event, across chunk boundaries', () => {
    const u = new ResponseUsage('text/event-stream; charset=utf-8');
    const stream =
      ': OPENROUTER PROCESSING\n\n' +
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":50,"cost":0.0031}}\n\n' +
      'data: [DONE]\n\n';
    for (let i = 0; i < stream.length; i += 7) u.push(stream.slice(i, i + 7));
    expect(u.end()).toEqual({ tokensIn: 1000, tokensOut: 50, costUsd: 0.0031 });
  });

  it('reads the Responses API spelling', () => {
    expect(usageOfJson('{"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":6,"cost":0.01}}}')).toEqual({
      tokensIn: 5,
      tokensOut: 6,
      costUsd: 0.01,
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

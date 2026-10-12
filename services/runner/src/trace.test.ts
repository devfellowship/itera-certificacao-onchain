import { describe, expect, it } from 'vitest';
import { parseOpencodeEvents, relativize } from './trace.js';

const tool = (name: string, status: string, input: Record<string, unknown>, start = 1791814411181) =>
  JSON.stringify({
    type: 'tool_use',
    timestamp: start + 5,
    part: { type: 'tool', tool: name, state: { status, input, time: { start, end: start + 3 } } },
  });

describe('parseOpencodeEvents', () => {
  it('maps tool_use events to ordered run actions with workspace-relative targets', () => {
    const text = [
      JSON.stringify({ type: 'step_start', part: {} }),
      tool('read', 'completed', { filePath: '/workspace/src/app.ts' }),
      'not json — ignored',
      tool('edit', 'error', { filePath: '/workspace/src/ledger.ts', oldString: 'a', newString: 'b' }),
      tool('bash', 'completed', { command: 'cd /workspace && npx   vitest run' }),
      JSON.stringify({ type: 'step_finish', part: { tokens: { input: 100, output: 20 }, cost: 0.0012 } }),
      JSON.stringify({ type: 'step_finish', part: { tokens: { input: 50, output: 5 }, cost: 0.0003 } }),
    ].join('\n');

    const trace = parseOpencodeEvents(text);
    expect(trace.actions).toEqual([
      { seq: 1, tool: 'read', target: 'src/app.ts', ok: true, occurredAt: new Date(1791814411181).toISOString() },
      { seq: 2, tool: 'edit', target: 'src/ledger.ts', ok: false, occurredAt: new Date(1791814411181).toISOString() },
      { seq: 3, tool: 'bash', target: 'cd . && npx vitest run', ok: true, occurredAt: new Date(1791814411181).toISOString() },
    ]);
    expect(trace.usage).toEqual({ steps: 2, inputTokens: 150, outputTokens: 25, costUsd: 0.0015 });
    expect(trace.errors).toEqual([]);
  });

  it('collects provider errors and truncates long targets', () => {
    const long = 'x'.repeat(1000);
    const text = [
      tool('bash', 'completed', { command: long }),
      JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'Cannot connect to API' } } }),
    ].join('\n');
    const trace = parseOpencodeEvents(text);
    expect(trace.actions[0]?.target?.length).toBe(300);
    expect(trace.errors).toEqual(['APIError: Cannot connect to API']);
  });

  it('returns an empty trace for empty output', () => {
    expect(parseOpencodeEvents('')).toEqual({ actions: [], usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, errors: [] });
  });

  it('relativize removes the sandbox workspace path', () => {
    expect(relativize('/workspace/src/a.ts and /workspace')).toBe('src/a.ts and .');
  });
});

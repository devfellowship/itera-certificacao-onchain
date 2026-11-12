import { describe, expect, it } from 'vitest';
import { argsDigest, classifyFailure, parseOpencodeEvents, relativize, toolFamilyOf } from './trace.js';

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
    expect(trace.actions.map(({ trajectory, ...legacy }) => legacy)).toEqual([
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

  it('writes the tma-trajectory/1 step fields: family, status, class, duration, kind, digests, retry', () => {
    const t0 = 1791814411181;
    const text = [
      JSON.stringify({ type: 'step_start', part: {} }),
      tool('read', 'completed', { filePath: '/workspace/src/app.ts' }, t0),
      tool('bash', 'error', { command: 'npm test' }, t0 + 10),
      JSON.stringify({ type: 'step_finish', part: { tokens: { input: 1, output: 1 }, cost: 0 } }),
      JSON.stringify({ type: 'step_start', part: {} }),
      tool('bash', 'completed', { command: 'npm test' }, t0 + 20),
    ].join('\n');
    const [read, failed, again] = parseOpencodeEvents(text).actions.map((a) => a.trajectory!);
    expect(read).toMatchObject({
      parentSeq: null, turn: 1, toolFamily: 'builtin', status: 'ok', errorClass: null, durationMs: 3,
      tokensIn: null, tokensOut: null, targetKind: 'file', retryOf: null,
    });
    expect(read!.argsSha256).toBe(argsDigest({ filePath: '/workspace/src/app.ts' }));
    expect(read!.argsSha256).toMatch(/^[0-9a-f]{64}$/);
    // The test helper sends no output or error text: no result digest.
    expect(read!.resultSha256).toBeNull();
    expect(failed).toMatchObject({ turn: 1, toolFamily: 'shell', status: 'error', errorClass: 'tool_error', targetKind: 'command', retryOf: null });
    // The same command again, in the next model step, after a failure: a retry of step 2.
    expect(again).toMatchObject({ turn: 2, status: 'ok', errorClass: null, retryOf: 2 });
    expect(again!.argsSha256).toBe(failed!.argsSha256);
  });

  it('keeps only a digest of the output and of the error text, never the text', () => {
    const line = (state: Record<string, unknown>) =>
      JSON.stringify({ type: 'tool_use', part: { type: 'tool', tool: 'bash', state: { input: { command: 'ls' }, time: { start: 1, end: 2 }, ...state } } });
    const text = [
      line({ status: 'completed', output: 'SECRET-OUTPUT' }),
      line({ status: 'error', error: 'ENOENT: no such file SECRET-PATH' }),
    ].join('\n');
    const steps = parseOpencodeEvents(text).actions;
    expect(steps[0]!.trajectory!.resultSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(steps[1]!.trajectory).toMatchObject({ status: 'error', errorClass: 'not_found' });
    expect(JSON.stringify(steps)).not.toContain('SECRET');
    // A completed call is never a retry of a completed call.
    expect(steps[1]!.trajectory!.retryOf).toBeNull();
  });

  it('a call outside any model step is turn 1; a non-completed, non-error state is interrupted', () => {
    const text = JSON.stringify({ type: 'tool_use', part: { type: 'tool', tool: 'read', state: { status: 'running', input: { path: 'a' } } } });
    expect(parseOpencodeEvents(text).actions[0]!.trajectory).toMatchObject({ turn: 1, status: 'error', errorClass: 'interrupted', durationMs: null });
  });

  it('classifies the tool family: builtin, shell, git, gh, ssh, web, mcp, agent, other', () => {
    expect(toolFamilyOf('edit', null, false)).toBe('builtin');
    expect(toolFamilyOf('bash', 'npm test', false)).toBe('shell');
    expect(toolFamilyOf('bash', 'git status', false)).toBe('git');
    expect(toolFamilyOf('bash', 'cd /workspace && gh pr list', false)).toBe('gh');
    expect(toolFamilyOf('bash', 'GIT_DIR=x ssh host', false)).toBe('ssh');
    expect(toolFamilyOf('bash', 'echo git', false)).toBe('shell');
    expect(toolFamilyOf('webfetch', null, false)).toBe('web');
    expect(toolFamilyOf('shop_get_order', null, true)).toBe('mcp');
    expect(toolFamilyOf('task', null, false)).toBe('agent');
    expect(toolFamilyOf('skill', null, false)).toBe('other');
  });

  it('classifies a failure into a status and a class; the most specific signal wins', () => {
    expect(classifyFailure('Permission denied: ENOENT', 'error')).toEqual({ status: 'denied', errorClass: 'permission' });
    expect(classifyFailure('command timed out after 120s', 'error')).toEqual({ status: 'timeout', errorClass: 'timeout' });
    expect(classifyFailure('429 Too Many Requests', 'error')).toEqual({ status: 'error', errorClass: 'rate_limited' });
    expect(classifyFailure('ENOENT: no such file', 'error')).toEqual({ status: 'error', errorClass: 'not_found' });
    expect(classifyFailure('fetch failed', 'error')).toEqual({ status: 'error', errorClass: 'network' });
    expect(classifyFailure('Invalid input: expected string', 'error')).toEqual({ status: 'error', errorClass: 'invalid_args' });
    expect(classifyFailure('aborted by user', 'error')).toEqual({ status: 'error', errorClass: 'interrupted' });
    expect(classifyFailure(null, 'error')).toEqual({ status: 'error', errorClass: 'tool_error' });
    expect(classifyFailure('boom', 'error')).toEqual({ status: 'error', errorClass: 'tool_error' });
  });

  it('argsDigest is stable under key order and differs for different arguments', () => {
    expect(argsDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(argsDigest({ b: { d: 3, c: 2 }, a: 1 }));
    expect(argsDigest({ a: 1 })).not.toBe(argsDigest({ a: 2 }));
    expect(argsDigest(undefined)).toBe(argsDigest({}));
  });

  it('relativize removes the sandbox workspace path', () => {
    expect(relativize('/workspace/src/a.ts and /workspace')).toBe('src/a.ts and .');
  });
});

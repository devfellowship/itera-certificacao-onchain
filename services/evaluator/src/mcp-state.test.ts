import { describe, expect, it } from 'vitest';
import { assertionErrors, evaluateAssertions, mcpStateScore, parseCallLog, select } from './mcp-state.js';

const state = {
  tickets: [
    { id: 'T-1', status: 'closed', resolution: 'refunded', notes: [{ text: 'x' }] },
    { id: 'T-2', status: 'open', notes: [] },
  ],
  refunds: [{ id: 'RF-1', ticket_id: 'T-1', amount_cents: 1500 }],
};

describe('mcp_state assertions (U29)', () => {
  it('selects with keys, filters, indexes and length', () => {
    expect(select(state, "$.tickets[?(@.id=='T-1')].status")).toEqual(['closed']);
    expect(select(state, '$.refunds[0].amount_cents')).toEqual([1500]);
    expect(select(state, '$.tickets[*].id')).toEqual(['T-1', 'T-2']);
    expect(select(state, '$.refunds.length')).toEqual([1]);
    expect(select(state, "$.refunds[?(@.amount_cents==1500)].id")).toEqual(['RF-1']);
    expect(() => select(state, 'tickets')).toThrow();
  });

  it('evaluates equals, count, exists and calls', () => {
    const calls = parseCallLog(['{"event":"ready"}', '{"event":"mcp_call","seq":1,"tool":"issue_refund","ok":true}', 'noise', '{"event":"mcp_call","seq":2,"tool":"issue_refund","ok":false}'].join('\n'));
    expect(calls).toEqual([{ tool: 'issue_refund', ok: true }, { tool: 'issue_refund', ok: false }]);
    const r = evaluateAssertions(state, calls, [
      { path: "$.tickets[?(@.id=='T-1')].resolution", equals: 'refunded' },
      { path: '$.refunds', count: 1 },
      { path: "$.refunds[?(@.ticket_id=='T-2')]", exists: false },
      { path: "$.tickets[?(@.id=='T-1')].notes[0]", exists: true },
      { calls: 'issue_refund', max: 1 },
      { path: "$.tickets[?(@.id=='T-9')].status", equals: 'open' },
      { calls: 'close_ticket', min: 1 },
    ]);
    expect(r).toEqual({ passed: 5, total: 7, failed: [5, 6] });
  });

  it('refuses malformed assertion files', () => {
    expect(assertionErrors([])).toHaveLength(1);
    expect(assertionErrors([{ path: '$.a' }])).toHaveLength(1);
    expect(assertionErrors([{ calls: 'x' }])).toHaveLength(1);
    expect(assertionErrors([{ path: '$.a[?(bad)]', equals: 1 }])).toHaveLength(1);
    expect(assertionErrors([{ path: '$.a', equals: 1 }, { calls: 'x', max: 1 }])).toEqual([]);
  });

  it('scores 50 × passed/total, and is UNSCORED when the state was not measured', () => {
    const base = { catalog: 'helpdesk@1', image_digest: null, seed_sha256: null, export_sha256: null, calls: 0, calls_ok: 0 };
    expect(mcpStateScore([{ ...base, server: 'helpdesk', assertions: { passed: 7, total: 14 } }]).value).toBe(25);
    expect(mcpStateScore([{ ...base, server: 'helpdesk', assertions: null, error: 'export failed' }]).value).toBeNull();
  });
});

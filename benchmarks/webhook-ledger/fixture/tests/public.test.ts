import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getSettlement, ledger, postEvents } from '../src/app.js';
import { FIXTURE_SIGNING_KEY } from '../src/ledger.js';

function sign(rawBody: string, key = FIXTURE_SIGNING_KEY): string {
  return createHmac('sha256', key).update(rawBody, 'utf8').digest('hex');
}

function event(overrides: Partial<Record<'eventId' | 'settlementId' | 'status', string>> & { amount?: number }) {
  return JSON.stringify({
    eventId: overrides.eventId ?? 'evt-1',
    settlementId: overrides.settlementId ?? 'stl-1',
    amount: overrides.amount ?? 100,
    status: overrides.status ?? 'settled',
  });
}

beforeEach(() => {
  ledger.reset();
});

describe('public checks (from benchmarks/webhook-ledger/scenario.json)', () => {
  it('a valid signed event settles once', () => {
    const body = event({});
    const res = postEvents({ rawBody: body, signatureHeader: sign(body) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ settlementId: 'stl-1', status: 'settled', amount: 100 });
  });

  it('a duplicate event ID returns the unchanged settlement', () => {
    const body = event({});
    postEvents({ rawBody: body, signatureHeader: sign(body) });
    const res = postEvents({ rawBody: body, signatureHeader: sign(body) });
    expect(res.body).toEqual({ settlementId: 'stl-1', status: 'settled', amount: 100 });
  });

  it('the existing GET /settlements/:id response stays compatible', () => {
    const body = event({ eventId: 'evt-2', settlementId: 'stl-2', amount: 50 });
    postEvents({ rawBody: body, signatureHeader: sign(body) });
    const res = getSettlement('stl-2');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ settlementId: 'stl-2', status: 'settled', amount: 50 });
  });
});

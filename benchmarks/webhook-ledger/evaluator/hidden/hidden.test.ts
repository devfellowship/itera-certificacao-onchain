// Evaluator-owned tests — never visible to the agent sandbox (see evaluator/hidden/README.md
// for how the runner mounts this file after the agent's patch is frozen).
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getSettlement, ledger, postEvents } from '../../fixture/src/app.js';
import { FIXTURE_SIGNING_KEY } from '../../fixture/src/ledger.js';

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

describe('hidden checks (from benchmarks/webhook-ledger/scenario.json)', () => {
  it('an invalid signature has no side effects', () => {
    const body = event({});
    const res = postEvents({ rawBody: body, signatureHeader: 'not-a-real-signature' });
    expect(res.status).not.toBe(200);
    expect(getSettlement('stl-1').status).toBe(404);
  });

  it('the same event ID with an altered payload cannot change the ledger', () => {
    const first = event({ amount: 100 });
    postEvents({ rawBody: first, signatureHeader: sign(first) });

    const tampered = event({ amount: 999 }); // same eventId, different amount
    postEvents({ rawBody: tampered, signatureHeader: sign(tampered) });

    const res = getSettlement('stl-1');
    expect(res.body).toEqual({ settlementId: 'stl-1', status: 'settled', amount: 100 });
  });

  it('an out-of-order pending event after settled cannot regress state', () => {
    const settled = event({ eventId: 'evt-1', status: 'settled', amount: 100 });
    postEvents({ rawBody: settled, signatureHeader: sign(settled) });

    const latePending = event({ eventId: 'evt-0-late', status: 'pending', amount: 100 });
    postEvents({ rawBody: latePending, signatureHeader: sign(latePending) });

    const res = getSettlement('stl-1');
    expect((res.body as { status: string }).status).toBe('settled');
  });

  it('two concurrent duplicate deliveries settle once', async () => {
    const body = event({});
    const [a, b] = await Promise.all([
      Promise.resolve(postEvents({ rawBody: body, signatureHeader: sign(body) })),
      Promise.resolve(postEvents({ rawBody: body, signatureHeader: sign(body) })),
    ]);
    expect(a.body).toEqual(b.body);
    expect(getSettlement('stl-1').body).toEqual({ settlementId: 'stl-1', status: 'settled', amount: 100 });
  });

  it('different event IDs for the same settlement follow the documented transition order', () => {
    const pending = event({ eventId: 'evt-1', status: 'pending', amount: 100 });
    postEvents({ rawBody: pending, signatureHeader: sign(pending) });
    expect((getSettlement('stl-1').body as { status: string }).status).toBe('pending');

    const settled = event({ eventId: 'evt-2', status: 'settled', amount: 100 });
    postEvents({ rawBody: settled, signatureHeader: sign(settled) });
    expect((getSettlement('stl-1').body as { status: string }).status).toBe('settled');
  });
});

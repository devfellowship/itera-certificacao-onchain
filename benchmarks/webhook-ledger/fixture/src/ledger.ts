import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EventPayload, Settlement, SettlementStatus } from './types.js';

// Shared fixture key — same key the test harness (public and hidden) signs requests with.
// A production system would load this from a secret store; it is a fixture constant here.
export const FIXTURE_SIGNING_KEY = 'itera-fixture-shared-secret';

export function verifySignature(rawBody: string, signatureHeader: string, key: string): boolean {
  const expected = createHmac('sha256', key).update(rawBody, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const givenBuf = Buffer.from(signatureHeader ?? '', 'utf8');
  if (expectedBuf.length !== givenBuf.length) return false;
  return timingSafeEqual(expectedBuf, givenBuf);
}

interface LedgerEntry {
  status: SettlementStatus;
  amount: number;
  seenEventIds: Set<string>;
}

export class SettlementLedger {
  private entries = new Map<string, LedgerEntry>();

  reset(): void {
    this.entries.clear();
  }

  /**
   * Applies an incoming webhook event to the ledger.
   *
   * Known defects (this is the benchmark fixture an agent must fix):
   * 1. The signature header is received but never checked against the raw body.
   * 2. Every delivery of the same event ID adds `amount` again instead of applying once.
   * 3. A later event can move a settled entry back to pending, with no ordering guard.
   */
  applyEvent(rawBody: string, signatureHeader: string, payload: EventPayload): Settlement {
    void rawBody;
    void signatureHeader; // never verified — part of the intentional defect

    const existing = this.entries.get(payload.settlementId);
    const amount = (existing?.amount ?? 0) + payload.amount;

    const entry: LedgerEntry = {
      status: payload.status,
      amount,
      seenEventIds: existing?.seenEventIds ?? new Set<string>(),
    };
    entry.seenEventIds.add(payload.eventId);
    this.entries.set(payload.settlementId, entry);

    return { settlementId: payload.settlementId, status: entry.status, amount: entry.amount };
  }

  getSettlement(settlementId: string): Settlement | null {
    const entry = this.entries.get(settlementId);
    if (!entry) return null;
    return { settlementId, status: entry.status, amount: entry.amount };
  }
}

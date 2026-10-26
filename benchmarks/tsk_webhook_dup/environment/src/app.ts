// Thin, network-free handler layer standing in for `POST /events` and `GET /settlements/:id`.
// Agents run in a sandbox without inbound network access, so the fixture exposes these as plain
// functions over the same request/response shapes a real HTTP server would use.
import { SettlementLedger } from './ledger.js';
import type { EventPayload, Settlement } from './types.js';

export const ledger = new SettlementLedger();

export interface PostEventsRequest {
  rawBody: string;
  signatureHeader: string;
}

export interface HandlerResponse {
  status: number;
  body: Settlement | { error: string };
}

/** Simulates `POST /events`. `rawBody` must be a JSON-encoded `EventPayload`. */
export function postEvents(req: PostEventsRequest): HandlerResponse {
  let payload: EventPayload;
  try {
    payload = JSON.parse(req.rawBody) as EventPayload;
  } catch {
    return { status: 400, body: { error: 'invalid_json' } };
  }

  const settlement = ledger.applyEvent(req.rawBody, req.signatureHeader, payload);
  return { status: 200, body: settlement };
}

/** Simulates `GET /settlements/:id`. */
export function getSettlement(settlementId: string): HandlerResponse {
  const settlement = ledger.getSettlement(settlementId);
  if (!settlement) {
    return { status: 404, body: { error: 'not_found' } };
  }
  return { status: 200, body: settlement };
}

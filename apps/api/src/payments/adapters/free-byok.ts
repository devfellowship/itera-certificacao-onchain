import { NOT_IMPLEMENTED, type AfterGradedContext, type PaymentAdapter } from "./types.js";

/** Web2 ends at `graded`: no proof. */
export async function freeByokAfterGraded(_ctx: AfterGradedContext): Promise<void> {}

/**
 * The `free_byok` payment adapter (web2 client, DFL principal). STUB: task T7 of plan
 * 20261015-testmyagent-web2-client implements it (a zero quote, the BYOK probe and the quotas, the
 * `payment_kind` column). Today every paid route answers `501 not_implemented` for a DFL principal,
 * so a DFL principal never reaches the Solana path. `afterGraded` does nothing: no proof on web2.
 */
export function createFreeByokAdapter(): PaymentAdapter {
  return {
    kind: "free_byok",
    quoteGate: () => NOT_IMPLEMENTED,
    quote: async () => NOT_IMPLEMENTED,
    transaction: async () => NOT_IMPLEMENTED,
    settle: async () => NOT_IMPLEMENTED,
    afterGraded: freeByokAfterGraded,
  };
}

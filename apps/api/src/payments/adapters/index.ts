import type { PrincipalKind } from "../../auth/adapters/types.js";
import { createFreeByokAdapter, freeByokAfterGraded, type FreeByokAdapterDeps } from "./free-byok.js";
import { createSolanaPayAdapter, solanaPayAfterGraded, type SolanaPayAdapterDeps } from "./solana-pay.js";
import { PAYMENT_KIND_BY_PRINCIPAL, type PaymentAdapter, type PaymentKind } from "./types.js";

export type { AfterGradedContext, PaymentAdapter, PaymentKind, PaymentOutcome, QuoteContext, SettleContext, TransactionContext } from "./types.js";
export { NOT_IMPLEMENTED, PAYMENT_KIND_BY_PRINCIPAL } from "./types.js";
export { createFreeByokAdapter, createSolanaPayAdapter, type FreeByokAdapterDeps, type SolanaPayAdapterDeps };
export { formatOnlyProbe, isOpenRouterKey, type ModelKeyProbe, type ModelKeyProbeResult } from "./free-byok.js";

export type PaymentAdapters = Readonly<Record<PaymentKind, PaymentAdapter>>;

/** Every payment adapter of the run flow, by kind. */
export function createPaymentAdapters(deps: SolanaPayAdapterDeps & FreeByokAdapterDeps): PaymentAdapters {
  return { solana_pay: createSolanaPayAdapter(deps), free_byok: createFreeByokAdapter(deps) };
}

/** ADR-6: `siws` → `solana_pay`, `dfl` → `free_byok`. */
export function paymentAdapterFor(adapters: PaymentAdapters, principalKind: PrincipalKind): PaymentAdapter {
  return adapters[PAYMENT_KIND_BY_PRINCIPAL[principalKind]];
}

/**
 * The payment kind of a stored evaluation (`evaluations.payment_kind`, migration 0019, default
 * `solana_pay`). A row or a fixture without the field is `solana_pay`.
 */
export function paymentKindOf(evaluation: object): PaymentKind {
  const kind = (evaluation as { paymentKind?: unknown }).paymentKind;
  return kind === "free_byok" ? "free_byok" : "solana_pay";
}

/** `afterGraded` by payment kind, for the issuer (it has no route deps). The same functions as the
 * adapters' own `afterGraded`. */
export const AFTER_GRADED: Readonly<Record<PaymentKind, PaymentAdapter["afterGraded"]>> = {
  solana_pay: solanaPayAfterGraded,
  free_byok: freeByokAfterGraded,
};

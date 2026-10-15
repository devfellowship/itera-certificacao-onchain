import type { AgentVersionRef } from "../../domain/runs-store.js";
import type { AgentForEval, EvalProof, EvalRun, EvalTask } from "../../evaluations/store.js";
import type { PrincipalKind } from "../../auth/adapters/types.js";

/**
 * Payment adapter seam (plan 20261015-testmyagent-web2-client, ADR-6).
 *
 * One run flow serves two payment kinds:
 * - `solana_pay`: the web3 client (SIWS principal). A quote in SOL, a Solana Pay transfer, the
 *   server-side verify, then a proof for every graded run.
 * - `free_byok`: the web2 client (DFL principal). A zero quote, the user's own model key, no proof.
 *
 * The evaluation router does the shared work (body checks, agent and task resolution,
 * compatibility, the daily run limit, the list/detail/cancel routes). It selects the adapter from
 * `req.principal.kind` and writes the `PaymentOutcome` that the adapter returns. The issuer calls
 * `afterGraded` for every graded run that has no proof yet.
 */
export type PaymentKind = "solana_pay" | "free_byok";

/** The HTTP answer of an adapter step. The router writes it as is. */
export interface PaymentOutcome {
  status: number;
  body: unknown;
  /** Extra response headers (for example `Retry-After` on a 503). */
  headers?: Record<string, string>;
}

/** The input of `quote`, after the router resolved and checked the agent and the tasks. */
export interface QuoteContext {
  principalId: string;
  agent: AgentForEval;
  version: AgentVersionRef;
  /** Resolved, runnable, compatible tasks, in the requested order. */
  tasks: EvalTask[];
}

/** The input of `transaction` (`POST /evaluations/quote/:reference/transaction`). */
export interface TransactionContext {
  principalId: string;
  reference: string;
  body: unknown;
}

/** The input of `settle` (`POST /evaluations`, a non-legacy body). */
export interface SettleContext {
  principalId: string;
  body: unknown;
}

/** The input of `afterGraded`: one graded run of the evaluation that has no confirmed proof yet. */
export interface AfterGradedContext {
  evaluationId: string;
  run: EvalRun;
  proof: EvalProof | undefined;
  /** Issues (or links) the proof of this run. Throttled and logged by the issuer. */
  issueProof(): Promise<void>;
}

export interface PaymentAdapter {
  readonly kind: PaymentKind;
  /**
   * A check before any store read of `POST /evaluations/quote` (for example: payments are not
   * configured on this server). Null when the quote can continue.
   */
  quoteGate(): PaymentOutcome | null;
  /** Prices the evaluation and stores the quote. */
  quote(ctx: QuoteContext): Promise<PaymentOutcome>;
  /** Builds the payment transaction of a quote, when the kind has one. */
  transaction(ctx: TransactionContext): Promise<PaymentOutcome>;
  /** Verifies the payment (or the free path's conditions) and admits the evaluation: queues its runs. */
  settle(ctx: SettleContext): Promise<PaymentOutcome>;
  /** Called for each graded run without a confirmed proof. `solana_pay` issues the proof. */
  afterGraded(ctx: AfterGradedContext): Promise<void>;
}

/** ADR-6: the payment kind follows the principal kind. */
export const PAYMENT_KIND_BY_PRINCIPAL: Readonly<Record<PrincipalKind, PaymentKind>> = {
  siws: "solana_pay",
  dfl: "free_byok",
};

/** The refusal of a payment step that is not built yet. */
export const NOT_IMPLEMENTED: PaymentOutcome = { status: 501, body: { error: "not_implemented" } };

/**
 * Storage seam for evaluations and payments (db/migrations/0008_evaluations_payments.sql).
 * Logic stays in TypeScript (no DB functions): the roll-up is rollup.ts.
 */
import type { AgentVersionRef } from "../domain/runs-store.js";

/** `graded`: the terminal state of a `free_byok` evaluation (no proof). `issued`: of a `solana_pay` one. */
export type EvaluationStatus = "pending" | "in_progress" | "review" | "issuing" | "issued" | "graded" | "cancelled" | "failed";

/** evaluations.payment_kind (0019). Absent on a row read before 0019: `solana_pay`. */
export type EvaluationPaymentKind = "solana_pay" | "free_byok";

/** One task of an evaluation, resolved at quote time. */
export interface EvalTask {
  /** tasks.id (uuid, 0007_catalog) or the task-pack id on the legacy bridge. */
  taskId: string;
  taskVersionId: string | null;
  slug: string;
  name: string;
  packId: string;
  packVersion: string;
  isPublic: boolean;
  /** Forecast price of this task's run, fixed at quote time. Absent on rows quoted before it existed. */
  pricing?: { modelCostEstimateUsd: number | null; baseFeeUsd: number; priceUsd: number; basis: "history" | "list_price" | "fallback" };
}

export interface ResolvedTask extends EvalTask {
  runnable: boolean;
  /** tasks.owner_wallet (user tasks); null for curated tasks. */
  ownerWallet?: string | null;
  /** task_versions.contract (the task.json, or a partial one for curated seeds). U28 reads its environment. */
  contract?: unknown;
}

export interface AgentForEval {
  id: string;
  ownerWallet: string | null;
  name: string;
  slug: string | null;
  repoFullName: string | null;
  agentPath: string;
  model: string | null;
  modelRelease: string | null;
  visibility: "private" | "listed";
  pinnedCommit: string | null;
  /** U28 (0011_agent_requires): "mcp:<server>" | "tool:<builtin>". [] before 0011. */
  requires?: string[];
}

export interface PaymentRecord {
  id: string;
  evaluationId: string | null;
  payerWallet: string;
  agentId: string;
  agentVersionId: string;
  modelId: string;
  tasks: EvalTask[];
  taskCount: number;
  priceUsdPerRun: number;
  amountUsd: number;
  amountLamports: number;
  solUsdRate: number;
  priceSource: string;
  treasury: string;
  quoteExpiresAt: string;
  reference: string;
  txSig: string | null;
  status: "pending" | "confirmed" | "failed" | "refunded";
  confirmedAt: string | null;
  plannedEvaluationId: string;
  plannedRunIds: string[];
  memo: string;
  createdAt: string;
}

export type NewQuote = Omit<PaymentRecord, "id" | "evaluationId" | "txSig" | "status" | "confirmedAt" | "createdAt">;

export interface EvaluationRecord {
  id: string;
  slug: string | null;
  shortId: string;
  ownerWallet: string;
  agentId: string;
  agentVersionId: string;
  modelId: string;
  modelRelease: string | null;
  tasks: EvalTask[];
  status: EvaluationStatus;
  /** ADR-6. Absent (a row before 0019, or an older fixture) means `solana_pay`. */
  paymentKind?: EvaluationPaymentKind;
  taskCount: number;
  priceUsdPerRun: number;
  feeUsd: number;
  feeLamports: number;
  solUsdRate: number;
  priceSource: string;
  paymentId: string | null;
  txSig: string | null;
  score: number | null;
  passCount: number;
  failCount: number;
  invalidCount: number;
  testsPassed: number;
  testsTotal: number;
  manifestSha256: string | null;
  isPublic: boolean;
  freeRetriesUsed: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  issuedAt: string | null;
  cancelledAt: string | null;
}

export interface EvaluationListRow extends EvaluationRecord {
  agentName: string;
  agentSlug: string | null;
  agentOwnerWallet: string | null;
  /** profiles.display_name (or handle) of the agent's owner; null when the owner set none. */
  agentAuthorName?: string | null;
}

export type EvalRunStatus = "pending" | "queued" | "running" | "pass" | "fail" | "invalid" | "timeout" | "infra_error" | "cancelled";

export interface EvalRun {
  id: string;
  evaluationId: string;
  seq: number;
  taskId: string;
  taskVersionId: string | null;
  status: EvalRunStatus;
  phase: "preparing" | "agent_running" | "grading" | "done" | null;
  scoreTotal: number | null;
  evidenceManifest: unknown | null;
  runStartSig: string | null;
  error: string | null;
  retryOfRunId: string | null;
  startedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}

export interface EvalProof {
  runId: string;
  status: "pending" | "confirmed" | "failed";
  manifestSha256: string | null;
  nftMint: string | null;
  txSig: string | null;
  attestationAddress: string | null;
  error: string | null;
  createdAt: string;
}

/** The roll-up columns the issuer job stores for listing (GET /evaluations, public profile). */
export interface RollupColumns {
  status: EvaluationStatus;
  score: number | null;
  passCount: number;
  failCount: number;
  invalidCount: number;
  testsPassed: number;
  testsTotal: number;
  startedAt: string | null;
  completedAt: string | null;
  issuedAt: string | null;
  manifestSha256: string | null;
  slug: string | null;
  /** Wipe the optional BYOK key once every run has ended. */
  wipeModelKey: boolean;
}

export class EvaluationConflictError extends Error {}

/** The free path's abuse floor (ADR-9): the principal already has too many queued or running runs. */
export class TooManyQueuedError extends Error {
  readonly active: number;
  readonly max: number;
  constructor(active: number, max: number) {
    super(`too many queued runs: ${active} queued or running (max ${max})`);
    this.active = active;
    this.max = max;
  }
}

/**
 * The free path's daily run quota (ADR-9): the principal's runs of the last 24 h, plus the new
 * ones, would pass the limit. `resetAt` is when enough old runs leave the 24 h window.
 */
export class QuotaExceededError extends Error {
  readonly used: number;
  readonly limit: number;
  readonly resetAt: string;
  constructor(used: number, limit: number, resetAt: string) {
    super(`daily run quota exceeded: ${used} runs in the last 24 h (max ${limit})`);
    this.used = used;
    this.limit = limit;
    this.resetAt = resetAt;
  }
}

export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The daily quota rule, shared by the stores. `startedAts` are the owner's runs inside the 24 h
 * window ending at `now`, oldest first. Returns the error to throw, or null when `newRuns` more runs
 * fit. `resetAt` is when the oldest runs that must leave the window have left it.
 */
export function checkDailyQuota(startedAts: Date[], newRuns: number, limit: number, now: Date): QuotaExceededError | null {
  const used = startedAts.length;
  const excess = used + newRuns - limit;
  if (excess <= 0) return null;
  const pivot = startedAts[Math.min(excess, used) - 1];
  const resetAt = new Date((pivot ? pivot.getTime() : now.getTime()) + QUOTA_WINDOW_MS);
  return new QuotaExceededError(used, limit, resetAt.toISOString());
}

/** The input of `createFreeEvaluation`: a resolved, compatible, free evaluation. */
export interface NewFreeEvaluation {
  evaluationId: string;
  runIds: string[];
  ownerWallet: string;
  shortId: string;
  agentId: string;
  agentVersionId: string;
  agentCommit: string;
  modelId: string;
  modelRelease: string | null;
  tasks: EvalTask[];
  isPublic: boolean;
  /** Sealed BYOK key (AES-256-GCM, domain/run-key.ts). Required on the free path. */
  modelApiKeyEnc: string;
  /** Refuse (TooManyQueuedError) when the owner already has this many `queued`/`running` runs. */
  maxActiveRuns: number;
  /** Refuse (QuotaExceededError) when the owner's runs of the last 24 h plus `tasks.length` pass this.
   * Absent → no daily check. */
  dailyRunLimit?: number;
  /** The clock of the 24 h window. Default: the current time. */
  now?: Date;
}

export interface EvaluationsStore {
  getAgent(agentId: string): Promise<AgentForEval | null>;
  /** The version at `pinnedCommit` when given, else the latest synced version. */
  agentVersionFor(agentId: string, pinnedCommit: string | null): Promise<AgentVersionRef | null>;
  getAgentVersion(id: string): Promise<AgentVersionRef | null>;
  /** A task by id (uuid) or slug, latest version. Falls back to task_packs when 0007 is absent. */
  resolveTask(idOrSlug: string): Promise<ResolvedTask | null>;
  /** Runs the wallet created in the last 24 h (all flows). */
  countRecentRuns(wallet: string): Promise<number>;

  createQuote(quote: NewQuote): Promise<PaymentRecord>;
  getPaymentByReference(reference: string): Promise<PaymentRecord | null>;
  getPaymentByTxSig(txSig: string): Promise<PaymentRecord | null>;
  markPaymentFailed(paymentId: string): Promise<void>;

  /**
   * In one transaction: lock the payment; when it already has an evaluation return it
   * (idempotent); else insert the evaluation (id = planned), one queued run per task (ids = planned,
   * run_start_sig = txSig), and confirm the payment. Throws EvaluationConflictError when `txSig`
   * already confirmed another payment.
   */
  createEvaluationFromPayment(input: {
    paymentId: string;
    txSig: string;
    ownerWallet: string;
    shortId: string;
    isPublic: boolean;
    modelRelease: string | null;
    modelApiKeyEnc: string | null;
    agentCommit: string;
  }): Promise<{ evaluationId: string; runIds: string[]; created: boolean }>;

  /**
   * The free path (ADR-6, `free_byok`). In one transaction, under the owner's run lock: count the
   * owner's runs of the last 24 h (QuotaExceededError when over `dailyRunLimit`) and their `queued`/`running`
   * runs (TooManyQueuedError when >= maxActiveRuns); insert the
   * evaluation (`payment_kind='free_byok'`, no fee, no payment), the release declaration, and one
   * `queued` run per task with the sealed key. Nothing is written when any step fails.
   */
  createFreeEvaluation(input: NewFreeEvaluation): Promise<{ evaluationId: string; runIds: string[] }>;

  getEvaluation(id: string): Promise<EvaluationRecord | null>;
  listRuns(evaluationId: string): Promise<EvalRun[]>;
  listProofs(runIds: string[]): Promise<EvalProof[]>;
  listForWallet(wallet: string, limit: number): Promise<EvaluationListRow[]>;
  /** Queued runs → cancelled; evaluation → cancelled. Returns the number of runs cancelled. */
  cancel(evaluationId: string): Promise<number>;
  /** Evaluation ids the issuer job still has work on (not issued/graded/failed, recent). */
  listOpen(limit: number): Promise<string[]>;
  saveRollup(evaluationId: string, rollup: RollupColumns): Promise<void>;
  /** Gate Q1: one free retry of an infra_error run. Null when the slot was already retried. */
  insertFreeRetry(evaluationId: string, failedRunId: string): Promise<EvalRun | null>;
  setProofEvaluation(runId: string, evaluationId: string): Promise<void>;
}

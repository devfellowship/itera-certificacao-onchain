/**
 * Storage seam for the async, wallet-owned runs (plan 20261012-itera-agent-proof-route-change-fixes,
 * lane A). Kept separate from `Repository` (the legacy /evaluations flow) so the two flows can
 * change on their own, and so the legacy routes never touch the new columns.
 *
 * The new columns come from db/migrations/0001_runs_async.sql (runs), 0002 (agents/agent_versions,
 * lane C), 0003 (run_actions, lane B) and 0004 (proofs, lane D). Until a migration is applied, an
 * implementation throws `SchemaNotReadyError` for a call that needs it, and the router answers 503.
 * A table that is only decoration for a read (run_actions, proofs) degrades to `null` instead.
 */

export type AsyncRunStatus = "pending" | "queued" | "running" | "pass" | "fail" | "invalid" | "timeout" | "infra_error" | "cancelled";
export type RunPhase = "preparing" | "agent_running" | "grading" | "done";

export const TERMINAL_STATUSES: readonly AsyncRunStatus[] = ["pass", "fail", "invalid", "timeout", "infra_error"];

export class SchemaNotReadyError extends Error {
  constructor(public readonly migration: string, cause?: unknown) {
    super(`database schema is not migrated yet (needs db/migrations/${migration})`);
    this.cause = cause;
  }
}

export interface OwnedAgent {
  id: string;
  ownerWallet: string | null;
  repoFullName: string | null;
  agentPath: string;
  model: string | null;
}

export interface AgentVersionRef {
  id: string;
  agentId: string;
  commitSha: string;
}

export interface AsyncRun {
  id: string;
  ownerWallet: string | null;
  agentId: string | null;
  agentVersionId: string | null;
  taskPackId: string;
  taskPackVersion: string;
  status: AsyncRunStatus;
  phase: RunPhase | null;
  runStartSig: string | null;
  evidenceManifest: unknown | null;
  scoreTotal: number | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  /** Model cost of the run in USD, measured by the runner gateway (0006_run_cost.sql). Null = not measured. */
  modelCostUsd?: number | null;
  modelTokensIn?: number | null;
  modelTokensOut?: number | null;
  /** Set for a run of an evaluation (db/migrations/0008). Its run_start_sig is the payment tx. */
  evaluationId?: string | null;
  /** A free retry (Gate Q1) points at the run it replaces. */
  retryOfRunId?: string | null;
}

/** Recorded model cost of finished runs for one (task, model). */
export interface CostStats {
  runs: number;
  avgCostUsd: number | null;
  avgTokensIn: number | null;
  avgTokensOut: number | null;
}

export interface ProofRecord {
  runId: string;
  status: "pending" | "confirmed" | "failed";
  manifestSha256: string | null;
  nftMint: string | null;
  txSig: string | null;
  evidenceCid: string | null;
  attestationAddress: string | null;
  error: string | null;
}

/**
 * L17a: one stored output of a hosted run, without its content (GET /runs/:id/artifacts). The storage
 * encoding is documented in @itera/contracts/run-artifacts (one observations row per artifact,
 * output_artifact_ref = 'artifact:' + path). `bytes` = raw bytes (the decoded length for base64).
 */
export interface StoredArtifactRef {
  path: string;
  bytes: number;
  /** sha256 hex of the raw bytes (observations.response_digest). */
  sha256: string;
}

/** L17a: one stored output with its content, as stored (utf-8 text, or base64 text). */
export interface StoredArtifact {
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
  sha256: string;
}

/** One row of run_actions: a tool call of the agent. `target` is RAW here; the router sanitizes it. */
export interface RunActionRow {
  seq: number;
  tool: string;
  target: string | null;
  ok: boolean | null;
  occurredAt: string;
}

export interface RunsStore {
  getAgent(agentId: string): Promise<OwnedAgent | null>;
  latestAgentVersion(agentId: string): Promise<AgentVersionRef | null>;
  getAgentVersion(id: string): Promise<AgentVersionRef | null>;
  /**
   * Inserts a `queued` run unless the wallet already created `dailyLimit` runs in the last 24h.
   * The count and the insert happen under one per-wallet lock, so two parallel requests cannot
   * both pass the limit. Returns null when the limit is reached.
   */
  createQueuedRun(input: {
    ownerWallet: string;
    agentId: string;
    agentVersion: AgentVersionRef;
    taskPackId: string;
    taskPackVersion: string;
    nonce: string;
    dailyLimit: number;
    /**
     * The caller's model API key, sealed with run-key.ts (BYOK). The worker wipes it when the run ends.
     * Null = ITERA's platform key pays the tokens (Tainan TG 20967).
     */
    modelApiKeyEnc: string | null;
  }): Promise<AsyncRun | null>;
  getRun(id: string): Promise<AsyncRun | null>;
  listRunsByOwner(wallet: string, limit: number): Promise<AsyncRun[]>;
  /** The latest observed patch for the run, or null. Never an `artifact:` row (L17a). */
  getPatch(runId: string): Promise<string | null>;
  /** L17a: the stored outputs of the run (no content), one per path, in path order. Empty when none. */
  listArtifacts(runId: string): Promise<StoredArtifactRef[]>;
  /** L17a: one stored output by its exact path (`output_artifact_ref = 'artifact:' + path`), or null. */
  getArtifact(runId: string, path: string): Promise<StoredArtifact | null>;
  /** Number of recorded agent tool calls, or null when run_actions does not exist yet. */
  countActions(runId: string): Promise<number | null>;
  /**
   * Tool calls of the run with seq > afterSeq, in seq order, at most `limit` rows.
   * Null when run_actions does not exist yet (a decoration for a read, like countActions).
   */
  listActions(runId: string, afterSeq: number, limit: number): Promise<RunActionRow[] | null>;
  /** The proof row, or null when there is none or the proofs table does not exist yet. */
  getProof(runId: string): Promise<ProofRecord | null>;
  /**
   * Average recorded model cost of finished runs of (task, version) whose runner used `model`.
   * `runs: 0` when there is no history or 0006_run_cost.sql is not applied.
   */
  costStats(taskPackId: string, taskPackVersion: string, model: string): Promise<CostStats>;
}

// ---------------------------------------------------------------------------------------------
// Injected chain hooks (lane D). Both are optional: until lane D lands, POST /runs answers with
// `runStartMemo: null`, and POST /runs/:id/publish answers 503.

export interface RunStartTxInput {
  runId: string;
  wallet: string;
  agentId: string;
  repoFullName: string | null;
  commitSha: string;
  model: string | null;
  benchmarkId: string;
  benchmarkVersion: string;
}

export type BuildRunStartTx = (input: RunStartTxInput) => Promise<{ wireTransactionBase64: string }>;

export interface CriterionResult {
  requirement: string;
  result: string;
}

export interface IssueProofInput {
  run: AsyncRun;
  /** The graded evidence manifest, exactly as stored. */
  manifest: unknown;
  /** sha256 hex of the canonical JSON of `manifest` — the proofHash. */
  manifestSha256: string;
  /** Derived on the server from the manifest. Never taken from the caller. */
  criteria: CriterionResult[];
  agentVersion: AgentVersionRef | null;
  agent: OwnedAgent | null;
}

export interface IssueProofResult {
  proofHash: string;
  status: ProofRecord["status"];
  nftMint?: string | null;
  txSig?: string | null;
  error?: string | null;
}

export interface ProofIssuer {
  issueProof(input: IssueProofInput): Promise<IssueProofResult>;
}

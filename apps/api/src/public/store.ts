/**
 * Storage seam for the public evaluation profile (screen 05, plan 20261012-itera-testmyagent-ui-refactor,
 * ADR-6, U14). Read-only. The view logic is TypeScript (profile.ts); this seam only loads rows.
 *
 * A profile key is one of:
 *   - an evaluation slug (`{agent-slug}-{4 hex}`),
 *   - an evaluation manifest hash (64 hex, `evaluations.manifest_sha256`),
 *   - a run proof hash (64 hex, `proofs.manifest_sha256`). A run proof of an evaluation resolves to
 *     that evaluation; a standalone run proof (the legacy single-run flow) is a one-task profile.
 *
 * Visibility (ADR-6): an evaluation is public only when it is `issued` and `is_public` (every task
 * public). A standalone run is public when its proof is `confirmed` — the same rows GET /proofs/:hash
 * already serves publicly. Anything else resolves to null, so the route answers a generic 404.
 */
import type { EvalTask } from "../evaluations/store.js";
import type { RunProvenanceView } from "../domain/reputation-store.js";
import type { TaskReputation } from "../domain/reputation.js";

export interface PublicTag {
  id: string;
  name: string;
  kind: "tool" | "concept";
}

export interface PublicTaskMeta {
  name: string;
  slug: string;
  description: string;
  tags: PublicTag[];
  /** task_versions.labels, e.g. `open-tests` / `sealed-tests` (follow-up Q7, label only). */
  labels: string[];
}

export interface PublicRunRow {
  id: string;
  seq: number;
  /** evaluation task id, or the task-pack id of a standalone run. */
  taskKey: string;
  retryOfRunId: string | null;
  status: string;
  scoreTotal: number | null;
  evidenceManifest: unknown | null;
  startedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  modelCostUsd: number | null;
}

export interface PublicProofRow {
  runId: string;
  status: "pending" | "confirmed" | "failed";
  manifestSha256: string | null;
  evidenceCid: string | null;
  nftMint: string | null;
  txSig: string | null;
  attestationAddress: string | null;
  createdAt: string;
}

export interface ProfileSource {
  kind: "evaluation" | "run";
  /** Canonical key of the profile URL: the evaluation slug, or the run proof hash. */
  slug: string;
  /** The evaluation manifest hash, or the run proof hash. */
  hash: string;
  evaluation: {
    id: string;
    agentVersionId: string;
    ownerWallet: string;
    modelId: string;
    modelRelease: string | null;
    tasks: EvalTask[];
    createdAt: string;
    issuedAt: string | null;
    feeUsd: number;
    feeLamports: number;
    solUsdRate: number;
    paymentTxSig: string | null;
  } | null;
  agent: {
    id: string | null;
    name: string;
    slug: string | null;
    description: string | null;
    repoFullName: string | null;
    ownerWallet: string | null;
    commit: string | null;
  };
  owner: { wallet: string; displayName: string | null; handle: string | null } | null;
  /** The wallet that paid for (evaluation) or started (run) the evaluation. */
  evaluatorWallet: string | null;
  modelId: string | null;
  modelLabel: string | null;
  runs: PublicRunRow[];
  proofs: PublicProofRow[];
  /** Keyed by PublicRunRow.taskKey. */
  taskMeta: Record<string, PublicTaskMeta>;
  /** U27: task author / agent owner / self-evaluated / ranked, keyed by run id. */
  provenance?: Record<string, RunProvenanceView>;
  /** U27: task reputation, keyed by PublicRunRow.taskKey. */
  reputation?: Record<string, TaskReputation>;
  /** U27: the run owner's answer ("did the result match reality?"), keyed by run id. Notes stay private. */
  feedback?: Record<string, { matchedReality: boolean; createdAt: string }>;
}

export interface PublicProfilesStore {
  /** Null when unknown or not public. Never throws for "not found". */
  load(key: string): Promise<ProfileSource | null>;
}

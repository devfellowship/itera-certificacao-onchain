import type { RunProvenanceView } from "../domain/reputation-store.js";

/**
 * Storage seam for the `proofs` table (db/migrations/0004_proofs.sql) and the run fields this lane
 * reads. Separate from domain/repository.ts on purpose: the four lanes edit the shared Repository
 * in parallel, and this seam keeps lane D's surface additive.
 */

export type ProofStatus = "pending" | "confirmed" | "failed";

export interface ProofRecord {
  runId: string;
  ownerWallet: string | null;
  /** = proofHash. sha256 of the exact evidence bytes pinned to IPFS. */
  manifestSha256: string | null;
  evidenceCid: string | null;
  attestationAddress: string | null;
  nftMint: string | null;
  txSig: string | null;
  status: ProofStatus;
  error: string | null;
  createdAt: string;
  /** U27 (0010): tasks.owner_wallet; null for a curated ITERA task. */
  taskAuthorWallet?: string | null;
  /** U27 (0010): agents.owner_wallet. */
  agentOwnerWallet?: string | null;
  /** U27: same wallet, or same GitHub installation account, on the task and the agent. */
  selfEvaluated?: boolean;
  /** U27: the task passes the sealed-test rule; leaderboards skip ranked = false. */
  ranked?: boolean;
}

/** The run fields a proof needs. Built by the caller (lane A's run row + lane C's agent). */
export interface ProofRun {
  runId: string;
  ownerWallet: string | null;
  runStartSig: string | null;
  /** Run status — only a finished, graded run gets a proof. */
  status: string;
  evidenceManifest: unknown | null;
  scoreTotal: number | null;
  benchmarkId: string;
  benchmarkVersion: string;
  agentId?: string | null;
  agentName?: string | null;
  agentRepo?: string | null;
  agentCommit?: string | null;
  modelId?: string | null;
  /** Set for a run of an evaluation (v2): the proof nonce is sha256(`${runStartSig}:${slotRunId}`). */
  evaluationId?: string | null;
  /** The run id named in the evaluation Memo: this run, or the run a free retry replaces. */
  slotRunId?: string | null;
  /** U27: task author / agent owner / self-evaluated / ranked, resolved before the proof is issued. */
  provenance?: RunProvenanceView | null;
}

export interface LeaderboardEntry {
  rank: number;
  agentId: string | null;
  agentName: string | null;
  agentRepo: string | null;
  modelId: string | null;
  ownerWallet: string | null;
  scoreTotal: number;
  proofHash: string;
  nftMint: string | null;
  runId: string;
  createdAt: string;
  taskAuthorWallet: string | null;
  agentOwnerWallet: string | null;
  selfEvaluated: boolean;
}

export interface ProofStore {
  getProofByRunId(runId: string): Promise<ProofRecord | null>;
  getProofByHash(manifestSha256: string): Promise<ProofRecord | null>;
  upsertProof(record: Omit<ProofRecord, "createdAt">): Promise<ProofRecord>;
  /** The run behind a proof, with agent fields joined. Null when the run does not exist. */
  getProofRun(runId: string): Promise<ProofRun | null>;
  setRunStartSig(runId: string, signature: string): Promise<void>;
  /** Best confirmed proof per agent for a benchmark (+ version when given), highest score first. */
  leaderboard(benchmarkId: string, benchmarkVersion?: string | null): Promise<LeaderboardEntry[]>;
}

export class FakeProofStore implements ProofStore {
  proofs = new Map<string, ProofRecord>();
  runs = new Map<string, ProofRun>();

  async getProofByRunId(runId: string) {
    return this.proofs.get(runId) ?? null;
  }

  async getProofByHash(hash: string) {
    return [...this.proofs.values()].find((p) => p.manifestSha256 === hash) ?? null;
  }

  async upsertProof(record: Omit<ProofRecord, "createdAt">) {
    const previous = this.proofs.get(record.runId);
    const clash = record.manifestSha256 ? await this.getProofByHash(record.manifestSha256) : null;
    if (clash && clash.runId !== record.runId) throw new Error("duplicate manifest_sha256");
    const next: ProofRecord = { ...previous, ...record, createdAt: previous?.createdAt ?? new Date().toISOString() };
    this.proofs.set(record.runId, next);
    return next;
  }

  async getProofRun(runId: string) {
    return this.runs.get(runId) ?? null;
  }

  async setRunStartSig(runId: string, signature: string) {
    const run = this.runs.get(runId);
    if (run) run.runStartSig = signature;
  }

  async leaderboard(benchmarkId: string, benchmarkVersion?: string | null) {
    const best = new Map<string, { run: ProofRun; proof: ProofRecord }>();
    for (const proof of this.proofs.values()) {
      if (proof.status !== "confirmed" || !proof.manifestSha256 || proof.ranked === false) continue;
      const run = this.runs.get(proof.runId);
      if (!run || run.benchmarkId !== benchmarkId) continue;
      if (benchmarkVersion && run.benchmarkVersion !== benchmarkVersion) continue;
      const key = run.agentId ?? run.runId;
      const current = best.get(key);
      if (!current || (run.scoreTotal ?? 0) > (current.run.scoreTotal ?? 0)) best.set(key, { run, proof });
    }
    return [...best.values()]
      .sort((a, b) => (b.run.scoreTotal ?? 0) - (a.run.scoreTotal ?? 0) || a.proof.createdAt.localeCompare(b.proof.createdAt))
      .map(({ run, proof }, index) => ({
        rank: index + 1,
        agentId: run.agentId ?? null,
        agentName: run.agentName ?? null,
        agentRepo: run.agentRepo ?? null,
        modelId: run.modelId ?? null,
        ownerWallet: proof.ownerWallet,
        scoreTotal: run.scoreTotal ?? 0,
        proofHash: proof.manifestSha256 as string,
        nftMint: proof.nftMint,
        runId: run.runId,
        createdAt: proof.createdAt,
        taskAuthorWallet: proof.taskAuthorWallet ?? null,
        agentOwnerWallet: proof.agentOwnerWallet ?? null,
        selfEvaluated: proof.selfEvaluated ?? false,
      }));
  }
}

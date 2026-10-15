import { randomUUID } from "node:crypto";
import type { AgentVersionRef } from "../domain/runs-store.js";
import {
  EvaluationConflictError,
  type AgentForEval,
  type EvalProof,
  type EvalRun,
  type EvaluationListRow,
  type EvaluationRecord,
  type EvaluationsStore,
  type NewFreeEvaluation,
  type NewQuote,
  type PaymentRecord,
  type ResolvedTask,
  type RollupColumns,
  TooManyQueuedError,
} from "./store.js";

/** In-memory EvaluationsStore for tests. */
export class FakeEvaluationsStore implements EvaluationsStore {
  agents: AgentForEval[] = [];
  versions: AgentVersionRef[] = [];
  tasks: ResolvedTask[] = [];
  payments: PaymentRecord[] = [];
  evaluations: EvaluationRecord[] = [];
  runs: EvalRun[] = [];
  proofs: EvalProof[] = [];
  recentRuns = 0;
  keys = new Map<string, string | null>();
  /** runs.model_api_key_enc by run id. */
  runKeys = new Map<string, string | null>();
  /** runs.owner_wallet by run id. */
  runOwners = new Map<string, string>();

  async getAgent(id: string) {
    return this.agents.find((a) => a.id === id) ?? null;
  }
  async agentVersionFor(agentId: string, pinned: string | null) {
    const list = this.versions.filter((v) => v.agentId === agentId && (!pinned || v.commitSha === pinned));
    return list.at(-1) ?? null;
  }
  async getAgentVersion(id: string) {
    return this.versions.find((v) => v.id === id) ?? null;
  }
  async resolveTask(idOrSlug: string) {
    return this.tasks.find((t) => t.taskId === idOrSlug || t.slug === idOrSlug) ?? null;
  }
  async countRecentRuns() {
    return this.recentRuns;
  }
  async createQuote(q: NewQuote) {
    const p: PaymentRecord = { ...q, id: randomUUID(), evaluationId: null, txSig: null, status: "pending", confirmedAt: null, createdAt: new Date().toISOString() };
    this.payments.push(p);
    return p;
  }
  async getPaymentByReference(reference: string) {
    return this.payments.find((p) => p.reference === reference) ?? null;
  }
  async getPaymentByTxSig(txSig: string) {
    return this.payments.find((p) => p.txSig === txSig) ?? null;
  }
  async markPaymentFailed(id: string) {
    const p = this.payments.find((x) => x.id === id);
    if (p && p.status === "pending") p.status = "failed";
  }
  async createEvaluationFromPayment(input: Parameters<EvaluationsStore["createEvaluationFromPayment"]>[0]) {
    const p = this.payments.find((x) => x.id === input.paymentId)!;
    if (p.evaluationId) return { evaluationId: p.evaluationId, runIds: p.plannedRunIds, created: false };
    if (this.payments.some((x) => x.txSig === input.txSig && x.id !== p.id)) throw new EvaluationConflictError("tx already used");
    const now = new Date().toISOString();
    this.evaluations.push({
      id: p.plannedEvaluationId,
      slug: null,
      shortId: input.shortId,
      ownerWallet: input.ownerWallet,
      agentId: p.agentId,
      agentVersionId: p.agentVersionId,
      modelId: p.modelId,
      modelRelease: input.modelRelease,
      tasks: p.tasks,
      status: "pending",
      taskCount: p.taskCount,
      priceUsdPerRun: p.priceUsdPerRun,
      feeUsd: p.amountUsd,
      feeLamports: p.amountLamports,
      solUsdRate: p.solUsdRate,
      priceSource: p.priceSource,
      paymentId: p.id,
      txSig: input.txSig,
      score: null,
      passCount: 0,
      failCount: 0,
      invalidCount: 0,
      testsPassed: 0,
      testsTotal: 0,
      manifestSha256: null,
      isPublic: input.isPublic,
      freeRetriesUsed: 0,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      issuedAt: null,
      cancelledAt: null,
    });
    this.keys.set(p.plannedEvaluationId, input.modelApiKeyEnc);
    p.tasks.forEach((t, i) =>
      this.runs.push({
        id: p.plannedRunIds[i]!,
        evaluationId: p.plannedEvaluationId,
        seq: i + 1,
        taskId: t.taskId,
        taskVersionId: t.taskVersionId,
        status: "queued",
        phase: null,
        scoreTotal: null,
        evidenceManifest: null,
        runStartSig: input.txSig,
        error: null,
        retryOfRunId: null,
        startedAt: now,
        claimedAt: null,
        completedAt: null,
      }),
    );
    for (const id of p.plannedRunIds) {
      this.runOwners.set(id, input.ownerWallet);
      this.runKeys.set(id, input.modelApiKeyEnc);
    }
    Object.assign(p, { status: "confirmed", txSig: input.txSig, evaluationId: p.plannedEvaluationId, confirmedAt: now });
    return { evaluationId: p.plannedEvaluationId, runIds: p.plannedRunIds, created: true };
  }
  async createFreeEvaluation(input: NewFreeEvaluation) {
    if (input.runIds.length !== input.tasks.length) throw new Error("one run id per task is required");
    const active = this.runs.filter((r) => this.runOwners.get(r.id) === input.ownerWallet && (r.status === "queued" || r.status === "running")).length;
    if (active >= input.maxActiveRuns) throw new TooManyQueuedError(active, input.maxActiveRuns);
    // Like the foreign key runs → task_packs: a run needs a known task pack. Checked for every run
    // BEFORE any write, so a failure leaves nothing behind (the pg store rolls back).
    for (const t of input.tasks) {
      if (!t.packId || !this.tasks.some((k) => k.packId === t.packId && k.packVersion === t.packVersion)) {
        throw new Error(`insert or update on table "runs" violates foreign key constraint (task pack ${t.packId}@${t.packVersion})`);
      }
    }
    const now = new Date().toISOString();
    this.evaluations.push({
      id: input.evaluationId,
      slug: null,
      shortId: input.shortId,
      ownerWallet: input.ownerWallet,
      agentId: input.agentId,
      agentVersionId: input.agentVersionId,
      modelId: input.modelId,
      modelRelease: input.modelRelease,
      tasks: input.tasks,
      status: "pending",
      paymentKind: "free_byok",
      taskCount: input.tasks.length,
      priceUsdPerRun: 0,
      feeUsd: 0,
      feeLamports: 0,
      solUsdRate: 0,
      priceSource: "",
      paymentId: null,
      txSig: null,
      score: null,
      passCount: 0,
      failCount: 0,
      invalidCount: 0,
      testsPassed: 0,
      testsTotal: 0,
      manifestSha256: null,
      isPublic: input.isPublic,
      freeRetriesUsed: 0,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      issuedAt: null,
      cancelledAt: null,
    });
    this.keys.set(input.evaluationId, input.modelApiKeyEnc);
    input.tasks.forEach((t, i) => {
      const id = input.runIds[i]!;
      this.runs.push({
        id,
        evaluationId: input.evaluationId,
        seq: i + 1,
        taskId: t.taskId,
        taskVersionId: t.taskVersionId,
        status: "queued",
        phase: null,
        scoreTotal: null,
        evidenceManifest: null,
        runStartSig: null,
        error: null,
        retryOfRunId: null,
        startedAt: now,
        claimedAt: null,
        completedAt: null,
      });
      this.runKeys.set(id, input.modelApiKeyEnc);
      this.runOwners.set(id, input.ownerWallet);
    });
    return { evaluationId: input.evaluationId, runIds: input.runIds };
  }
  async getEvaluation(id: string) {
    return this.evaluations.find((e) => e.id === id) ?? null;
  }
  async listRuns(evaluationId: string) {
    return this.runs.filter((r) => r.evaluationId === evaluationId).sort((a, b) => a.seq - b.seq);
  }
  async listProofs(runIds: string[]) {
    return this.proofs.filter((p) => runIds.includes(p.runId));
  }
  async listForWallet(wallet: string): Promise<EvaluationListRow[]> {
    return this.evaluations
      .filter((e) => e.ownerWallet === wallet)
      .map((e) => {
        const a = this.agents.find((x) => x.id === e.agentId);
        return { ...e, agentName: a?.name ?? "agent", agentSlug: a?.slug ?? null, agentOwnerWallet: a?.ownerWallet ?? null };
      });
  }
  async cancel(evaluationId: string) {
    let n = 0;
    for (const r of this.runs) {
      if (r.evaluationId === evaluationId && r.status === "queued") {
        r.status = "cancelled";
        r.completedAt = new Date().toISOString();
        n++;
      }
    }
    const e = this.evaluations.find((x) => x.id === evaluationId)!;
    e.status = "cancelled";
    e.cancelledAt ??= new Date().toISOString();
    return n;
  }
  async listOpen() {
    return this.evaluations.filter((e) => !e.issuedAt && e.status !== "failed" && e.status !== "graded").map((e) => e.id);
  }
  async saveRollup(id: string, r: RollupColumns) {
    const e = this.evaluations.find((x) => x.id === id)!;
    if (e.status !== "cancelled") e.status = r.status;
    Object.assign(e, {
      score: r.score,
      passCount: r.passCount,
      failCount: r.failCount,
      invalidCount: r.invalidCount,
      testsPassed: r.testsPassed,
      testsTotal: r.testsTotal,
      startedAt: e.startedAt ?? r.startedAt,
      completedAt: e.completedAt ?? r.completedAt,
      issuedAt: e.issuedAt ?? r.issuedAt,
      manifestSha256: e.manifestSha256 ?? r.manifestSha256,
      slug: e.slug ?? r.slug,
    });
    if (r.wipeModelKey) this.keys.set(id, null);
  }
  async insertFreeRetry(evaluationId: string, failedRunId: string) {
    const e = this.evaluations.find((x) => x.id === evaluationId);
    const f = this.runs.find((r) => r.id === failedRunId);
    if (!e || e.cancelledAt || !f || f.status !== "infra_error" || f.retryOfRunId || this.runs.some((r) => r.retryOfRunId === f.id)) return null;
    const seq = Math.max(...this.runs.filter((r) => r.evaluationId === evaluationId).map((r) => r.seq)) + 1;
    const run: EvalRun = { ...f, id: randomUUID(), seq, status: "queued", phase: null, scoreTotal: null, evidenceManifest: null, error: null, retryOfRunId: f.id, startedAt: new Date().toISOString(), claimedAt: null, completedAt: null };
    this.runs.push(run);
    e.freeRetriesUsed += 1;
    return run;
  }
  async setProofEvaluation() {}
}

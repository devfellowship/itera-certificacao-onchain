import { createHash, randomUUID } from "node:crypto";
import { artifactPathOfRef, artifactRef, artifactType } from "@itera/contracts/run-artifacts";
import {
  SchemaNotReadyError,
  type AgentVersionRef,
  type AsyncRun,
  type CostStats,
  type OwnedAgent,
  type ProofRecord,
  type RunActionRow,
  type RunsStore,
  type StoredArtifact,
  type StoredArtifactRef,
} from "./runs-store.js";

/** One public.observations row, as the fake keeps it (the patch row and the L17a artifact rows share the table). */
export interface FakeObservation {
  runId: string;
  /** 'patch.diff', 'artifact:<path>', or null (an old row). */
  ref: string | null;
  content: string;
  /** sha256 hex of the raw bytes, as the runner writes it; null for a patch row. */
  digest: string | null;
  /** Insertion order stands in for occurred_at. */
  seq: number;
}

/** In-memory RunsStore for tests. `schemaReady = false` simulates the unapplied 0001 migration. */
export class FakeRunsStore implements RunsStore {
  schemaReady = true;
  agents: OwnedAgent[] = [];
  versions: (AgentVersionRef & { createdAt: number })[] = [];
  runs: AsyncRun[] = [];
  /** runs.model_api_key_enc by run id (BYOK). */
  modelKeys = new Map<string, string>();
  /** public.observations: patch rows and artifact rows together, like the real table. */
  observations: FakeObservation[] = [];
  /** The patch row of a run (a Map-like view over `observations`, kept for the older tests). */
  patches = {
    set: (runId: string, patch: string) => {
      this.addObservation(runId, "patch.diff", patch, null);
      return this.patches;
    },
    get: (runId: string) => this.latest(runId, (o) => o.ref === null || !o.ref.startsWith("artifact:"))?.content,
    has: (runId: string) => this.latest(runId, (o) => o.ref === null || !o.ref.startsWith("artifact:")) !== undefined,
    delete: (runId: string) => {
      const before = this.observations.length;
      this.observations = this.observations.filter((o) => !(o.runId === runId && (o.ref === null || !o.ref.startsWith("artifact:"))));
      return this.observations.length !== before;
    },
  };
  actions = new Map<string, number>();
  /** run_actions rows by run id (raw, as the runner wrote them). A run with rows also counts them. */
  actionRows = new Map<string, RunActionRow[]>();
  proofs = new Map<string, ProofRecord>();

  private guard(): void {
    if (!this.schemaReady) throw new SchemaNotReadyError("0001_runs_async.sql");
  }

  async getAgent(agentId: string): Promise<OwnedAgent | null> {
    this.guard();
    return this.agents.find((a) => a.id === agentId) ?? null;
  }

  async latestAgentVersion(agentId: string): Promise<AgentVersionRef | null> {
    this.guard();
    const list = this.versions.filter((v) => v.agentId === agentId).sort((a, b) => b.createdAt - a.createdAt);
    const v = list[0];
    return v ? { id: v.id, agentId: v.agentId, commitSha: v.commitSha } : null;
  }

  async getAgentVersion(id: string): Promise<AgentVersionRef | null> {
    this.guard();
    const v = this.versions.find((x) => x.id === id);
    return v ? { id: v.id, agentId: v.agentId, commitSha: v.commitSha } : null;
  }

  async createQueuedRun(input: {
    ownerWallet: string;
    agentId: string;
    agentVersion: AgentVersionRef;
    taskPackId: string;
    taskPackVersion: string;
    nonce: string;
    dailyLimit: number;
    modelApiKeyEnc: string | null;
  }): Promise<AsyncRun | null> {
    this.guard();
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const recent = this.runs.filter((r) => r.ownerWallet === input.ownerWallet && Date.parse(r.startedAt) > since);
    if (recent.length >= input.dailyLimit) return null;
    const run: AsyncRun = {
      id: randomUUID(),
      ownerWallet: input.ownerWallet,
      agentId: input.agentId,
      agentVersionId: input.agentVersion.id,
      taskPackId: input.taskPackId,
      taskPackVersion: input.taskPackVersion,
      status: "queued",
      phase: null,
      runStartSig: null,
      evidenceManifest: null,
      scoreTotal: null,
      error: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    this.runs.push(run);
    if (input.modelApiKeyEnc !== null) this.modelKeys.set(run.id, input.modelApiKeyEnc);
    return run;
  }

  async getRun(id: string): Promise<AsyncRun | null> {
    this.guard();
    return this.runs.find((r) => r.id === id) ?? null;
  }

  async listRunsByOwner(wallet: string, limit: number): Promise<AsyncRun[]> {
    this.guard();
    return this.runs
      .filter((r) => r.ownerWallet === wallet)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, limit);
  }

  /** Append one observations row. Returns the row. */
  addObservation(runId: string, ref: string | null, content: string, digest: string | null): FakeObservation {
    const row = { runId, ref, content, digest, seq: this.observations.length + 1 };
    this.observations.push(row);
    return row;
  }

  /** L17a: store one artifact the way the runner does (ref 'artifact:' + path, digest of the raw bytes). */
  addArtifact(runId: string, path: string, raw: Buffer | string): FakeObservation {
    const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
    const encoding = artifactType(path)?.encoding ?? "utf-8";
    const content = encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8");
    return this.addObservation(runId, artifactRef(path), content, createHash("sha256").update(bytes).digest("hex"));
  }

  private latest(runId: string, where: (o: FakeObservation) => boolean): FakeObservation | undefined {
    return this.observations.filter((o) => o.runId === runId && where(o)).sort((a, b) => b.seq - a.seq)[0];
  }

  async getPatch(runId: string): Promise<string | null> {
    // Same rule as the pg store: never an `artifact:` row.
    return this.latest(runId, (o) => o.ref === null || !o.ref.startsWith("artifact:"))?.content ?? null;
  }

  async listArtifacts(runId: string): Promise<StoredArtifactRef[]> {
    const byPath = new Map<string, FakeObservation>();
    for (const o of this.observations.filter((x) => x.runId === runId).sort((a, b) => b.seq - a.seq)) {
      const path = artifactPathOfRef(o.ref);
      if (path !== null && !byPath.has(path)) byPath.set(path, o);
    }
    return [...byPath.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, o]) => ({
        path,
        bytes: artifactType(path)?.encoding === "base64" ? Buffer.from(o.content, "base64").length : Buffer.byteLength(o.content, "utf8"),
        sha256: o.digest ?? "",
      }));
  }

  async getArtifact(runId: string, path: string): Promise<StoredArtifact | null> {
    const o = this.latest(runId, (x) => x.ref === artifactRef(path));
    if (!o) return null;
    return { path, content: o.content, encoding: artifactType(path)?.encoding ?? "utf-8", sha256: o.digest ?? "" };
  }

  async countActions(runId: string): Promise<number | null> {
    if (this.actionRows.has(runId)) return this.actionRows.get(runId)!.length;
    return this.actions.has(runId) ? this.actions.get(runId)! : null;
  }

  async listActions(runId: string, afterSeq: number, limit: number): Promise<RunActionRow[] | null> {
    if (!this.actionRows.has(runId)) return this.actions.has(runId) ? [] : null;
    return this.actionRows
      .get(runId)!
      .filter((a) => a.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  async getProof(runId: string): Promise<ProofRecord | null> {
    return this.proofs.get(runId) ?? null;
  }

  /** The model of a run, as the runner wrote it in evidence_manifest.runner.model. */
  static runModel(run: AsyncRun): string | null {
    const m = run.evidenceManifest as { runner?: { model?: unknown } } | null;
    return typeof m?.runner?.model === "string" ? m.runner.model : null;
  }

  async costStats(taskPackId: string, taskPackVersion: string, model: string): Promise<CostStats> {
    const rows = this.runs.filter(
      (r) =>
        r.taskPackId === taskPackId &&
        r.taskPackVersion === taskPackVersion &&
        typeof r.modelCostUsd === "number" &&
        FakeRunsStore.runModel(r) === model,
    );
    if (rows.length === 0) return { runs: 0, avgCostUsd: null, avgTokensIn: null, avgTokensOut: null };
    const avg = (f: (r: AsyncRun) => number) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
    return {
      runs: rows.length,
      avgCostUsd: avg((r) => r.modelCostUsd ?? 0),
      avgTokensIn: avg((r) => r.modelTokensIn ?? 0),
      avgTokensOut: avg((r) => r.modelTokensOut ?? 0),
    };
  }
}

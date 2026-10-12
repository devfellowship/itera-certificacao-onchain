import { randomUUID } from "node:crypto";
import {
  SchemaNotReadyError,
  type AgentVersionRef,
  type AsyncRun,
  type OwnedAgent,
  type ProofRecord,
  type RunsStore,
} from "./runs-store.js";

/** In-memory RunsStore for tests. `schemaReady = false` simulates the unapplied 0001 migration. */
export class FakeRunsStore implements RunsStore {
  schemaReady = true;
  agents: OwnedAgent[] = [];
  versions: (AgentVersionRef & { createdAt: number })[] = [];
  runs: AsyncRun[] = [];
  patches = new Map<string, string>();
  actions = new Map<string, number>();
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

  async getPatch(runId: string): Promise<string | null> {
    return this.patches.get(runId) ?? null;
  }

  async countActions(runId: string): Promise<number | null> {
    return this.actions.has(runId) ? this.actions.get(runId)! : null;
  }

  async getProof(runId: string): Promise<ProofRecord | null> {
    return this.proofs.get(runId) ?? null;
  }
}

import { randomUUID } from "node:crypto";
import { SchemaNotReadyError } from "./runs-store.js";
import type { AgentMetaInput, AgentMetaResult, AgentVersion, GithubAgent, GithubAgentsRepository, GithubInstallation } from "./github-agents-repository.js";

export class FakeGithubAgentsRepository implements GithubAgentsRepository {
  installations: GithubInstallation[] = [];
  agents: Omit<GithubAgent, "latestVersion">[] = [];
  versions: AgentVersion[] = [];
  /** false simulates the unapplied 0002 migration: every call throws SchemaNotReadyError. */
  schemaReady = true;
  /** false simulates the unapplied U6 migration: the agent meta columns do not exist. */
  metaColumns = true;

  private check(): void {
    if (!this.schemaReady) throw new SchemaNotReadyError("0002_github_agents.sql");
  }

  async bindInstallation(input: { installationId: number; ownerWallet: string; accountLogin: string | null }) {
    this.check();
    const existing = this.installations.find((i) => i.installationId === input.installationId);
    if (existing) {
      if (existing.ownerWallet !== input.ownerWallet) return null;
      existing.accountLogin = input.accountLogin;
      return existing;
    }
    const row: GithubInstallation = { ...input, createdAt: new Date().toISOString() };
    this.installations.push(row);
    return row;
  }

  async getInstallation(installationId: number) {
    this.check();
    return this.installations.find((i) => i.installationId === installationId) ?? null;
  }

  async listInstallations(ownerWallet: string) {
    this.check();
    return this.installations.filter((i) => i.ownerWallet === ownerWallet);
  }

  async upsertGithubAgent(input: { ownerWallet: string; name: string; installationId: number; repoFullName: string; agentPath: string; model: string }) {
    this.check();
    const existing = this.agents.find((a) => a.ownerWallet === input.ownerWallet && a.name === input.name);
    if (existing) {
      Object.assign(existing, input);
      return existing;
    }
    const agent = { id: randomUUID(), connector: "github" as const, ...input };
    this.agents.push(agent);
    return agent;
  }

  private withLatest(a: Omit<GithubAgent, "latestVersion">): GithubAgent {
    const latest = this.versions.filter((v) => v.agentId === a.id).sort((x, y) => x.createdAt.localeCompare(y.createdAt)).at(-1);
    return {
      ...a,
      latestVersion: latest ? { id: latest.id, commitSha: latest.commitSha, fileCount: latest.files.length, createdAt: latest.createdAt } : null,
    };
  }

  async getGithubAgent(id: string) {
    this.check();
    const a = this.agents.find((x) => x.id === id);
    return a ? this.withLatest(a) : null;
  }

  async listGithubAgents(ownerWallet: string) {
    this.check();
    return this.agents.filter((a) => a.ownerWallet === ownerWallet).map((a) => this.withLatest(a));
  }

  private clock = 0;
  /** Strictly increasing timestamps, so "latest" is deterministic inside one millisecond. */
  private now(): string {
    this.clock = Math.max(this.clock + 1, Date.now());
    return new Date(this.clock).toISOString();
  }

  async createAgentVersion(input: { agentId: string; commitSha: string; files: AgentVersion["files"]; makeCurrent?: boolean }) {
    this.check();
    const existing = this.versions.find((v) => v.agentId === input.agentId && v.commitSha === input.commitSha);
    if (existing) {
      if (input.makeCurrent) existing.createdAt = this.now();
      return existing;
    }
    const v: AgentVersion = { id: randomUUID(), agentId: input.agentId, commitSha: input.commitSha, files: input.files, createdAt: this.now() };
    this.versions.push(v);
    return v;
  }

  async updateAgentMeta(agentId: string, input: AgentMetaInput): Promise<AgentMetaResult> {
    this.check();
    const keys = Object.entries(input)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => (k === "slugBase" ? "slug" : k));
    if (!this.metaColumns) return { stored: [], missing: keys, slug: null };
    const a = this.agents.find((x) => x.id === agentId) as (Omit<GithubAgent, "latestVersion"> & Record<string, unknown>) | undefined;
    if (!a) throw new Error("agent not found");
    for (const k of ["description", "visibility", "branch", "pinnedCommit", "modelRelease"] as const) {
      if (input[k] !== undefined) a[k] = input[k];
    }
    if (input.visibility === "listed" && !a.listedAt) a.listedAt = new Date().toISOString();
    if (a.status === undefined) a.status = "draft";
    if (!a.slug && input.slugBase) {
      const taken = new Set(this.agents.map((x) => x.slug).filter(Boolean));
      let slug = input.slugBase;
      while (taken.has(slug)) slug = `${input.slugBase}-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")}`;
      a.slug = slug;
    }
    return { stored: keys, missing: [], slug: (a.slug as string | undefined) ?? null };
  }
}

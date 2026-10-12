import { randomUUID } from "node:crypto";
import { SchemaNotReadyError } from "./runs-store.js";
import type { AgentVersion, GithubAgent, GithubAgentsRepository, GithubInstallation } from "./github-agents-repository.js";

export class FakeGithubAgentsRepository implements GithubAgentsRepository {
  installations: GithubInstallation[] = [];
  agents: Omit<GithubAgent, "latestVersion">[] = [];
  versions: AgentVersion[] = [];
  /** false simulates the unapplied 0002 migration: every call throws SchemaNotReadyError. */
  schemaReady = true;

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
    const latest = this.versions.filter((v) => v.agentId === a.id).at(-1);
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

  async createAgentVersion(input: { agentId: string; commitSha: string; files: AgentVersion["files"] }) {
    this.check();
    const existing = this.versions.find((v) => v.agentId === input.agentId && v.commitSha === input.commitSha);
    if (existing) return existing;
    const v: AgentVersion = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
    this.versions.push(v);
    return v;
  }
}

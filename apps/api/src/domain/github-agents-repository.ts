import type { AgentFile } from "../github/agent-files.js";

/**
 * Storage seam for the GitHub App connector (lane C). Kept apart from `Repository` so this lane
 * does not edit the shared repository files; same pattern: a Pg implementation for production and
 * an in-memory fake for tests. Tables: github_installations, agents (connector='github'),
 * agent_versions — db/migrations/0002_github_agents.sql.
 */
export interface GithubInstallation {
  installationId: number;
  ownerWallet: string;
  accountLogin: string | null;
  createdAt: string;
}

export interface GithubAgent {
  id: string;
  ownerWallet: string;
  name: string;
  installationId: number;
  repoFullName: string;
  agentPath: string;
  model: string;
  connector: "github";
  latestVersion: { id: string; commitSha: string; fileCount: number; createdAt: string } | null;
}

export interface AgentVersion {
  id: string;
  agentId: string;
  commitSha: string;
  files: AgentFile[];
  createdAt: string;
}

export interface GithubAgentsRepository {
  /** Upsert. Returns null when the installation already belongs to ANOTHER wallet (first bind wins). */
  bindInstallation(input: { installationId: number; ownerWallet: string; accountLogin: string | null }): Promise<GithubInstallation | null>;
  getInstallation(installationId: number): Promise<GithubInstallation | null>;
  listInstallations(ownerWallet: string): Promise<GithubInstallation[]>;
  /** Upsert by (owner wallet, name). */
  upsertGithubAgent(input: {
    ownerWallet: string;
    name: string;
    installationId: number;
    repoFullName: string;
    agentPath: string;
    model: string;
  }): Promise<Omit<GithubAgent, "latestVersion">>;
  getGithubAgent(id: string): Promise<GithubAgent | null>;
  listGithubAgents(ownerWallet: string): Promise<GithubAgent[]>;
  /** Idempotent per (agent, commit): a refresh at an unchanged HEAD returns the existing version. */
  createAgentVersion(input: { agentId: string; commitSha: string; files: AgentFile[] }): Promise<AgentVersion>;
}

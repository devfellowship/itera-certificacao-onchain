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
  /** Columns added by the evaluations migration (0008, U6). Absent (undefined) until it is applied. */
  slug?: string | null;
  description?: string | null;
  visibility?: string | null;
  status?: string | null;
  branch?: string | null;
  pinnedCommit?: string | null;
  modelRelease?: string | null;
  listedAt?: string | null;
  createdAt?: string | null;
}

/** Fields POST /agents may set beyond the 0002 columns (U8). */
export interface AgentMetaInput {
  description?: string | null;
  visibility?: "private" | "listed";
  branch?: string | null;
  pinnedCommit?: string | null;
  modelRelease?: string | null;
  /** kebab-case base; the store appends 4 hex when it is taken. */
  slugBase?: string | null;
}

export interface AgentMetaResult {
  /** Input fields the store wrote. */
  stored: string[];
  /** Input fields the store could not write because their column does not exist yet. */
  missing: string[];
  slug: string | null;
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
  /** `makeCurrent`: an existing (agent, commit) row becomes the latest version again (re-pin to an
   * older commit). POST /runs runs the latest version, so the pinned commit is what runs. */
  createAgentVersion(input: { agentId: string; commitSha: string; files: AgentFile[]; makeCurrent?: boolean }): Promise<AgentVersion>;
  /** Writes the U8 fields whose columns exist; never fails because a column is missing. */
  updateAgentMeta(agentId: string, input: AgentMetaInput): Promise<AgentMetaResult>;
}

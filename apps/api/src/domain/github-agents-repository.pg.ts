import type { Pool } from "pg";
import type { AgentVersion, GithubAgent, GithubAgentsRepository, GithubInstallation } from "./github-agents-repository.js";
import { SchemaNotReadyError } from "./runs-store.js";

export const GITHUB_AGENTS_MIGRATION = "0002_github_agents.sql";
const MISSING_SCHEMA_CODES = new Set(["42P01", "42703"]); // undefined_table, undefined_column

/** A missing 0002 table/column becomes SchemaNotReadyError (the router answers 503), not a 500. */
export function rethrowMissingSchema(e: unknown): never {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
  if (code && MISSING_SCHEMA_CODES.has(code)) throw new SchemaNotReadyError(GITHUB_AGENTS_MIGRATION, e);
  throw e;
}

/**
 * Pg implementation. Requires db/migrations/0002_github_agents.sql to be applied.
 *
 * `agents.vendor_id` and `agents.endpoint_url` predate the GitHub connector; to stay compatible
 * with the existing constraints, a GitHub agent gets one vendor per wallet (display_name
 * "wallet:<address>") and a descriptive endpoint_url "github://<repo>/<path>" that no code calls.
 */
type InstallationRow = { installation_id: string; owner_wallet: string; account_login: string | null; created_at: Date | string };
type AgentRow = {
  id: string;
  owner_wallet: string;
  name: string;
  gh_installation_id: string;
  repo_full_name: string;
  agent_path: string;
  model: string;
  v_id: string | null;
  v_commit_sha: string | null;
  v_file_count: number | null;
  v_created_at: Date | string | null;
};

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : d);

function toInstallation(r: InstallationRow): GithubInstallation {
  return { installationId: Number(r.installation_id), ownerWallet: r.owner_wallet, accountLogin: r.account_login, createdAt: iso(r.created_at) };
}

function toAgent(r: AgentRow): GithubAgent {
  return {
    id: r.id,
    ownerWallet: r.owner_wallet,
    name: r.name,
    installationId: Number(r.gh_installation_id),
    repoFullName: r.repo_full_name,
    agentPath: r.agent_path,
    model: r.model,
    connector: "github",
    latestVersion: r.v_id
      ? { id: r.v_id, commitSha: r.v_commit_sha!, fileCount: Number(r.v_file_count ?? 0), createdAt: iso(r.v_created_at!) }
      : null,
  };
}

const AGENT_SELECT = `
  select a.id, a.owner_wallet, a.name, a.gh_installation_id, a.repo_full_name, a.agent_path, a.model,
         v.id as v_id, v.commit_sha as v_commit_sha, jsonb_array_length(v.files) as v_file_count, v.created_at as v_created_at
  from public.agents a
  left join lateral (
    select id, commit_sha, files, created_at from public.agent_versions
    where agent_id = a.id order by created_at desc limit 1
  ) v on true
  where a.connector = 'github'`;

class PgGithubAgentsQueries implements GithubAgentsRepository {
  constructor(private readonly pool: () => Pool) {}

  async bindInstallation(input: { installationId: number; ownerWallet: string; accountLogin: string | null }) {
    // First bind wins: the update only fires when the row already belongs to the same wallet.
    const r = await this.pool().query<InstallationRow>(
      `insert into public.github_installations (installation_id, owner_wallet, account_login)
       values ($1, $2, $3)
       on conflict (installation_id) do update set account_login = excluded.account_login
         where public.github_installations.owner_wallet = excluded.owner_wallet
       returning installation_id, owner_wallet, account_login, created_at`,
      [input.installationId, input.ownerWallet, input.accountLogin],
    );
    return r.rows[0] ? toInstallation(r.rows[0]) : null;
  }

  async getInstallation(installationId: number) {
    const r = await this.pool().query<InstallationRow>(
      `select installation_id, owner_wallet, account_login, created_at from public.github_installations where installation_id = $1`,
      [installationId],
    );
    return r.rows[0] ? toInstallation(r.rows[0]) : null;
  }

  async listInstallations(ownerWallet: string) {
    const r = await this.pool().query<InstallationRow>(
      `select installation_id, owner_wallet, account_login, created_at from public.github_installations
       where owner_wallet = $1 order by created_at`,
      [ownerWallet],
    );
    return r.rows.map(toInstallation);
  }

  async upsertGithubAgent(input: { ownerWallet: string; name: string; installationId: number; repoFullName: string; agentPath: string; model: string }) {
    const client = await this.pool().connect();
    try {
      await client.query("begin");
      const vendorName = `wallet:${input.ownerWallet}`;
      let vendor = await client.query<{ id: string }>(`select id from public.vendors where display_name = $1 limit 1`, [vendorName]);
      if (!vendor.rows[0]) {
        vendor = await client.query<{ id: string }>(`insert into public.vendors (display_name) values ($1) returning id`, [vendorName]);
      }
      const r = await client.query<{ id: string }>(
        `insert into public.agents
           (vendor_id, name, endpoint_url, owner_wallet, gh_installation_id, repo_full_name, agent_path, model, connector)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'github')
         on conflict (vendor_id, name) do update set
           endpoint_url = excluded.endpoint_url, owner_wallet = excluded.owner_wallet,
           gh_installation_id = excluded.gh_installation_id, repo_full_name = excluded.repo_full_name,
           agent_path = excluded.agent_path, model = excluded.model, connector = 'github'
         returning id`,
        [
          vendor.rows[0]!.id,
          input.name,
          `github://${input.repoFullName}/${input.agentPath}`,
          input.ownerWallet,
          input.installationId,
          input.repoFullName,
          input.agentPath,
          input.model,
        ],
      );
      await client.query("commit");
      return { id: r.rows[0]!.id, connector: "github" as const, ...input };
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async getGithubAgent(id: string) {
    const r = await this.pool().query<AgentRow>(`${AGENT_SELECT} and a.id = $1`, [id]);
    return r.rows[0] ? toAgent(r.rows[0]) : null;
  }

  async listGithubAgents(ownerWallet: string) {
    const r = await this.pool().query<AgentRow>(`${AGENT_SELECT} and a.owner_wallet = $1 order by a.name`, [ownerWallet]);
    return r.rows.map(toAgent);
  }

  async createAgentVersion(input: { agentId: string; commitSha: string; files: AgentVersion["files"] }) {
    const r = await this.pool().query<{ id: string; agent_id: string; commit_sha: string; files: AgentVersion["files"]; created_at: Date | string }>(
      `with ins as (
         insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, $3::jsonb)
         on conflict (agent_id, commit_sha) do nothing
         returning id, agent_id, commit_sha, files, created_at
       )
       select * from ins
       union all
       select id, agent_id, commit_sha, files, created_at from public.agent_versions
       where agent_id = $1 and commit_sha = $2 and not exists (select 1 from ins)`,
      [input.agentId, input.commitSha, JSON.stringify(input.files)],
    );
    const row = r.rows[0]!;
    return { id: row.id, agentId: row.agent_id, commitSha: row.commit_sha, files: row.files, createdAt: iso(row.created_at) };
  }
}

/** Production store: every call goes through the 0002 schema guard. */
export class PgGithubAgentsRepository implements GithubAgentsRepository {
  private readonly q: PgGithubAgentsQueries;

  constructor(pool: () => Pool) {
    this.q = new PgGithubAgentsQueries(pool);
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      rethrowMissingSchema(e);
    }
  }

  bindInstallation(input: Parameters<GithubAgentsRepository["bindInstallation"]>[0]) {
    return this.guard(() => this.q.bindInstallation(input));
  }
  getInstallation(installationId: number) {
    return this.guard(() => this.q.getInstallation(installationId));
  }
  listInstallations(ownerWallet: string) {
    return this.guard(() => this.q.listInstallations(ownerWallet));
  }
  upsertGithubAgent(input: Parameters<GithubAgentsRepository["upsertGithubAgent"]>[0]) {
    return this.guard(() => this.q.upsertGithubAgent(input));
  }
  getGithubAgent(id: string) {
    return this.guard(() => this.q.getGithubAgent(id));
  }
  listGithubAgents(ownerWallet: string) {
    return this.guard(() => this.q.listGithubAgents(ownerWallet));
  }
  createAgentVersion(input: Parameters<GithubAgentsRepository["createAgentVersion"]>[0]) {
    return this.guard(() => this.q.createAgentVersion(input));
  }
}

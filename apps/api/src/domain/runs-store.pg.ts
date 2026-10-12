import type { Pool, PoolClient } from "pg";
import {
  SchemaNotReadyError,
  type AgentVersionRef,
  type AsyncRun,
  type CostStats,
  type OwnedAgent,
  type ProofRecord,
  type RunActionRow,
  type RunsStore,
} from "./runs-store.js";

const UNDEFINED_TABLE = "42P01";
const UNDEFINED_COLUMN = "42703";

function pgCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

function isMissingSchema(e: unknown): boolean {
  const code = pgCode(e);
  return code === UNDEFINED_TABLE || code === UNDEFINED_COLUMN;
}

/** Re-throws a missing table/column as SchemaNotReadyError, everything else unchanged. */
function rethrow(migration: string, e: unknown): never {
  if (isMissingSchema(e)) throw new SchemaNotReadyError(migration, e);
  throw e;
}

const RUN_COLUMNS = `
  r.id, r.owner_wallet, rd.agent_id, r.agent_version_id, r.task_pack_id, r.task_pack_version,
  r.status, r.phase, r.run_start_sig, r.evidence_manifest, r.score_total, r.error,
  r.started_at, r.completed_at, r.model_cost_usd, r.model_tokens_in, r.model_tokens_out, r.evaluation_id, r.retry_of_run_id`;

interface RunRow {
  id: string;
  owner_wallet: string | null;
  agent_id: string | null;
  agent_version_id: string | null;
  task_pack_id: string;
  task_pack_version: string;
  status: AsyncRun["status"];
  phase: AsyncRun["phase"];
  run_start_sig: string | null;
  evidence_manifest: unknown | null;
  score_total: number | null;
  error: string | null;
  started_at: Date | string;
  completed_at: Date | string | null;
  /** numeric → string in node-postgres. */
  model_cost_usd: string | number | null;
  model_tokens_in: number | null;
  model_tokens_out: number | null;
  evaluation_id?: string | null;
  retry_of_run_id?: string | null;
}

function numOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function toRun(row: RunRow): AsyncRun {
  return {
    id: row.id,
    ownerWallet: row.owner_wallet,
    agentId: row.agent_id,
    agentVersionId: row.agent_version_id,
    taskPackId: row.task_pack_id,
    taskPackVersion: row.task_pack_version,
    status: row.status,
    phase: row.phase,
    runStartSig: row.run_start_sig,
    evidenceManifest: row.evidence_manifest,
    scoreTotal: row.score_total,
    error: row.error,
    startedAt: iso(row.started_at)!,
    completedAt: iso(row.completed_at),
    modelCostUsd: numOrNull(row.model_cost_usd),
    modelTokensIn: numOrNull(row.model_tokens_in),
    modelTokensOut: numOrNull(row.model_tokens_out),
    evaluationId: row.evaluation_id ?? null,
    retryOfRunId: row.retry_of_run_id ?? null,
  };
}

export class PgRunsStore implements RunsStore {
  constructor(private readonly pool: Pool) {}

  async getAgent(agentId: string): Promise<OwnedAgent | null> {
    try {
      const result = await this.pool.query<{
        id: string;
        owner_wallet: string | null;
        repo_full_name: string | null;
        agent_path: string | null;
        model: string | null;
      }>(`select id, owner_wallet, repo_full_name, agent_path, model from public.agents where id = $1`, [agentId]);
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        ownerWallet: row.owner_wallet,
        repoFullName: row.repo_full_name,
        agentPath: row.agent_path ?? ".",
        model: row.model,
      };
    } catch (e) {
      rethrow("0002 (agents.owner_wallet, lane C)", e);
    }
  }

  async latestAgentVersion(agentId: string): Promise<AgentVersionRef | null> {
    try {
      const result = await this.pool.query<{ id: string; agent_id: string; commit_sha: string }>(
        `select id, agent_id, commit_sha from public.agent_versions
         where agent_id = $1 order by created_at desc limit 1`,
        [agentId],
      );
      const row = result.rows[0];
      return row ? { id: row.id, agentId: row.agent_id, commitSha: row.commit_sha } : null;
    } catch (e) {
      rethrow("0002 (agent_versions, lane C)", e);
    }
  }

  async getAgentVersion(id: string): Promise<AgentVersionRef | null> {
    try {
      const result = await this.pool.query<{ id: string; agent_id: string; commit_sha: string }>(
        `select id, agent_id, commit_sha from public.agent_versions where id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row ? { id: row.id, agentId: row.agent_id, commitSha: row.commit_sha } : null;
    } catch (e) {
      rethrow("0002 (agent_versions, lane C)", e);
    }
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
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query("begin");
      // Serialize run creation per wallet for the rest of this transaction (released at commit).
      await client.query(`select pg_advisory_xact_lock(hashtext('itera-runs:' || $1))`, [input.ownerWallet]);
      const count = await client.query<{ n: string }>(
        `select count(*) as n from public.runs
         where owner_wallet = $1 and started_at > now() - interval '24 hours'`,
        [input.ownerWallet],
      );
      if (Number(count.rows[0]!.n) >= input.dailyLimit) {
        await client.query("rollback");
        return null;
      }
      // The legacy schema requires a release declaration. For a repo-backed agent the release is
      // the synced commit.
      const release = await client.query<{ id: string }>(
        `insert into public.release_declarations (agent_id, release_ref)
         values ($1, $2)
         on conflict (agent_id, release_ref) do update set release_ref = excluded.release_ref
         returning id`,
        [input.agentId, input.agentVersion.commitSha],
      );
      const inserted = await client.query<{ id: string }>(
        `insert into public.runs
           (release_declaration_id, task_pack_id, task_pack_version, nonce, status, owner_wallet, agent_version_id, model_api_key_enc)
         values ($1, $2, $3, $4, 'queued', $5, $6, $7)
         returning id`,
        [release.rows[0]!.id, input.taskPackId, input.taskPackVersion, input.nonce, input.ownerWallet, input.agentVersion.id, input.modelApiKeyEnc],
      );
      await client.query("commit");
      return this.getRun(inserted.rows[0]!.id);
    } catch (e) {
      if (client) await client.query("rollback").catch(() => undefined);
      return rethrow("0001_runs_async.sql", e);
    } finally {
      client?.release();
    }
  }

  async getRun(id: string): Promise<AsyncRun | null> {
    try {
      const result = await this.pool.query<RunRow>(
        `select ${RUN_COLUMNS}
         from public.runs r join public.release_declarations rd on rd.id = r.release_declaration_id
         where r.id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row ? toRun(row) : null;
    } catch (e) {
      rethrow("0001_runs_async.sql", e);
    }
  }

  async listRunsByOwner(wallet: string, limit: number): Promise<AsyncRun[]> {
    try {
      const result = await this.pool.query<RunRow>(
        `select ${RUN_COLUMNS}
         from public.runs r join public.release_declarations rd on rd.id = r.release_declaration_id
         where r.owner_wallet = $1
         order by r.started_at desc
         limit $2`,
        [wallet, limit],
      );
      return result.rows.map(toRun);
    } catch (e) {
      rethrow("0001_runs_async.sql", e);
    }
  }

  async getPatch(runId: string): Promise<string | null> {
    const result = await this.pool.query<{ output_artifact_content: string | null }>(
      `select output_artifact_content from public.observations
       where run_id = $1 and mode = 'observed' and output_artifact_content is not null
       order by occurred_at desc limit 1`,
      [runId],
    );
    return result.rows[0]?.output_artifact_content ?? null;
  }

  async countActions(runId: string): Promise<number | null> {
    try {
      const result = await this.pool.query<{ n: string }>(`select count(*) as n from public.run_actions where run_id = $1`, [runId]);
      return Number(result.rows[0]!.n);
    } catch (e) {
      if (isMissingSchema(e)) return null;
      throw e;
    }
  }

  async listActions(runId: string, afterSeq: number, limit: number): Promise<RunActionRow[] | null> {
    try {
      const result = await this.pool.query<{ seq: number; tool: string; target: string | null; ok: boolean | null; occurred_at: Date | string }>(
        `select seq, tool, target, ok, occurred_at from public.run_actions where run_id = $1 and seq > $2 order by seq asc limit $3`,
        [runId, afterSeq, limit],
      );
      return result.rows.map((r) => ({
        seq: Number(r.seq),
        tool: r.tool,
        target: r.target,
        ok: r.ok,
        occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
      }));
    } catch (e) {
      if (isMissingSchema(e)) return null;
      throw e;
    }
  }

  async getProof(runId: string): Promise<ProofRecord | null> {
    try {
      const result = await this.pool.query<{
        run_id: string;
        status: ProofRecord["status"];
        manifest_sha256: string | null;
        nft_mint: string | null;
        tx_sig: string | null;
        evidence_cid: string | null;
        attestation_address: string | null;
        error: string | null;
      }>(
        `select run_id, status, manifest_sha256, nft_mint, tx_sig, evidence_cid, attestation_address, error
         from public.proofs where run_id = $1`,
        [runId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        runId: row.run_id,
        status: row.status,
        manifestSha256: row.manifest_sha256,
        nftMint: row.nft_mint,
        txSig: row.tx_sig,
        evidenceCid: row.evidence_cid,
        attestationAddress: row.attestation_address,
        error: row.error,
      };
    } catch (e) {
      if (isMissingSchema(e)) return null;
      throw e;
    }
  }

  async costStats(taskPackId: string, taskPackVersion: string, model: string): Promise<CostStats> {
    try {
      const result = await this.pool.query<{ n: string; cost: string | null; tin: string | null; tout: string | null }>(
        `select count(*) as n, avg(model_cost_usd) as cost, avg(model_tokens_in) as tin, avg(model_tokens_out) as tout
           from public.runs
          where task_pack_id = $1 and task_pack_version = $2
            and model_cost_usd is not null
            and completed_at is not null
            and evidence_manifest -> 'runner' ->> 'model' = $3`,
        [taskPackId, taskPackVersion, model],
      );
      const row = result.rows[0]!;
      return { runs: Number(row.n), avgCostUsd: numOrNull(row.cost), avgTokensIn: numOrNull(row.tin), avgTokensOut: numOrNull(row.tout) };
    } catch (e) {
      if (isMissingSchema(e)) return { runs: 0, avgCostUsd: null, avgTokensIn: null, avgTokensOut: null };
      throw e;
    }
  }
}

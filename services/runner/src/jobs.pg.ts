import type { Pool, PoolClient } from 'pg';
import { artifactRef } from '@itera/contracts/run-artifacts';
import type { McpCatalogRef } from './mcp-sidecar.js';
import { LOST_RUN_REQUEUED, type AgentFile, type ClaimedRun, type JobStore, type RunJob, type RunOutcome, type RunPhase } from './jobs.js';

/** Claim SQL from the shared contract, verbatim apart from the selected columns. */
export const CLAIM_SQL = `
  update public.runs
     set status = 'running', phase = 'preparing', claimed_at = now(), worker_id = $1
   where id = (
     select id from public.runs
      where status = 'queued'
      order by started_at
      for update skip locked
      limit 1)
  returning id, task_pack_id, task_pack_version, agent_version_id`;

const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** The result-plane tenant of a hosted run's grader rows: TMA_RESULT_TENANT, else the fleet (plan ADR-4). */
export const DEFAULT_RESULT_TENANT = 'devfellowship';
export function resultTenantFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const t = env.TMA_RESULT_TENANT?.trim();
  return t && TENANT_RE.test(t) ? t : DEFAULT_RESULT_TENANT;
}

const RECHECK_MS = 60_000;

export interface PgJobStoreOptions {
  /** Tenant of the grader rows (default: resultTenantFromEnv()). */
  tenant?: string;
  /** Called when the optional eval-results write fails and the run result is written without it. */
  warn?: (entry: Record<string, unknown>) => void;
  /** Test seam for the schema probe clock. */
  now?: () => number;
}

export class PgJobStore implements JobStore {
  private readonly tenant: string;
  private readonly warn: (entry: Record<string, unknown>) => void;
  private readonly now: () => number;
  private evalSchema = false;
  private evalCheckedAt = Number.NEGATIVE_INFINITY;
  private metaSchema = false;
  private metaCheckedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly pool: Pool, options: PgJobStoreOptions = {}) {
    this.tenant = options.tenant ?? resultTenantFromEnv();
    this.warn = options.warn ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  /**
   * Is migration 0023 (eval results, trajectory columns) applied? TMA applies its migrations by hand, after the
   * runner image may already be deployed, so the runner must keep writing the old shape until then. Same rule
   * as apps/api hasEvalResultsSchema: `true` is cached for the life of the process, `false` is re-asked at
   * most once a minute. `run_actions.retry_of` is the last column of the file, and the file is one transaction.
   */
  async hasEvalResultsSchema(): Promise<boolean> {
    if (this.evalSchema) return true;
    const now = this.now();
    if (now - this.evalCheckedAt < RECHECK_MS) return false;
    this.evalCheckedAt = now;
    try {
      const r = await this.pool.query(
        `select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'run_actions' and column_name = 'retry_of'`,
      );
      this.evalSchema = r.rows.length > 0;
    } catch {
      this.evalSchema = false;
    }
    return this.evalSchema;
  }

  /**
   * Is migration 0024 (the tma-trajectory/2 step columns step_kind, started_ms, turn_origin) applied? Same cache rule
   * as hasEvalResultsSchema. Until it is, the worker writes the tma-trajectory/1 columns only.
   */
  async hasTrajectoryV2Schema(): Promise<boolean> {
    if (this.metaSchema) return true;
    const now = this.now();
    if (now - this.metaCheckedAt < RECHECK_MS) return false;
    this.metaCheckedAt = now;
    try {
      const r = await this.pool.query(
        `select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'run_actions' and column_name = 'turn_origin'`,
      );
      this.metaSchema = r.rows.length > 0;
    } catch {
      this.metaSchema = false;
    }
    return this.metaSchema;
  }

  /** ADR-11: a published Itera MCP catalog version (0013_mcp_catalog.sql). Null if absent or not published. */
  async mcpCatalog(name: string, version: number): Promise<McpCatalogRef | null> {
    const r = await this.pool.query<{ image: string; image_digest: string; manifest: McpCatalogRef['manifest']; tools_snapshot: McpCatalogRef['tools'] }>(
      `select image, image_digest, manifest, tools_snapshot from public.mcp_catalog
        where name = $1 and version = $2 and status = 'published' and image_digest is not null`,
      [name, version],
    );
    const row = r.rows[0];
    return row ? { name, version, image: row.image, imageDigest: row.image_digest, manifest: row.manifest ?? {}, tools: row.tools_snapshot ?? [] } : null;
  }

  async claim(workerId: string): Promise<ClaimedRun | null> {
    const result = await this.pool.query<{
      id: string;
      task_pack_id: string;
      task_pack_version: string;
      agent_version_id: string | null;
    }>(CLAIM_SQL, [workerId]);
    const row = result.rows[0];
    if (!row) return null;
    return { runId: row.id, scenarioId: row.task_pack_id, scenarioVersion: row.task_pack_version, agentVersionId: row.agent_version_id };
  }

  async loadJob(run: ClaimedRun): Promise<RunJob | null> {
    if (!run.agentVersionId) return null;
    const result = await this.pool.query<{ files: unknown; model: string | null; model_api_key_enc: string | null; commit_sha: string | null }>(
      `select av.files, a.model, r.model_api_key_enc, av.commit_sha
         from public.runs r
         join public.agent_versions av on av.id = r.agent_version_id
         join public.agents a on a.id = av.agent_id
        where r.id = $1 and av.id = $2`,
      [run.runId, run.agentVersionId],
    );
    const row = result.rows[0];
    if (!row || !Array.isArray(row.files) || !row.model) return null;
    return { ...run, model: row.model, files: row.files as AgentFile[], modelApiKeyEnc: row.model_api_key_enc, agentCommit: row.commit_sha };
  }

  async setPhase(runId: string, workerId: string, phase: RunPhase): Promise<void> {
    await this.pool.query(`update public.runs set phase = $3 where id = $1 and worker_id = $2 and status = 'running'`, [runId, workerId, phase]);
  }

  async finish(runId: string, workerId: string, outcome: RunOutcome): Promise<void> {
    const p = outcome.provenance ?? null;
    // Asked before the transaction: a failed probe inside it would abort it.
    const evalSchema = await this.hasEvalResultsSchema();
    const trajectoryV2 = evalSchema && (await this.hasTrajectoryV2Schema());
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const updated = await client.query(
        `update public.runs
            set status = $3, phase = $4, evidence_manifest = $5, score_total = $6, error = $7, completed_at = now(),
                model_api_key_enc = null,
                model_cost_usd = $8, model_tokens_in = $9, model_tokens_out = $10,
                model_route = $11, model_requested = $12, model_effective = $13, model_provider = $14,
                model_cost_source = $15, rate_limited = $16, wall_ms = $17, timeout_s = $18, provenance = $19
          where id = $1 and worker_id = $2 and status = 'running'`,
        [
          runId,
          workerId,
          outcome.status,
          outcome.phase,
          JSON.stringify(outcome.evidenceManifest),
          outcome.scoreTotal,
          outcome.error,
          outcome.cost?.costUsd ?? null,
          outcome.cost?.tokensIn ?? null,
          outcome.cost?.tokensOut ?? null,
          p?.route ?? null,
          p?.modelRequested ?? null,
          p?.modelEffective ?? null,
          p?.modelProvider ?? null,
          p?.costSource ?? null,
          p ? p.rateLimited : null,
          p?.wallMs ?? null,
          p?.timeoutS ?? null,
          p ? JSON.stringify(p.record) : null,
        ],
      );
      if (updated.rowCount !== 1) {
        // The run was reaped or re-claimed meanwhile: write nothing.
        await client.query('rollback');
        return;
      }
      if (outcome.patch !== null) {
        await client.query(
          `insert into public.observations (run_id, output_artifact_ref, output_artifact_content, mode)
           values ($1, 'patch.diff', $2, 'observed')`,
          [runId, outcome.patch],
        );
      }
      // L17a: one observations row per stored artifact, next to the patch row and in the same transaction.
      // Encoding: @itera/contracts/run-artifacts (ref 'artifact:' + path; content utf-8 or base64; digest = sha256 of the raw bytes).
      const artifacts = outcome.artifacts ?? [];
      if (artifacts.length > 0) {
        await client.query(
          `insert into public.observations (run_id, output_artifact_ref, output_artifact_content, response_digest, mode)
           select $1, a.ref, a.content, a.digest, 'observed'
             from unnest($2::text[], $3::text[], $4::text[]) as a(ref, content, digest)`,
          [runId, artifacts.map((a) => artifactRef(a.path)), artifacts.map((a) => a.content), artifacts.map((a) => a.sha256)],
        );
      }
      const actionsDone = evalSchema ? await this.insertTrajectory(client, runId, outcome, trajectoryV2) : false;
      if (!actionsDone && outcome.actions.length > 0) {
        await client.query(
          `insert into public.run_actions (run_id, seq, tool, target, ok, occurred_at)
           select $1, a.seq, a.tool, a.target, a.ok, a.occurred_at
             from unnest($2::int[], $3::text[], $4::text[], $5::boolean[], $6::timestamptz[])
                  as a(seq, tool, target, ok, occurred_at)
           on conflict (run_id, seq) do nothing`,
          [
            runId,
            outcome.actions.map((a) => a.seq),
            outcome.actions.map((a) => a.tool),
            outcome.actions.map((a) => a.target),
            outcome.actions.map((a) => a.ok),
            outcome.actions.map((a) => a.occurredAt),
          ],
        );
      }
      if (evalSchema) await this.writeEvalResults(client, runId, outcome);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 0023: the run_actions rows with the tma-trajectory/1 columns. Runs in a savepoint: if the write fails the
   * savepoint is rolled back and the caller writes the old columns, so a result is never lost to the extra
   * record. Returns true when the rows are written (or there are none to write).
   */
  private async insertTrajectory(client: PoolClient, runId: string, outcome: RunOutcome, v2: boolean): Promise<boolean> {
    const actions = outcome.actions;
    if (actions.length === 0) return true;
    // Steps without a trajectory (a caller that built the actions by hand) take the old columns.
    if (actions.some((a) => !a.trajectory)) return false;
    const t = actions.map((a) => a.trajectory!);
    await client.query('savepoint run_actions_trajectory');
    try {
      await client.query(
        `insert into public.run_actions
           (run_id, seq, tool, target, ok, occurred_at, parent_seq, turn, tool_family, status, error_class,
            duration_ms, tokens_in, tokens_out, target_kind, args_sha256, result_sha256, retry_of${v2 ? ', step_kind, started_ms, turn_origin' : ''})
         select $1, a.seq, a.tool, a.target, a.ok, a.occurred_at, a.parent_seq, a.turn, a.tool_family, a.status, a.error_class,
                a.duration_ms, a.tokens_in, a.tokens_out, a.target_kind, a.args_sha256, a.result_sha256, a.retry_of${v2 ? ', a.step_kind, a.started_ms, a.turn_origin' : ''}
           from unnest($2::int[], $3::text[], $4::text[], $5::boolean[], $6::timestamptz[], $7::int[], $8::int[], $9::text[],
                       $10::text[], $11::text[], $12::int[], $13::bigint[], $14::bigint[], $15::text[], $16::text[], $17::text[], $18::int[]${v2 ? ', $19::text[], $20::int[], $21::text[]' : ''})
                as a(seq, tool, target, ok, occurred_at, parent_seq, turn, tool_family, status, error_class,
                     duration_ms, tokens_in, tokens_out, target_kind, args_sha256, result_sha256, retry_of${v2 ? ', step_kind, started_ms, turn_origin' : ''})
         on conflict (run_id, seq) do nothing`,
        [
          runId,
          actions.map((a) => a.seq),
          actions.map((a) => a.tool),
          actions.map((a) => a.target),
          actions.map((a) => a.ok),
          actions.map((a) => a.occurredAt),
          t.map((x) => x.parentSeq),
          t.map((x) => x.turn),
          t.map((x) => x.toolFamily),
          t.map((x) => x.status),
          t.map((x) => x.errorClass),
          t.map((x) => x.durationMs),
          t.map((x) => x.tokensIn),
          t.map((x) => x.tokensOut),
          t.map((x) => x.targetKind),
          t.map((x) => x.argsSha256),
          t.map((x) => x.resultSha256),
          t.map((x) => x.retryOf),
          // 0024 (tma-trajectory/2). A step built before T10 has none of the three: null.
          ...(v2 ? [t.map((x) => x.stepKind ?? null), t.map((x) => x.startedMs ?? null), t.map((x) => x.turnOrigin ?? null)] : []),
        ],
      );
      await client.query('release savepoint run_actions_trajectory');
      return true;
    } catch (err) {
      await client.query('rollback to savepoint run_actions_trajectory');
      this.warn({ event: 'trajectory_write_failed', runId, error: String((err as Error)?.message ?? err).slice(0, 300) });
      return false;
    }
  }

  /** 0023: runs.infra_ok and the grader_results rows of the run. A failure here never loses the run result. */
  private async writeEvalResults(client: PoolClient, runId: string, outcome: RunOutcome): Promise<void> {
    const graders = outcome.graders ?? [];
    if (outcome.infraOk === undefined && graders.length === 0) return;
    await client.query('savepoint run_eval_results');
    try {
      if (outcome.infraOk !== undefined) {
        await client.query(`update public.runs set infra_ok = $2 where id = $1`, [runId, outcome.infraOk]);
      }
      for (const g of graders) {
        const gv = (
          await client.query(
            `insert into public.grader_versions (tenant, grader_id, semver, kind, code_sha256) values ($1, $2, $3, $4, $5)
             on conflict on constraint grader_versions_key do update set kind = public.grader_versions.kind
             returning id, kind`,
            [this.tenant, g.id, g.semver, g.kind, g.codeSha256],
          )
        ).rows[0];
        if (gv.kind !== g.kind) throw new Error(`grader ${g.id}@${g.semver} exists with kind ${gv.kind}`);
        await client.query(
          `insert into public.grader_results (tenant, run_id, grader_version_id, pass, score, weight, hard_gate, decisive, infra_ok)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [this.tenant, runId, gv.id, g.pass, g.score, g.weight, g.hardGate, g.decisive, outcome.infraOk ?? null],
        );
      }
      await client.query('release savepoint run_eval_results');
    } catch (err) {
      await client.query('rollback to savepoint run_eval_results');
      this.warn({ event: 'eval_results_write_failed', runId, error: String((err as Error)?.message ?? err).slice(0, 300) });
    }
  }

  async reapStale(olderThanMs: number): Promise<number> {
    const result = await this.pool.query(
      `update public.runs
          set status = 'infra_error', phase = 'done', completed_at = now(),
              error = 'runner lost the run (worker restart or crash)', model_api_key_enc = null
        where status = 'running' and claimed_at < now() - ($1::int * interval '1 millisecond')`,
      [olderThanMs],
    );
    return result.rowCount ?? 0;
  }

  async runStates(runIds: string[]): Promise<Map<string, { status: string; workerId: string | null }>> {
    const result = await this.pool.query<{ id: string; status: string; worker_id: string | null }>(
      `select id::text, status, worker_id from public.runs where id::text = any($1::text[])`,
      [runIds],
    );
    return new Map(result.rows.map((r) => [r.id, { status: r.status, workerId: r.worker_id }]));
  }

  async runningRuns(): Promise<Array<{ runId: string; workerId: string | null }>> {
    const result = await this.pool.query<{ id: string; worker_id: string | null }>(`select id::text, worker_id from public.runs where status = 'running'`);
    return result.rows.map((r) => ({ runId: r.id, workerId: r.worker_id }));
  }

  async recoverLost(runId: string, workerId: string | null): Promise<'requeued' | 'failed' | 'skipped'> {
    // One statement: the CASE reads the row as locked by the update, so two booting workers
    // cannot both requeue it.
    const result = await this.pool.query<{ status: string }>(
      `update public.runs
          set status = case when error is null then 'queued' else 'infra_error' end,
              phase = case when error is null then null else 'done' end,
              completed_at = case when error is null then null else now() end,
              model_api_key_enc = case when error is null then model_api_key_enc else null end,
              error = case when error is null then $3 else 'runner lost the run twice (worker restart or crash)' end,
              worker_id = case when error is null then null else worker_id end,
              claimed_at = case when error is null then null else claimed_at end
        where id = $1 and status = 'running' and worker_id is not distinct from $2
        returning status`,
      [runId, workerId, LOST_RUN_REQUEUED],
    );
    const status = result.rows[0]?.status;
    return status === 'queued' ? 'requeued' : status === 'infra_error' ? 'failed' : 'skipped';
  }
}

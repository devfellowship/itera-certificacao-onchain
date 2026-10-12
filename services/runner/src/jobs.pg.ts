import type { Pool } from 'pg';
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

export class PgJobStore implements JobStore {
  constructor(private readonly pool: Pool) {}

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
    const result = await this.pool.query<{ files: unknown; model: string | null; model_api_key_enc: string | null }>(
      `select av.files, a.model, r.model_api_key_enc
         from public.runs r
         join public.agent_versions av on av.id = r.agent_version_id
         join public.agents a on a.id = av.agent_id
        where r.id = $1 and av.id = $2`,
      [run.runId, run.agentVersionId],
    );
    const row = result.rows[0];
    if (!row || !Array.isArray(row.files) || !row.model) return null;
    return { ...run, model: row.model, files: row.files as AgentFile[], modelApiKeyEnc: row.model_api_key_enc };
  }

  async setPhase(runId: string, workerId: string, phase: RunPhase): Promise<void> {
    await this.pool.query(`update public.runs set phase = $3 where id = $1 and worker_id = $2 and status = 'running'`, [runId, workerId, phase]);
  }

  async finish(runId: string, workerId: string, outcome: RunOutcome): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const updated = await client.query(
        `update public.runs
            set status = $3, phase = $4, evidence_manifest = $5, score_total = $6, error = $7, completed_at = now(),
                model_api_key_enc = null,
                model_cost_usd = $8, model_tokens_in = $9, model_tokens_out = $10
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
      if (outcome.actions.length > 0) {
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
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
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

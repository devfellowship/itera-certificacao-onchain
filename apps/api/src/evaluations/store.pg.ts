import type { Pool, PoolClient } from "pg";
import { SchemaNotReadyError, type AgentVersionRef } from "../domain/runs-store.js";
import {
  EvaluationConflictError,
  type AgentForEval,
  type EvalProof,
  type EvalRun,
  type EvalTask,
  type EvaluationListRow,
  type EvaluationRecord,
  type EvaluationsStore,
  type NewQuote,
  type PaymentRecord,
  type ResolvedTask,
  type RollupColumns,
} from "./store.js";

const MIGRATION = "0008_evaluations_payments.sql";

function pgCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}
function isMissingSchema(e: unknown): boolean {
  const c = pgCode(e);
  return c === "42P01" || c === "42703";
}
function rethrow(e: unknown): never {
  if (isMissingSchema(e)) throw new SchemaNotReadyError(MIGRATION, e);
  throw e;
}
function iso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : v;
}
function num(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}
function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function toPayment(r: Row): PaymentRecord {
  return {
    id: r.id,
    evaluationId: r.evaluation_id,
    payerWallet: r.payer_wallet,
    agentId: r.agent_id,
    agentVersionId: r.agent_version_id,
    modelId: r.model_id,
    tasks: (r.tasks ?? []) as EvalTask[],
    taskCount: num(r.task_count),
    priceUsdPerRun: num(r.price_usd_per_run),
    amountUsd: num(r.amount_usd),
    amountLamports: num(r.amount_lamports),
    solUsdRate: num(r.sol_usd_rate),
    priceSource: r.price_source,
    treasury: r.treasury,
    quoteExpiresAt: iso(r.quote_expires_at)!,
    reference: r.reference_pubkey,
    txSig: r.tx_sig,
    status: r.status,
    confirmedAt: iso(r.confirmed_at),
    plannedEvaluationId: r.planned_evaluation_id,
    plannedRunIds: (r.planned_run_ids ?? []) as string[],
    memo: r.memo,
    createdAt: iso(r.created_at)!,
  };
}

const EVAL_SELECT = `
  select e.*, p.tx_sig as payment_tx_sig,
         a.name as agent_name, a.slug as agent_slug, a.owner_wallet as agent_owner_wallet
    from public.evaluations e
    left join public.payments p on p.id = e.payment_id
    left join public.agents a on a.id = e.agent_id`;

function toEvaluation(r: Row): EvaluationListRow {
  return {
    id: r.id,
    slug: r.slug,
    shortId: r.short_id,
    ownerWallet: r.owner_wallet,
    agentId: r.agent_id,
    agentVersionId: r.agent_version_id,
    modelId: r.model_id,
    modelRelease: r.model_release,
    tasks: (r.tasks ?? []) as EvalTask[],
    status: r.status,
    taskCount: num(r.task_count),
    priceUsdPerRun: num(r.price_usd_per_run),
    feeUsd: num(r.fee_usd),
    feeLamports: num(r.fee_lamports),
    solUsdRate: num(r.sol_usd_rate),
    priceSource: r.price_source,
    paymentId: r.payment_id,
    txSig: r.payment_tx_sig ?? null,
    score: numOrNull(r.score),
    passCount: num(r.pass_count),
    failCount: num(r.fail_count),
    invalidCount: num(r.invalid_count),
    testsPassed: num(r.tests_passed),
    testsTotal: num(r.tests_total),
    manifestSha256: r.manifest_sha256,
    isPublic: Boolean(r.is_public),
    freeRetriesUsed: num(r.free_retries_used),
    createdAt: iso(r.created_at)!,
    startedAt: iso(r.started_at),
    completedAt: iso(r.completed_at),
    issuedAt: iso(r.issued_at),
    cancelledAt: iso(r.cancelled_at),
    agentName: r.agent_name ?? "agent",
    agentSlug: r.agent_slug ?? null,
    agentOwnerWallet: r.agent_owner_wallet ?? null,
  };
}

function toRun(r: Row): EvalRun {
  return {
    id: r.id,
    evaluationId: r.evaluation_id,
    seq: num(r.seq),
    taskId: r.task_id,
    taskVersionId: r.task_version_id,
    status: r.status,
    phase: r.phase,
    scoreTotal: numOrNull(r.score_total),
    evidenceManifest: r.evidence_manifest,
    runStartSig: r.run_start_sig,
    error: r.error,
    retryOfRunId: r.retry_of_run_id,
    startedAt: iso(r.started_at)!,
    claimedAt: iso(r.claimed_at),
    completedAt: iso(r.completed_at),
  };
}

const RUN_SELECT = `select id, evaluation_id, seq, task_id, task_version_id, status, phase, score_total, evidence_manifest,
  run_start_sig, error, retry_of_run_id, started_at, claimed_at, completed_at from public.runs`;

export class PgEvaluationsStore implements EvaluationsStore {
  constructor(private readonly pool: Pool) {}

  async getAgent(agentId: string): Promise<AgentForEval | null> {
    try {
      const { rows } = await this.pool.query(
        `select id, owner_wallet, name, slug, repo_full_name, agent_path, model, model_release, visibility, pinned_commit
           from public.agents where id = $1`,
        [agentId],
      );
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        ownerWallet: r.owner_wallet,
        name: r.name,
        slug: r.slug,
        repoFullName: r.repo_full_name,
        agentPath: r.agent_path ?? ".",
        model: r.model,
        modelRelease: r.model_release,
        visibility: r.visibility,
        pinnedCommit: r.pinned_commit,
      };
    } catch (e) {
      rethrow(e);
    }
  }

  async agentVersionFor(agentId: string, pinnedCommit: string | null): Promise<AgentVersionRef | null> {
    const { rows } = await this.pool.query(
      `select id, agent_id, commit_sha from public.agent_versions
        where agent_id = $1 and ($2::text is null or commit_sha = $2)
        order by created_at desc limit 1`,
      [agentId, pinnedCommit],
    );
    const r = rows[0];
    return r ? { id: r.id, agentId: r.agent_id, commitSha: r.commit_sha } : null;
  }

  async getAgentVersion(id: string): Promise<AgentVersionRef | null> {
    const { rows } = await this.pool.query(`select id, agent_id, commit_sha from public.agent_versions where id = $1`, [id]);
    const r = rows[0];
    return r ? { id: r.id, agentId: r.agent_id, commitSha: r.commit_sha } : null;
  }

  async resolveTask(idOrSlug: string): Promise<ResolvedTask | null> {
    try {
      const { rows } = await this.pool.query(
        `select t.id::text as task_id, t.slug, t.name, t.visibility, tv.id::text as task_version_id, tv.version,
                tv.pack_id, tv.pack_version, tv.runnable
           from public.tasks t
           join lateral (select * from public.task_versions v where v.task_id = t.id order by v.version desc limit 1) tv on true
          where t.id::text = $1 or t.slug = $1
          limit 1`,
        [idOrSlug],
      );
      const r = rows[0];
      if (r) {
        return {
          taskId: r.task_id,
          taskVersionId: r.task_version_id,
          slug: r.slug,
          name: r.name,
          packId: r.pack_id ?? "",
          packVersion: r.pack_version ?? "",
          isPublic: r.visibility === "public",
          runnable: Boolean(r.runnable) && Boolean(r.pack_id) && Boolean(r.pack_version),
        };
      }
    } catch (e) {
      // 0007_catalog (U4) not applied yet → the legacy bridge below.
      if (!isMissingSchema(e)) throw e;
    }
    const [id, version] = idOrSlug.split("@");
    const { rows } = await this.pool.query(
      `select id, version from public.task_packs where id = $1 and ($2::text is null or version = $2)
        order by created_at desc limit 1`,
      [id, version ?? null],
    );
    const r = rows[0];
    if (!r) return null;
    return { taskId: r.id, taskVersionId: null, slug: r.id, name: r.id, packId: r.id, packVersion: r.version, isPublic: true, runnable: true };
  }

  async countRecentRuns(wallet: string): Promise<number> {
    const { rows } = await this.pool.query(
      `select count(*) as n from public.runs where owner_wallet = $1 and started_at > now() - interval '24 hours'`,
      [wallet],
    );
    return num(rows[0]?.n);
  }

  async createQuote(q: NewQuote): Promise<PaymentRecord> {
    try {
      const { rows } = await this.pool.query(
        `insert into public.payments
           (payer_wallet, agent_id, agent_version_id, model_id, task_ids, tasks, task_count, price_usd_per_run, amount_usd,
            amount_lamports, sol_usd_rate, price_source, treasury, quote_expires_at, reference_pubkey,
            planned_evaluation_id, planned_run_ids, memo)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         returning *`,
        [
          q.payerWallet, q.agentId, q.agentVersionId, q.modelId, JSON.stringify(q.tasks.map((t) => t.taskId)), JSON.stringify(q.tasks),
          q.taskCount, q.priceUsdPerRun, q.amountUsd, q.amountLamports, q.solUsdRate, q.priceSource, q.treasury, q.quoteExpiresAt,
          q.reference, q.plannedEvaluationId, JSON.stringify(q.plannedRunIds), q.memo,
        ],
      );
      return toPayment(rows[0]!);
    } catch (e) {
      rethrow(e);
    }
  }

  async getPaymentByReference(reference: string): Promise<PaymentRecord | null> {
    try {
      const { rows } = await this.pool.query(`select * from public.payments where reference_pubkey = $1`, [reference]);
      return rows[0] ? toPayment(rows[0]) : null;
    } catch (e) {
      rethrow(e);
    }
  }

  async getPaymentByTxSig(txSig: string): Promise<PaymentRecord | null> {
    try {
      const { rows } = await this.pool.query(`select * from public.payments where tx_sig = $1`, [txSig]);
      return rows[0] ? toPayment(rows[0]) : null;
    } catch (e) {
      rethrow(e);
    }
  }

  async markPaymentFailed(paymentId: string): Promise<void> {
    await this.pool.query(`update public.payments set status = 'failed' where id = $1 and status = 'pending'`, [paymentId]);
  }

  async createEvaluationFromPayment(input: {
    paymentId: string;
    txSig: string;
    ownerWallet: string;
    shortId: string;
    isPublic: boolean;
    modelRelease: string | null;
    modelApiKeyEnc: string | null;
    agentCommit: string;
  }): Promise<{ evaluationId: string; runIds: string[]; created: boolean }> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query("begin");
      const { rows } = await client.query(`select * from public.payments where id = $1 for update`, [input.paymentId]);
      if (!rows[0]) throw new Error("payment not found");
      const p = toPayment(rows[0]);
      if (p.evaluationId) {
        await client.query("commit");
        return { evaluationId: p.evaluationId, runIds: p.plannedRunIds, created: false };
      }
      const other = await client.query(`select id from public.payments where tx_sig = $1 and id <> $2`, [input.txSig, p.id]);
      if (other.rows[0]) throw new EvaluationConflictError("this transaction already paid another quote");

      await client.query(
        `insert into public.evaluations
           (id, short_id, owner_wallet, agent_id, agent_version_id, model_id, model_release, tasks, status, task_count,
            price_usd_per_run, fee_usd, fee_lamports, sol_usd_rate, price_source, payment_id, is_public, model_api_key_enc)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          p.plannedEvaluationId, input.shortId, input.ownerWallet, p.agentId, p.agentVersionId, p.modelId, input.modelRelease,
          JSON.stringify(p.tasks), p.taskCount, p.priceUsdPerRun, p.amountUsd, p.amountLamports, p.solUsdRate, p.priceSource, p.id,
          input.isPublic, input.modelApiKeyEnc,
        ],
      );
      const release = await client.query(
        `insert into public.release_declarations (agent_id, release_ref) values ($1, $2)
         on conflict (agent_id, release_ref) do update set release_ref = excluded.release_ref returning id`,
        [p.agentId, input.agentCommit],
      );
      for (let i = 0; i < p.tasks.length; i++) {
        const t = p.tasks[i]!;
        await client.query(
          `insert into public.runs
             (id, release_declaration_id, task_pack_id, task_pack_version, nonce, status, owner_wallet, agent_version_id,
              model_api_key_enc, run_start_sig, evaluation_id, task_id, task_version_id, seq)
           values ($1,$2,$3,$4,gen_random_uuid()::text,'queued',$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            p.plannedRunIds[i], release.rows[0]!.id, t.packId, t.packVersion, input.ownerWallet, p.agentVersionId,
            input.modelApiKeyEnc, input.txSig, p.plannedEvaluationId, t.taskId, t.taskVersionId, i + 1,
          ],
        );
      }
      await client.query(
        `update public.payments set status = 'confirmed', tx_sig = $2, evaluation_id = $3, confirmed_at = now() where id = $1`,
        [p.id, input.txSig, p.plannedEvaluationId],
      );
      await client.query("commit");
      return { evaluationId: p.plannedEvaluationId, runIds: p.plannedRunIds, created: true };
    } catch (e) {
      if (client) await client.query("rollback").catch(() => undefined);
      if (pgCode(e) === "23505") throw new EvaluationConflictError("this transaction already paid another quote");
      return rethrow(e);
    } finally {
      client?.release();
    }
  }

  async getEvaluation(id: string): Promise<EvaluationRecord | null> {
    try {
      const { rows } = await this.pool.query(`${EVAL_SELECT} where e.id = $1`, [id]);
      return rows[0] ? toEvaluation(rows[0]) : null;
    } catch (e) {
      rethrow(e);
    }
  }

  async listRuns(evaluationId: string): Promise<EvalRun[]> {
    const { rows } = await this.pool.query(`${RUN_SELECT} where evaluation_id = $1 order by seq`, [evaluationId]);
    return rows.map(toRun);
  }

  async listProofs(runIds: string[]): Promise<EvalProof[]> {
    if (runIds.length === 0) return [];
    const { rows } = await this.pool.query(
      `select run_id, status, manifest_sha256, nft_mint, tx_sig, attestation_address, error, created_at
         from public.proofs where run_id = any($1::uuid[])`,
      [runIds],
    );
    return rows.map((r) => ({
      runId: r.run_id,
      status: r.status,
      manifestSha256: r.manifest_sha256,
      nftMint: r.nft_mint,
      txSig: r.tx_sig,
      attestationAddress: r.attestation_address,
      error: r.error,
      createdAt: iso(r.created_at)!,
    }));
  }

  async listForWallet(wallet: string, limit: number): Promise<EvaluationListRow[]> {
    try {
      const { rows } = await this.pool.query(`${EVAL_SELECT} where e.owner_wallet = $1 order by e.created_at desc limit $2`, [wallet, limit]);
      return rows.map(toEvaluation);
    } catch (e) {
      rethrow(e);
    }
  }

  async cancel(evaluationId: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const runs = await client.query(
        `update public.runs set status = 'cancelled', completed_at = now(), model_api_key_enc = null
          where evaluation_id = $1 and status = 'queued'`,
        [evaluationId],
      );
      await client.query(
        `update public.evaluations set status = 'cancelled', cancelled_at = coalesce(cancelled_at, now()) where id = $1`,
        [evaluationId],
      );
      await client.query("commit");
      return runs.rowCount ?? 0;
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async listOpen(limit: number): Promise<string[]> {
    try {
      const { rows } = await this.pool.query(
        `select id from public.evaluations
          where issued_at is null and status <> 'failed' and created_at > now() - interval '3 days'
          order by created_at limit $1`,
        [limit],
      );
      return rows.map((r) => r.id as string);
    } catch (e) {
      if (isMissingSchema(e)) return [];
      throw e;
    }
  }

  async saveRollup(id: string, r: RollupColumns): Promise<void> {
    await this.pool.query(
      `update public.evaluations set
         status = case when status = 'cancelled' then status else $2 end,
         score = $3, pass_count = $4, fail_count = $5, invalid_count = $6, tests_passed = $7, tests_total = $8,
         started_at = coalesce(started_at, $9), completed_at = coalesce(completed_at, $10), issued_at = coalesce(issued_at, $11),
         manifest_sha256 = coalesce(manifest_sha256, $12), slug = coalesce(slug, $13),
         model_api_key_enc = case when $14 then null else model_api_key_enc end
       where id = $1`,
      [id, r.status, r.score, r.passCount, r.failCount, r.invalidCount, r.testsPassed, r.testsTotal, r.startedAt, r.completedAt,
        r.issuedAt, r.manifestSha256, r.slug, r.wipeModelKey],
    );
  }

  async insertFreeRetry(evaluationId: string, failedRunId: string): Promise<EvalRun | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const ev = await client.query(`select id, status, model_api_key_enc from public.evaluations where id = $1 for update`, [evaluationId]);
      if (!ev.rows[0] || ev.rows[0].status === "cancelled") {
        await client.query("rollback");
        return null;
      }
      const failed = await client.query(`select * from public.runs where id = $1 and evaluation_id = $2`, [failedRunId, evaluationId]);
      const f = failed.rows[0];
      const already = await client.query(`select 1 from public.runs where retry_of_run_id = $1`, [failedRunId]);
      if (!f || f.status !== "infra_error" || f.retry_of_run_id || already.rows[0]) {
        await client.query("rollback");
        return null;
      }
      const seq = await client.query(`select coalesce(max(seq), 0) + 1 as next from public.runs where evaluation_id = $1`, [evaluationId]);
      const inserted = await client.query(
        `insert into public.runs
           (release_declaration_id, task_pack_id, task_pack_version, nonce, status, owner_wallet, agent_version_id,
            model_api_key_enc, run_start_sig, evaluation_id, task_id, task_version_id, seq, retry_of_run_id)
         values ($1,$2,$3,gen_random_uuid()::text,'queued',$4,$5,$6,$7,$8,$9,$10,$11,$12)
         returning id`,
        [
          f.release_declaration_id, f.task_pack_id, f.task_pack_version, f.owner_wallet, f.agent_version_id,
          ev.rows[0].model_api_key_enc, f.run_start_sig, evaluationId, f.task_id, f.task_version_id, num(seq.rows[0]?.next), f.id,
        ],
      );
      await client.query(`update public.evaluations set free_retries_used = free_retries_used + 1 where id = $1`, [evaluationId]);
      await client.query("commit");
      const { rows } = await this.pool.query(`${RUN_SELECT} where id = $1`, [inserted.rows[0]!.id]);
      return toRun(rows[0]!);
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async setProofEvaluation(runId: string, evaluationId: string): Promise<void> {
    await this.pool.query(`update public.proofs set evaluation_id = $2 where run_id = $1 and evaluation_id is null`, [runId, evaluationId]);
  }
}

import type { Pool } from "pg";
import type { EvalTask } from "../evaluations/store.js";
import type { ProfileSource, PublicProfilesStore, PublicProofRow, PublicRunRow, PublicTaskMeta } from "./store.js";

/**
 * Postgres PublicProfilesStore. Read-only SELECTs over 0001 (runs), 0002 (agents, agent_versions),
 * 0004 (proofs), 0006 (runs.model_cost_usd), 0007 (tasks, task_versions, tags, profiles, models)
 * and 0008 (evaluations, payments).
 */
const HASH_RE = /^[0-9a-f]{64}$/;

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const TASK_META_SELECT = `
  select t.id::text as task_id, t.slug, t.name, t.description,
         coalesce((select v.labels from public.task_versions v where v.task_id = t.id order by v.version desc limit 1), '{}') as labels,
         coalesce((select json_agg(json_build_object('id', g.id, 'name', g.name, 'kind', g.kind) order by g.kind desc, g.sort)
                     from public.task_tags tt join public.tags g on g.id = tt.tag_id where tt.task_id = t.id), '[]'::json) as tags
    from public.tasks t`;

interface TaskMetaRow {
  task_id: string;
  slug: string;
  name: string;
  description: string;
  labels: string[] | null;
  tags: PublicTaskMeta["tags"];
}

function toMeta(r: TaskMetaRow): PublicTaskMeta {
  return { name: r.name, slug: r.slug, description: r.description, tags: r.tags ?? [], labels: r.labels ?? [] };
}

function toRun(r: Record<string, unknown>, taskKey: string): PublicRunRow {
  return {
    id: String(r.id),
    seq: Number(r.seq ?? 1),
    taskKey,
    retryOfRunId: (r.retry_of_run_id as string | null) ?? null,
    status: String(r.status),
    scoreTotal: num(r.score_total),
    evidenceManifest: r.evidence_manifest ?? null,
    startedAt: iso(r.started_at as string)!,
    claimedAt: iso(r.claimed_at as string | null),
    completedAt: iso(r.completed_at as string | null),
    modelCostUsd: num(r.model_cost_usd),
  };
}

function toProof(r: Record<string, unknown>): PublicProofRow {
  return {
    runId: String(r.run_id),
    status: r.status as PublicProofRow["status"],
    manifestSha256: (r.manifest_sha256 as string | null) ?? null,
    evidenceCid: (r.evidence_cid as string | null) ?? null,
    nftMint: (r.nft_mint as string | null) ?? null,
    txSig: (r.tx_sig as string | null) ?? null,
    attestationAddress: (r.attestation_address as string | null) ?? null,
    createdAt: iso(r.created_at as string)!,
  };
}

export class PgPublicProfilesStore implements PublicProfilesStore {
  constructor(private readonly pool: Pool) {}

  async load(key: string): Promise<ProfileSource | null> {
    const k = key.trim().toLowerCase();
    const ev = await this.pool.query<{ id: string }>(
      `select id from public.evaluations
        where (slug = $1 or manifest_sha256 = $1) and status = 'issued' and is_public
        limit 1`,
      [k],
    );
    if (ev.rows[0]) return this.loadEvaluation(ev.rows[0].id);
    if (!HASH_RE.test(k)) return null;
    const pr = await this.pool.query<{ run_id: string; evaluation_id: string | null; run_eval: string | null }>(
      `select p.run_id, p.evaluation_id, r.evaluation_id as run_eval
         from public.proofs p join public.runs r on r.id = p.run_id
        where p.manifest_sha256 = $1 and p.status = 'confirmed'
        limit 1`,
      [k],
    );
    const p = pr.rows[0];
    if (!p) return null;
    const evaluationId = p.evaluation_id ?? p.run_eval;
    if (evaluationId) {
      const ok = await this.pool.query(`select 1 from public.evaluations where id = $1 and status = 'issued' and is_public`, [evaluationId]);
      return ok.rowCount ? this.loadEvaluation(evaluationId) : null;
    }
    return this.loadRun(p.run_id, k);
  }

  private async owner(wallet: string | null): Promise<ProfileSource["owner"]> {
    if (!wallet) return null;
    const { rows } = await this.pool.query(`select display_name, handle from public.profiles where wallet = $1`, [wallet]);
    return { wallet, displayName: rows[0]?.display_name ?? null, handle: rows[0]?.handle ?? null };
  }

  private async modelLabel(modelId: string | null): Promise<string | null> {
    if (!modelId) return null;
    const { rows } = await this.pool.query(`select label from public.models where id = $1`, [modelId]);
    return rows[0]?.label ?? null;
  }

  private async proofsFor(runIds: string[]): Promise<PublicProofRow[]> {
    if (runIds.length === 0) return [];
    const { rows } = await this.pool.query(`select * from public.proofs where run_id = any($1::uuid[])`, [runIds]);
    return rows.map(toProof);
  }

  private async loadEvaluation(id: string): Promise<ProfileSource | null> {
    const { rows } = await this.pool.query(
      `select e.*, pay.tx_sig as payment_tx_sig,
              a.id as a_id, a.name as a_name, a.slug as a_slug, a.description as a_description,
              a.repo_full_name as a_repo, a.owner_wallet as a_owner, av.commit_sha
         from public.evaluations e
         join public.agents a on a.id = e.agent_id
         left join public.agent_versions av on av.id = e.agent_version_id
         left join public.payments pay on pay.id = e.payment_id
        where e.id = $1`,
      [id],
    );
    const e = rows[0];
    if (!e) return null;
    const tasks = (e.tasks ?? []) as EvalTask[];
    const runsRes = await this.pool.query(
      `select id, seq, task_id, retry_of_run_id, status, score_total, evidence_manifest, started_at, claimed_at,
              completed_at, model_cost_usd
         from public.runs where evaluation_id = $1 order by seq, started_at`,
      [id],
    );
    const runs = runsRes.rows.map((r) => toRun(r, String(r.task_id ?? "")));
    const keys = [...new Set([...tasks.map((t) => t.taskId), ...tasks.map((t) => t.slug)])];
    const metaRes = await this.pool.query<TaskMetaRow>(`${TASK_META_SELECT} where t.id::text = any($1) or t.slug = any($1)`, [keys]);
    const taskMeta: Record<string, PublicTaskMeta> = {};
    for (const t of tasks) {
      const m = metaRes.rows.find((r) => r.task_id === t.taskId || r.slug === t.slug);
      taskMeta[t.taskId] = m ? toMeta(m) : { name: t.name, slug: t.slug, description: "", tags: [], labels: [] };
    }
    const [owner, modelLabel, proofs] = await Promise.all([
      this.owner(e.a_owner),
      this.modelLabel(e.model_id),
      this.proofsFor(runs.map((r) => r.id)),
    ]);
    return {
      kind: "evaluation",
      slug: e.slug ?? e.manifest_sha256,
      hash: e.manifest_sha256,
      evaluation: {
        id: e.id,
        agentVersionId: e.agent_version_id,
        ownerWallet: e.owner_wallet,
        modelId: e.model_id,
        modelRelease: e.model_release ?? null,
        tasks,
        createdAt: iso(e.created_at)!,
        issuedAt: iso(e.issued_at),
        feeUsd: Number(e.fee_usd),
        feeLamports: Number(e.fee_lamports),
        solUsdRate: Number(e.sol_usd_rate),
        paymentTxSig: e.payment_tx_sig ?? null,
      },
      agent: {
        id: e.a_id,
        name: e.a_name,
        slug: e.a_slug ?? null,
        description: e.a_description ?? null,
        repoFullName: e.a_repo ?? null,
        ownerWallet: e.a_owner ?? null,
        commit: e.commit_sha ?? null,
      },
      owner,
      evaluatorWallet: e.owner_wallet,
      modelId: e.model_id,
      modelLabel,
      runs,
      proofs,
      taskMeta,
    };
  }

  private async loadRun(runId: string, hash: string): Promise<ProfileSource | null> {
    const { rows } = await this.pool.query(
      `select r.*, a.id as a_id, a.name as a_name, a.slug as a_slug, a.description as a_description,
              a.repo_full_name as a_repo, a.owner_wallet as a_owner, a.model as a_model, av.commit_sha
         from public.runs r
         left join public.agent_versions av on av.id = r.agent_version_id
         left join public.agents a on a.id = av.agent_id
        where r.id = $1`,
      [runId],
    );
    const r = rows[0];
    if (!r) return null;
    const packId = String(r.task_pack_id);
    const metaRes = await this.pool.query<TaskMetaRow>(
      `${TASK_META_SELECT}
        where exists (select 1 from public.task_versions v where v.task_id = t.id and v.pack_id = $1)
        order by t.created_at limit 1`,
      [packId],
    );
    const runner = (r.evidence_manifest as { runner?: { model?: string } } | null)?.runner;
    const modelId: string | null = runner?.model ?? r.a_model ?? null;
    const [owner, modelLabel, proofs] = await Promise.all([this.owner(r.a_owner ?? null), this.modelLabel(modelId), this.proofsFor([runId])]);
    return {
      kind: "run",
      slug: hash,
      hash,
      evaluation: null,
      agent: {
        id: r.a_id ?? null,
        name: r.a_name ?? r.a_repo ?? "agent",
        slug: r.a_slug ?? null,
        description: r.a_description ?? null,
        repoFullName: r.a_repo ?? null,
        ownerWallet: r.a_owner ?? null,
        commit: r.commit_sha ?? null,
      },
      owner,
      evaluatorWallet: r.owner_wallet ?? null,
      modelId,
      modelLabel,
      runs: [toRun({ ...r, seq: 1 }, packId)],
      proofs,
      taskMeta: { [packId]: metaRes.rows[0] ? toMeta(metaRes.rows[0]) : { name: packId, slug: packId, description: "", tags: [], labels: [] } },
    };
  }
}

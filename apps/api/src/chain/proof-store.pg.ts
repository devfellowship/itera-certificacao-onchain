import type { Pool } from "pg";
import type { LeaderboardEntry, ProofRecord, ProofRun, ProofStore } from "./proof-store.js";

/**
 * Postgres ProofStore. Needs db/migrations 0001 (runs.owner_wallet, runs.run_start_sig,
 * runs.agent_version_id), 0002 (agents.repo_full_name/model, agent_versions) and 0004 (proofs).
 */
interface ProofRow {
  run_id: string;
  owner_wallet: string | null;
  manifest_sha256: string | null;
  evidence_cid: string | null;
  attestation_address: string | null;
  nft_mint: string | null;
  tx_sig: string | null;
  status: ProofRecord["status"];
  error: string | null;
  created_at: Date | string;
  task_author_wallet?: string | null;
  agent_owner_wallet?: string | null;
  self_evaluated?: boolean | null;
  ranked?: boolean | null;
}

function toProof(row: ProofRow): ProofRecord {
  return {
    runId: row.run_id,
    ownerWallet: row.owner_wallet,
    manifestSha256: row.manifest_sha256,
    evidenceCid: row.evidence_cid,
    attestationAddress: row.attestation_address,
    nftMint: row.nft_mint,
    txSig: row.tx_sig,
    status: row.status,
    error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
    taskAuthorWallet: row.task_author_wallet ?? null,
    agentOwnerWallet: row.agent_owner_wallet ?? null,
    selfEvaluated: row.self_evaluated ?? false,
    ranked: row.ranked ?? true,
  };
}

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

const RUN_SELECT = `
  select r.id, r.owner_wallet, r.run_start_sig, r.status, r.evidence_manifest, r.score_total,
         r.task_pack_id, r.task_pack_version,
         av.agent_id, av.commit_sha, a.name as agent_name, a.repo_full_name, a.model
    from public.runs r
    left join public.agent_versions av on av.id = r.agent_version_id
    left join public.agents a on a.id = av.agent_id`;

export class PgProofStore implements ProofStore {
  constructor(private readonly pool: Pool) {}

  async getProofByRunId(runId: string) {
    const { rows } = await this.pool.query<ProofRow>(`select * from public.proofs where run_id = $1`, [runId]);
    return rows[0] ? toProof(rows[0]) : null;
  }

  async getProofByHash(hash: string) {
    const { rows } = await this.pool.query<ProofRow>(`select * from public.proofs where manifest_sha256 = $1`, [hash]);
    return rows[0] ? toProof(rows[0]) : null;
  }

  async upsertProof(p: Omit<ProofRecord, "createdAt">) {
    const { rows } = await this.pool.query<ProofRow>(
      `insert into public.proofs (run_id, owner_wallet, manifest_sha256, evidence_cid, attestation_address, nft_mint, tx_sig, status, error,
                                  task_author_wallet, agent_owner_wallet, self_evaluated, ranked)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce($12, false), coalesce($13, true))
       on conflict (run_id) do update set
         owner_wallet = excluded.owner_wallet, manifest_sha256 = excluded.manifest_sha256,
         evidence_cid = excluded.evidence_cid, attestation_address = excluded.attestation_address,
         nft_mint = excluded.nft_mint, tx_sig = excluded.tx_sig, status = excluded.status, error = excluded.error,
         task_author_wallet = coalesce(excluded.task_author_wallet, proofs.task_author_wallet),
         agent_owner_wallet = coalesce(excluded.agent_owner_wallet, proofs.agent_owner_wallet),
         self_evaluated = case when $12::boolean is null then proofs.self_evaluated else excluded.self_evaluated end,
         ranked = case when $13::boolean is null then proofs.ranked else excluded.ranked end
       returning *`,
      [
        p.runId, p.ownerWallet, p.manifestSha256, p.evidenceCid, p.attestationAddress, p.nftMint, p.txSig, p.status, p.error,
        p.taskAuthorWallet ?? null, p.agentOwnerWallet ?? null, p.selfEvaluated ?? null, p.ranked ?? null,
      ],
    );
    return toProof(rows[0]);
  }

  async getProofRun(runId: string): Promise<ProofRun | null> {
    const { rows } = await this.pool.query(`${RUN_SELECT} where r.id = $1`, [runId]);
    const r = rows[0];
    if (!r) return null;
    return {
      runId: r.id,
      ownerWallet: r.owner_wallet,
      runStartSig: r.run_start_sig,
      status: r.status,
      evidenceManifest: r.evidence_manifest,
      scoreTotal: num(r.score_total),
      benchmarkId: r.task_pack_id,
      benchmarkVersion: r.task_pack_version,
      agentId: r.agent_id,
      agentName: r.agent_name,
      agentRepo: r.repo_full_name,
      agentCommit: r.commit_sha,
      modelId: r.model,
    };
  }

  async setRunStartSig(runId: string, signature: string) {
    await this.pool.query(`update public.runs set run_start_sig = $2 where id = $1 and run_start_sig is null`, [runId, signature]);
  }

  async leaderboard(benchmarkId: string, benchmarkVersion?: string | null): Promise<LeaderboardEntry[]> {
    const { rows } = await this.pool.query(
      `select * from (
         select distinct on (coalesce(av.agent_id::text, r.id::text))
                r.id as run_id, r.score_total, p.owner_wallet, p.manifest_sha256, p.nft_mint, p.created_at,
                p.task_author_wallet, p.agent_owner_wallet, p.self_evaluated,
                av.agent_id, a.name as agent_name, a.repo_full_name, a.model
           from public.proofs p
           join public.runs r on r.id = p.run_id
           left join public.agent_versions av on av.id = r.agent_version_id
           left join public.agents a on a.id = av.agent_id
          where p.status = 'confirmed' and p.manifest_sha256 is not null
            and p.ranked  -- U27 sealed-test rule: open-tests / public-repo tasks never enter a leaderboard
            and r.task_pack_id = $1 and ($2::text is null or r.task_pack_version = $2)
          order by coalesce(av.agent_id::text, r.id::text), r.score_total desc nulls last, p.created_at asc
       ) best
       order by score_total desc nulls last, created_at asc
       limit 100`,
      [benchmarkId, benchmarkVersion ?? null],
    );
    return rows.map((r, index) => ({
      rank: index + 1,
      agentId: r.agent_id,
      agentName: r.agent_name,
      agentRepo: r.repo_full_name,
      modelId: r.model,
      ownerWallet: r.owner_wallet,
      scoreTotal: num(r.score_total) ?? 0,
      proofHash: r.manifest_sha256,
      nftMint: r.nft_mint,
      runId: r.run_id,
      createdAt: new Date(r.created_at).toISOString(),
      taskAuthorWallet: r.task_author_wallet ?? null,
      agentOwnerWallet: r.agent_owner_wallet ?? null,
      selfEvaluated: Boolean(r.self_evaluated),
    }));
  }
}

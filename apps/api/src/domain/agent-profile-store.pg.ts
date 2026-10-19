import type { Pool } from "pg";
import type { BadgeEvaluation, OwnTaskResult, ProfileAgent, ProfileData, ProfileEvaluation, ProfileResult, ProfileStore, ProfileTag } from "./agent-profile.js";
import { SchemaNotReadyError } from "./runs-store.js";

/**
 * Pg store of the agent profile (U15) and the badges (U16). Reads 0002 (agents, agent_versions),
 * 0004 (proofs), 0007 (catalog) and 0008 (evaluations, agents.slug and friends). Read-only: it
 * never writes. A missing table or column answers SchemaNotReadyError (the router answers 503).
 */
const MISSING_SCHEMA_CODES = new Set(["42P01", "42703"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const iso = (d: unknown): string | null => (d === null || d === undefined ? null : d instanceof Date ? d.toISOString() : String(d));
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const intOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The task of a run: runs.task_id, else its task_version, else the catalog row of its task pack. */
const RUN_TASK_UUID = `coalesce(
  (select t0.id from public.tasks t0 where t0.id::text = r.task_id::text),
  (select tv0.task_id from public.task_versions tv0 where tv0.id::text = r.task_version_id::text),
  (select tv1.task_id from public.task_versions tv1
    where tv1.pack_id::text = r.task_pack_id and tv1.pack_version::text = r.task_pack_version
    order by tv1.version desc limit 1)
)`;

export class PgProfileStore implements ProfileStore {
  constructor(private readonly pool: () => Pool) {}

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
      if (MISSING_SCHEMA_CODES.has(code)) throw new SchemaNotReadyError("0007_catalog.sql and 0008_evaluations_payments.sql", e);
      throw e;
    }
  }

  findAgent(idOrSlug: string): Promise<ProfileAgent | null> {
    return this.guard(async () => {
      const r = await this.pool().query(
        `select a.id::text as id, a.slug, a.name, a.owner_wallet, a.description, a.model, a.model_release,
                a.repo_full_name, a.agent_path, a.branch, a.pinned_commit, a.visibility, a.status, a.listed_at, a.created_at,
                gi.account_login, p.display_name as profile_name, m.label as model_label,
                (select av.commit_sha from public.agent_versions av where av.agent_id = a.id order by av.created_at desc limit 1) as latest_commit
           from public.agents a
           left join public.github_installations gi on gi.installation_id = a.gh_installation_id
           left join public.profiles p on p.wallet::text = a.owner_wallet
           left join public.models m on m.id::text = a.model
          where a.connector in ('github', 'endpoint') and a.owner_wallet is not null
            and ${UUID_RE.test(idOrSlug) ? "a.id = $1::uuid" : "a.slug = $1"}
          limit 1`,
        [idOrSlug],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        id: String(row.id),
        slug: str(row.slug),
        name: String(row.name),
        ownerWallet: String(row.owner_wallet),
        authorName: str(row.profile_name) ?? str(row.account_login),
        description: str(row.description),
        model: String(row.model ?? ""),
        modelLabel: str(row.model_label),
        modelRelease: str(row.model_release),
        repoFullName: str(row.repo_full_name),
        agentPath: str(row.agent_path),
        branch: str(row.branch),
        pinnedCommit: str(row.pinned_commit),
        latestCommit: str(row.latest_commit),
        visibility: str(row.visibility),
        status: str(row.status),
        listedAt: iso(row.listed_at),
        createdAt: iso(row.created_at),
      };
    });
  }

  load(agentId: string): Promise<ProfileData> {
    return this.guard(async () => {
      const pool = this.pool();
      const [results, evaluations, tags] = await Promise.all([
        pool.query(
          `select r.id::text as run_id, r.status, r.score_total::float8 as score,
                  nullif(r.evidence_manifest #>> '{tests,hidden,passed}', '')::int as tests_passed,
                  nullif(r.evidence_manifest #>> '{tests,hidden,total}', '')::int as tests_total,
                  coalesce(r.completed_at, r.started_at) as at,
                  r.task_pack_id, r.task_pack_version, r.owner_wallet as run_owner,
                  t.id::text as task_id, t.slug as task_slug, t.name as task_name, t.kind as task_kind, t.owner_wallet as task_owner,
                  coalesce((select array_agg(tt.tag_id order by tt.tag_id) from public.task_tags tt where tt.task_id = t.id), '{}') as tag_ids,
                  p.status as proof_status, p.tx_sig, p.nft_mint,
                  e.id::text as eval_id, e.slug as eval_slug, e.short_id as eval_short_id, e.status as eval_status,
                  coalesce(e.is_public, false) as eval_public, coalesce(e.issued_at, e.completed_at) as eval_issued_at
             from (select r.*, ${RUN_TASK_UUID} as task_uuid
                     from public.runs r
                     join public.agent_versions av on av.id = r.agent_version_id
                    where av.agent_id = $1::uuid and r.status in ('pass', 'fail') and r.score_total is not null) r
             left join public.tasks t on t.id = r.task_uuid
             left join public.proofs p on p.run_id = r.id
             left join public.evaluations e on e.id::text = r.evaluation_id::text
            order by at desc
            limit 5000`,
          [agentId],
        ),
        pool.query(
          `select e.id::text as id, e.slug, e.short_id, e.score::float8 as score, coalesce(e.issued_at, e.completed_at, e.created_at) as issued_at,
                  e.is_public, e.task_count, e.pass_count, e.fail_count, e.invalid_count, e.owner_wallet, e.status, e.tasks
             from public.evaluations e
            where e.agent_id = $1::uuid and e.status in ('issued', 'graded', 'review', 'failed')
            order by issued_at desc
            limit 500`,
          [agentId],
        ),
        pool.query(`select id, name, kind from public.tags`),
      ]);
      const mappedResults: ProfileResult[] = results.rows.map((row) => {
        const taskKey = row.task_id ? String(row.task_id) : `pack:${row.task_pack_id}@${row.task_pack_version}`;
        return {
          runId: String(row.run_id),
          status: row.status === "pass" ? "pass" : "fail",
          score: Number(row.score),
          testsPassed: intOrNull(row.tests_passed),
          testsTotal: intOrNull(row.tests_total),
          at: iso(row.at) ?? "",
          taskKey,
          taskId: str(row.task_id),
          taskSlug: str(row.task_slug),
          taskName: str(row.task_name) ?? String(row.task_pack_id),
          taskKind: str(row.task_kind),
          taskOwnerWallet: str(row.task_owner),
          taskTagIds: (row.tag_ids as string[]) ?? [],
          proof: row.proof_status ? { status: String(row.proof_status), txSig: str(row.tx_sig), nftMint: str(row.nft_mint) } : null,
          evaluation: row.eval_id
            ? { id: String(row.eval_id), slug: str(row.eval_slug), shortId: str(row.eval_short_id), status: String(row.eval_status), isPublic: Boolean(row.eval_public), issuedAt: iso(row.eval_issued_at) }
            : null,
        };
      });
      const mappedEvaluations: ProfileEvaluation[] = evaluations.rows.map((row) => ({
        ownerWallet: str(row.owner_wallet),
        status: str(row.status) ?? undefined,
        taskNames: Array.isArray(row.tasks) ? row.tasks.map((t: { name?: string }) => t.name ?? "Task") : [],
        id: String(row.id),
        slug: str(row.slug),
        shortId: str(row.short_id),
        score: row.score === null ? null : Number(row.score),
        issuedAt: iso(row.issued_at),
        isPublic: Boolean(row.is_public),
        taskCount: Number(row.task_count ?? 0),
        passCount: Number(row.pass_count ?? 0),
        failCount: Number(row.fail_count ?? 0),
        invalidCount: Number(row.invalid_count ?? 0),
      }));
      const mappedTags: ProfileTag[] = tags.rows.map((row) => ({ id: String(row.id), name: String(row.name), kind: row.kind === "concept" ? "concept" : "tool" }));
      return { results: mappedResults, evaluations: mappedEvaluations, tags: mappedTags };
    });
  }

  loadOwnTaskResults(wallet: string): Promise<OwnTaskResult[]> {
    return this.guard(async () => {
      const r = await this.pool().query(
        `select a.id::text as agent_id, a.name as agent_name, a.owner_wallet as agent_owner,
                t.id::text as task_id, t.name as task_name, r.score_total::float8 as score, r.status,
                coalesce(r.completed_at, r.started_at) as at
           from (select r.*, ${RUN_TASK_UUID} as task_uuid
                   from public.runs r
                  where r.status in ('pass', 'fail') and r.score_total is not null) r
           join public.tasks t on t.id = r.task_uuid and t.kind = 'user' and t.owner_wallet = $1
           join public.agent_versions av on av.id = r.agent_version_id
           join public.agents a on a.id = av.agent_id
          order by at desc
          limit 5000`,
        [wallet],
      );
      return r.rows.map((row) => ({
        agentId: String(row.agent_id),
        agentName: String(row.agent_name),
        agentOwnerWallet: String(row.agent_owner ?? ""),
        taskId: String(row.task_id),
        taskName: String(row.task_name),
        score: Number(row.score),
        status: row.status === "pass" ? "pass" : "fail",
        at: iso(row.at) ?? "",
      }));
    });
  }

  findPublicEvaluation(slug: string): Promise<BadgeEvaluation | null> {
    return this.guard(async () => {
      const r = await this.pool().query(
        `select e.slug, e.score::float8 as score, e.task_count from public.evaluations e
          where e.slug = $1 and e.status = 'issued' and e.is_public limit 1`,
        [slug],
      );
      const row = r.rows[0];
      return row ? { slug: String(row.slug), score: row.score === null ? null : Number(row.score), taskCount: Number(row.task_count ?? 0) } : null;
    });
  }
}

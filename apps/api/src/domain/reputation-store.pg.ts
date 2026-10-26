import { hasSelfDeclaredSchema, hostedOnly } from "./schema-features.js";
import type { Pool } from "pg";
import type { ReputationStore, RunFeedback, RunProvenance, TaskInputs } from "./reputation-store.js";

/**
 * Pg ReputationStore. SELECT/INSERT only, over 0001/0002 (runs, agents, github_installations),
 * 0007 (tasks, task_versions), 0008 (runs.task_id, runs.task_version_id) and 0010 (repo_private,
 * run_feedback). No DB functions: the aggregates are plain SELECTs, the rules are reputation.ts.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINISHED = `('pass', 'fail', 'invalid', 'timeout')`;

/**
 * The task version of a run: its own task_version_id, else the latest version of its task_id, else
 * the latest version that carries its task pack (legacy bridge). `r` = public.runs.
 */
export const RUN_TASK_VERSION_LATERAL = `
  left join lateral (
    select v.* from public.task_versions v
     where (r.task_version_id is not null and v.id::text = r.task_version_id::text)
        or (r.task_version_id is null and r.task_id is not null and v.task_id::text = r.task_id::text)
        or (r.task_version_id is null and v.pack_id = r.task_pack_id and v.pack_version = r.task_pack_version)
     order by (r.task_version_id is not null and v.id::text = r.task_version_id::text) desc,
              (r.task_id is not null and v.task_id::text = r.task_id::text) desc,
              v.version desc
     limit 1
  ) rtv on true
  left join public.tasks rt on rt.id = rtv.task_id`;

export class PgReputationStore implements ReputationStore {
  constructor(private readonly pool: () => Pool) {}

  async runProvenance(runIds: string[]): Promise<Map<string, RunProvenance>> {
    const ids = runIds.filter((id) => UUID_RE.test(id));
    if (ids.length === 0) return new Map();
    const { rows } = await this.pool().query(
      `select r.id::text as run_id, r.owner_wallet as run_owner, r.status,
              rt.id::text as task_id, rt.kind as task_kind, rt.owner_wallet as task_author,
              rtv.source as task_source, rtv.repo_private, coalesce(rtv.labels, '{}') as task_labels,
              tgi.account_login as task_gh,
              a.owner_wallet as agent_owner, agi.account_login as agent_gh
         from public.runs r
         left join public.agent_versions av on av.id = r.agent_version_id
         left join public.agents a on a.id = av.agent_id
         left join public.github_installations agi on agi.installation_id = a.gh_installation_id
         ${RUN_TASK_VERSION_LATERAL}
         left join public.github_installations tgi on tgi.installation_id = rtv.gh_installation_id
        where r.id = any($1::uuid[])`,
      [ids],
    );
    const out = new Map<string, RunProvenance>();
    for (const r of rows) {
      out.set(r.run_id, {
        runId: r.run_id,
        runOwnerWallet: r.run_owner ?? null,
        runStatus: r.status,
        taskId: r.task_id ?? null,
        task: r.task_id
          ? {
              kind: r.task_kind ?? null,
              authorWallet: r.task_author ?? null,
              source: r.task_source ?? null,
              repoPrivate: r.repo_private ?? null,
              labels: r.task_labels ?? [],
              githubAccount: r.task_gh ?? null,
            }
          : null,
        agent: { ownerWallet: r.agent_owner ?? null, githubAccount: r.agent_gh ?? null },
      });
    }
    return out;
  }

  async reputationInputs(taskKeys: string[]) {
    const keys = [...new Set(taskKeys.filter(Boolean))].slice(0, 500);
    const out = new Map<string, TaskInputs>();
    if (keys.length === 0) return out;
    const sd = await hasSelfDeclaredSchema(this.pool());
    const { rows } = await this.pool().query(
      `with t as (
         select id, slug, kind, owner_wallet from public.tasks where id::text = any($1) or slug = any($1)
       ),
       fin as (
         select rt.id as task_id, r.owner_wallet
           from public.runs r
           ${RUN_TASK_VERSION_LATERAL}
          where r.status in ${FINISHED} and rt.id in (select id from t)${hostedOnly(sd, "r")}
       ),
       fb as (
         select f.task_id, f.matched_reality, f.wallet from public.run_feedback f
          where f.task_id in (select id::text from t)${sd ? " and not exists (select 1 from public.runs sr where sr.id = f.run_id and sr.result_origin = 'self_declared')" : ""}
       )
       select t.id::text as task_id, t.slug, t.kind, t.owner_wallet,
              (select count(distinct fin.owner_wallet) from fin
                where fin.task_id = t.id and fin.owner_wallet is distinct from t.owner_wallet)::int as wallets,
              (select count(*) from fin where fin.task_id = t.id)::int as runs,
              (select count(*) from fb where fb.task_id = t.id::text and fb.wallet is distinct from t.owner_wallet)::int as fb_total,
              (select count(*) from fb where fb.task_id = t.id::text and fb.wallet is distinct from t.owner_wallet and fb.matched_reality)::int as fb_yes
         from t`,
      [keys],
    );
    for (const r of rows) {
      const v = {
        taskId: r.task_id,
        slug: r.slug,
        kind: r.kind ?? null,
        ownerWallet: r.owner_wallet ?? null,
        distinctWallets: Number(r.wallets),
        runs: Number(r.runs),
        feedbackTotal: Number(r.fb_total),
        feedbackYes: Number(r.fb_yes),
      };
      out.set(v.taskId, v);
      out.set(v.slug, v);
    }
    return out;
  }

  async getFeedback(runIds: string[]): Promise<Map<string, RunFeedback>> {
    const ids = runIds.filter((id) => UUID_RE.test(id));
    if (ids.length === 0) return new Map();
    const { rows } = await this.pool().query(`select * from public.run_feedback where run_id = any($1::uuid[])`, [ids]);
    return new Map(rows.map((r) => [String(r.run_id), toFeedback(r)]));
  }

  async insertFeedback(f: Omit<RunFeedback, "createdAt">): Promise<RunFeedback | null> {
    const { rows } = await this.pool().query(
      `insert into public.run_feedback (run_id, wallet, task_id, matched_reality, note)
       values ($1, $2, $3, $4, $5)
       on conflict (run_id) do nothing
       returning *`,
      [f.runId, f.wallet, f.taskId, f.matchedReality, f.note],
    );
    return rows[0] ? toFeedback(rows[0]) : null;
  }
}

function toFeedback(r: Record<string, unknown>): RunFeedback {
  return {
    runId: String(r.run_id),
    wallet: String(r.wallet),
    taskId: (r.task_id as string | null) ?? null,
    matchedReality: Boolean(r.matched_reality),
    note: (r.note as string | null) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

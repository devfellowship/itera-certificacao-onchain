import type { Pool } from "pg";
import type { PublicTaskSource, PublicTaskStore, PublicTaskVersionRow, TaskResultRow } from "./task-store.js";

/**
 * Postgres PublicTaskStore. Read-only SELECTs over 0007 (tasks, task_versions, tags), 0008
 * (evaluations, runs.task_id) and 0002 (agents). No DB function: the aggregates are TypeScript.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export class PgPublicTaskStore implements PublicTaskStore {
  constructor(private readonly pool: Pool) {}

  async loadTask(key: string): Promise<PublicTaskSource | null> {
    const k = key.trim();
    const t = await this.pool.query(
      `select t.id::text as id, t.slug, t.name, t.description, t.est_minutes, t.created_at,
              coalesce((select json_agg(json_build_object('id', g.id, 'name', g.name, 'kind', g.kind) order by g.kind desc, g.sort)
                          from public.task_tags tt join public.tags g on g.id = tt.tag_id where tt.task_id = t.id), '[]'::json) as tags
         from public.tasks t
        where t.kind = 'itera' and t.visibility = 'public' and t.status = 'ready'
          and (t.slug = $1 or ($2::boolean and t.id::text = $1))
        limit 1`,
      [k, UUID_RE.test(k)],
    );
    const row = t.rows[0];
    if (!row) return null;
    const v = await this.pool.query(
      `select id::text as id, version, source, contract, labels, hidden_tests_count, runnable, fixture_digest, hidden_digest,
              pack_id, pack_version, repo_full_name, commit_sha, repo_path, created_at
         from public.task_versions where task_id::text = $1 order by version desc`,
      [row.id],
    );
    const versions: PublicTaskVersionRow[] = v.rows.map((r) => ({
      id: r.id,
      version: Number(r.version),
      source: r.source,
      contract: r.contract ?? {},
      labels: r.labels ?? [],
      hiddenTestsCount: num(r.hidden_tests_count),
      runnable: Boolean(r.runnable),
      fixtureDigest: r.fixture_digest ?? null,
      hiddenDigest: r.hidden_digest ?? null,
      packId: r.pack_id ?? null,
      packVersion: r.pack_version ?? null,
      repoFullName: r.repo_full_name ?? null,
      commitSha: r.commit_sha ?? null,
      repoPath: r.repo_path ?? null,
      createdAt: iso(r.created_at)!,
    }));
    return {
      task: {
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        estMinutes: num(row.est_minutes),
        tags: row.tags ?? [],
        createdAt: iso(row.created_at)!,
      },
      versions,
    };
  }

  async loadResults(taskId: string): Promise<TaskResultRow[]> {
    const { rows } = await this.pool.query(
      `select r.id::text as run_id, r.status, r.score_total, r.started_at, r.claimed_at, r.completed_at,
              e.slug as evaluation_slug, e.issued_at,
              a.id::text as agent_id, a.name as agent_name, a.slug as agent_slug,
              m.label as model_label, tv.version as task_version
         from public.runs r
         join public.evaluations e on e.id = r.evaluation_id and e.status = 'issued' and e.is_public
         join public.agents a on a.id = e.agent_id
         left join public.models m on m.id = e.model_id
         left join public.task_versions tv on tv.id::text = r.task_version_id
        where r.task_id = $1 and r.status in ('pass', 'fail', 'invalid', 'timeout')
        order by e.issued_at desc nulls last
        limit 2000`,
      [taskId],
    );
    return rows.map((r) => ({
      runId: r.run_id,
      status: r.status,
      scoreTotal: num(r.score_total),
      startedAt: iso(r.started_at)!,
      claimedAt: iso(r.claimed_at),
      completedAt: iso(r.completed_at),
      agentId: r.agent_id,
      agentName: r.agent_name,
      agentSlug: r.agent_slug ?? null,
      modelLabel: r.model_label ?? null,
      evaluationSlug: r.evaluation_slug ?? null,
      issuedAt: iso(r.issued_at),
      taskVersion: num(r.task_version),
    }));
  }
}

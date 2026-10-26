import { hasSelfDeclaredSchema, hostedOnly } from "./schema-features.js";
import type { Pool } from "pg";
import type { RankAgent, RankEvaluation, RankingData, RankingStore, RankResult } from "./agent-ranking.js";
import { SchemaNotReadyError } from "./runs-store.js";
import { isRankedTask, taskReputation } from "./reputation.js";
import { provenanceView } from "./reputation-store.js";
import { PgReputationStore } from "./reputation-store.pg.js";

/**
 * Pg store of GET /agents/ranking (U8). Reads 0001–0005 (runs, agents, agent_versions, proofs,
 * github_installations) and, when they exist, the catalog (tasks, task_versions, task_tags,
 * profiles, models — U4) and the evaluations tables and columns (U6). The schema is probed through
 * information_schema and cached for 60 s, so a migration applied later shows up without a deploy.
 */
const PROBE_TABLES = ["agents", "runs", "tasks", "task_versions", "task_tags", "evaluations", "profiles", "models", "run_feedback"];
const PROBE_CACHE_MS = 60_000;
const MISSING_SCHEMA_CODES = new Set(["42P01", "42703"]);

type Schema = Map<string, Set<string>>;

const iso = (d: unknown): string | null => (d === null || d === undefined ? null : d instanceof Date ? d.toISOString() : String(d));
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export class PgRankingStore implements RankingStore {
  private schema: { at: number; value: Schema } | null = null;

  constructor(private readonly pool: () => Pool) {}

  private async probe(): Promise<Schema> {
    if (this.schema && Date.now() - this.schema.at < PROBE_CACHE_MS) return this.schema.value;
    const r = await this.pool().query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and table_name = any($1::text[])`,
      [PROBE_TABLES],
    );
    const value: Schema = new Map();
    for (const row of r.rows) {
      const cols = value.get(row.table_name) ?? new Set<string>();
      cols.add(row.column_name);
      value.set(row.table_name, cols);
    }
    this.schema = { at: Date.now(), value };
    return value;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
      if (MISSING_SCHEMA_CODES.has(code)) {
        this.schema = null;
        throw new SchemaNotReadyError("0001–0005 (runs, agents, agent_versions, proofs)", e);
      }
      throw e;
    }
  }

  load(callerWallet: string): Promise<RankingData> {
    return this.guard(async () => {
      const s = await this.probe();
      const has = (t: string, ...cols: string[]) => cols.every((c) => s.get(t)?.has(c) ?? false);
      const [agents, results, evaluations] = await Promise.all([
        this.loadAgents(has),
        this.loadResults(has, callerWallet),
        this.loadEvaluations(has, callerWallet),
      ]);
      // U27 (0010): sealed-test rule, self-evaluated label and task reputation weight.
      if (has("task_versions", "repo_private") && has("run_feedback", "run_id", "task_id")) {
        const unrankedTaskKeys = await this.applyReputation(results);
        return { agents, results, evaluations, unrankedTaskKeys };
      }
      return { agents, results, evaluations };
    });
  }

  private async applyReputation(results: RankResult[]): Promise<string[]> {
    const rep = new PgReputationStore(this.pool);
    const prov = await rep.runProvenance(results.map((r) => r.runId));
    const taskIds = [...new Set([...prov.values()].map((p) => p.taskId).filter((id): id is string => Boolean(id)))];
    const inputs = await rep.reputationInputs(taskIds);
    for (const r of results) {
      const p = prov.get(r.runId);
      const view = provenanceView(p);
      r.selfEvaluated = view.selfEvaluated;
      r.taskRanked = view.ranked;
      const input = p?.taskId ? inputs.get(p.taskId) : undefined;
      r.taskWeight = input ? taskReputation(input).weight : 1;
    }
    const tasks = await this.pool().query<{ id: string; slug: string; kind: string | null; source: string | null; repo_private: boolean | null; labels: string[] | null }>(
      `select t.id::text as id, t.slug, t.kind, v.source, v.repo_private, v.labels
         from public.tasks t
         left join lateral (select * from public.task_versions tv where tv.task_id = t.id order by tv.version desc limit 1) v on true
        limit 5000`,
    );
    const unranked: string[] = [];
    for (const t of tasks.rows) {
      if (!isRankedTask({ kind: t.kind, source: t.source, repoPrivate: t.repo_private, labels: t.labels ?? [] })) unranked.push(t.id, t.slug);
    }
    return unranked;
  }

  private async loadAgents(has: (t: string, ...c: string[]) => boolean): Promise<RankAgent[]> {
    const profile = has("profiles", "wallet", "display_name");
    const model = has("models", "id", "label");
    const r = await this.pool().query<{
      j: Record<string, unknown>;
      account_login: string | null;
      profile_name?: string | null;
      model_label?: string | null;
    }>(
      `select to_jsonb(a) - 'identity_evidence' as j, gi.account_login
              ${profile ? ", p.display_name as profile_name" : ""}
              ${model ? ", m.label as model_label" : ""}
         from public.agents a
         left join public.github_installations gi on gi.installation_id = a.gh_installation_id
         ${profile ? "left join public.profiles p on p.wallet::text = a.owner_wallet" : ""}
         ${model ? "left join public.models m on m.id::text = a.model" : ""}
        where a.connector in ('github', 'endpoint') and a.owner_wallet is not null
        limit 5000`,
    );
    return r.rows.map((row) => ({
      id: String(row.j.id),
      slug: str(row.j.slug),
      name: String(row.j.name),
      ownerWallet: String(row.j.owner_wallet),
      authorName: str(row.profile_name) ?? str(row.account_login),
      description: str(row.j.description),
      model: String(row.j.model ?? ""),
      modelLabel: str(row.model_label),
      visibility: str(row.j.visibility),
      status: str(row.j.status),
      listedAt: iso(row.j.listed_at),
      createdAt: iso(row.j.created_at),
    }));
  }

  private async loadResults(has: (t: string, ...c: string[]) => boolean, callerWallet: string): Promise<RankResult[]> {
    const tasks = has("tasks", "id");
    const taskById = tasks && has("runs", "task_id");
    const taskByVersion = tasks && has("runs", "task_version_id") && has("task_versions", "id", "task_id");
    const taskByPack = tasks && has("task_versions", "task_id", "pack_id", "pack_version");
    const evals = has("evaluations", "id", "status") && has("runs", "evaluation_id");
    const taskCols = tasks
      ? [
          "t.id::text as task_id",
          has("tasks", "slug") ? "t.slug as task_slug" : "null::text as task_slug",
          has("tasks", "kind") ? "t.kind as task_kind" : "null::text as task_kind",
          has("tasks", "owner_wallet") ? "t.owner_wallet as task_owner" : "null::text as task_owner",
        ].join(", ")
      : "null::text as task_id, null::text as task_slug, null::text as task_kind, null::text as task_owner";
    const taskIdExpr = [
      taskById ? "r.task_id::text" : null,
      taskByVersion ? "tvv.task_id::text" : null,
      taskByPack ? "tvp.task_id::text" : null,
    ].filter(Boolean);
    const joins = [
      taskByVersion ? "left join public.task_versions tvv on tvv.id::text = r.task_version_id::text" : "",
      taskByPack
        ? `left join lateral (
             select tv.task_id from public.task_versions tv
              where tv.pack_id::text = r.task_pack_id and tv.pack_version::text = r.task_pack_version
              ${has("task_versions", "version") ? "order by tv.version desc" : ""} limit 1
           ) tvp on true`
        : "",
      tasks ? `left join public.tasks t on t.id::text = ${taskIdExpr.length > 0 ? `coalesce(${taskIdExpr.join(", ")})` : "null"}` : "",
      evals ? "left join public.evaluations e on e.id::text = r.evaluation_id::text" : "",
    ].join("\n");
    const issuedExpr = `(coalesce(p.status = 'confirmed', false)${evals ? " or coalesce(e.status = 'issued', false)" : ""})`;
    const r = await this.pool().query<{
      agent_id: string;
      run_id: string;
      run_owner: string | null;
      score: number;
      at: Date | string;
      task_pack_id: string;
      task_pack_version: string;
      issued: boolean;
      task_id: string | null;
      task_slug: string | null;
      task_kind: string | null;
      task_owner: string | null;
    }>(
      `select av.agent_id::text as agent_id, r.id::text as run_id, r.owner_wallet as run_owner,
              r.score_total::float8 as score, coalesce(r.completed_at, r.started_at) as at,
              r.task_pack_id, r.task_pack_version, ${issuedExpr} as issued, ${taskCols}
         from public.runs r
         join public.agent_versions av on av.id = r.agent_version_id
         left join public.proofs p on p.run_id = r.id
         ${joins}
        where r.status in ('pass', 'fail') and r.score_total is not null
          and (${issuedExpr} or r.owner_wallet = $1)${hostedOnly(await hasSelfDeclaredSchema(this.pool()), "r")}
        limit 20000`,
      [callerWallet],
    );
    return r.rows.map((row) => ({
      agentId: row.agent_id,
      runId: row.run_id,
      runOwnerWallet: row.run_owner,
      score: Number(row.score),
      at: iso(row.at) ?? "",
      issued: row.issued,
      taskKeys: [
        ...(row.task_id ? [row.task_id] : []),
        ...(row.task_slug ? [row.task_slug] : []),
        `pack:${row.task_pack_id}@${row.task_pack_version}`,
        row.task_pack_id,
      ],
      taskKind: row.task_kind,
      taskOwnerWallet: row.task_owner,
    }));
  }

  private async loadEvaluations(has: (t: string, ...c: string[]) => boolean, callerWallet: string): Promise<RankEvaluation[]> {
    if (!has("evaluations", "agent_id", "status", "score")) return [];
    const at = ["issued_at", "completed_at", "created_at"].filter((c) => has("evaluations", c)).map((c) => `e.${c}`);
    const visibility =
      has("evaluations", "is_public") && has("evaluations", "owner_wallet") ? "and (e.is_public or e.owner_wallet = $1)" : "and $1::text is not null";
    const r = await this.pool().query<{ agent_id: string; score: number | null; issued_at: Date | string | null }>(
      `select e.agent_id::text as agent_id, e.score::float8 as score, ${at.length > 0 ? `coalesce(${at.join(", ")})` : "null"} as issued_at
         from public.evaluations e
        where e.status = 'issued' ${visibility}
        limit 20000`,
      [callerWallet],
    );
    return r.rows.map((row) => ({ agentId: row.agent_id, score: row.score === null ? null : Number(row.score), issuedAt: iso(row.issued_at) ?? "" }));
  }

  taskIdsForTag(tag: string, callerWallet: string): Promise<string[] | null> {
    return this.guard(async () => {
      const s = await this.probe();
      const has = (t: string, ...cols: string[]) => cols.every((c) => s.get(t)?.has(c) ?? false);
      if (!has("task_tags", "task_id", "tag_id") || !has("tasks", "id")) return null;
      const privateFilter = has("tasks", "kind", "owner_wallet") ? "and (t.kind is distinct from 'user' or t.owner_wallet = $2)" : "and $2::text is not null";
      const r = await this.pool().query<{ id: string }>(
        `select t.id::text as id from public.task_tags tt join public.tasks t on t.id::text = tt.task_id::text
          where tt.tag_id = $1 ${privateFilter}`,
        [tag, callerWallet],
      );
      return r.rows.map((x) => x.id);
    });
  }
}

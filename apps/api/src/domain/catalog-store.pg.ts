import type { Pool } from "pg";
import {
  CATALOG_MIGRATION,
  HandleTakenError,
  type CatalogModel,
  type CatalogStore,
  type CatalogTask,
  type Profile,
  type Tag,
  type TaskVersionInfo,
} from "./catalog-store.js";
import { SchemaNotReadyError } from "./runs-store.js";

const MISSING_SCHEMA_CODES = new Set(["42P01", "42703"]); // undefined_table, undefined_column

function rethrow(e: unknown): never {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
  if (code && MISSING_SCHEMA_CODES.has(code)) throw new SchemaNotReadyError(CATALOG_MIGRATION, e);
  throw e;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : d instanceof Date ? d.toISOString() : d);
const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

/**
 * One row per visible task: tags and the latest version as JSON, plus the number of distinct agents
 * that ran on the task. Runs reference the legacy pack (task_pack_id/version) until 0008 adds
 * runs.task_id, so the count joins on the curated version's pack.
 */
const TASKS_SQL = `
  select t.id, t.slug, t.kind, t.owner_wallet, t.name, t.description, t.visibility, t.status,
         t.est_minutes, t.created_at, t.updated_at,
         coalesce((select json_agg(json_build_object('id', g.id, 'name', g.name, 'kind', g.kind, 'sort', g.sort)
                                   order by g.kind desc, g.sort, g.name)
                     from public.task_tags tt join public.tags g on g.id = tt.tag_id
                    where tt.task_id = t.id), '[]'::json) as tags,
         (select row_to_json(v) from (
            select tv.id, tv.version, tv.source, tv.labels, tv.runnable, tv.hidden_tests_count, tv.pack_id,
                   tv.pack_version, tv.gh_installation_id, tv.repo_full_name, tv.branch, tv.commit_sha,
                   tv.repo_path, tv.fixture_digest, tv.hidden_digest, tv.validated_at, tv.created_at
              from public.task_versions tv where tv.task_id = t.id order by tv.version desc limit 1) v) as latest,
         (select count(distinct rd.agent_id)
            from public.task_versions tv
            join public.runs r on r.task_pack_id = tv.pack_id and r.task_pack_version = tv.pack_version
            join public.release_declarations rd on rd.id = r.release_declaration_id
           where tv.task_id = t.id and tv.pack_id is not null)::int as agents_run_count
    from public.tasks t
   where (t.visibility = 'public' or (t.owner_wallet is not null and t.owner_wallet = $1))`;

type TaskRow = {
  id: string;
  slug: string;
  kind: CatalogTask["kind"];
  owner_wallet: string | null;
  name: string;
  description: string;
  visibility: CatalogTask["visibility"];
  status: CatalogTask["status"];
  est_minutes: number | null;
  created_at: Date | string;
  updated_at: Date | string;
  tags: Tag[];
  latest: {
    id: string;
    version: number;
    source: TaskVersionInfo["source"];
    labels: string[] | null;
    runnable: boolean;
    hidden_tests_count: number | null;
    pack_id: string | null;
    pack_version: string | null;
    gh_installation_id: number | string | null;
    repo_full_name: string | null;
    branch: string | null;
    commit_sha: string | null;
    repo_path: string | null;
    fixture_digest: string | null;
    hidden_digest: string | null;
    validated_at: string | null;
    created_at: string;
  } | null;
  agents_run_count: number;
};

function toTask(r: TaskRow): CatalogTask {
  const v = r.latest;
  return {
    id: r.id,
    slug: r.slug,
    kind: r.kind,
    ownerWallet: r.owner_wallet,
    name: r.name,
    description: r.description,
    visibility: r.visibility,
    status: r.status,
    estMinutes: r.est_minutes,
    tags: r.tags,
    latest: v && {
      id: v.id,
      version: v.version,
      source: v.source,
      labels: v.labels ?? [],
      runnable: v.runnable,
      hiddenTestsCount: v.hidden_tests_count,
      packId: v.pack_id,
      packVersion: v.pack_version,
      installationId: v.gh_installation_id === null ? null : Number(v.gh_installation_id),
      repoFullName: v.repo_full_name,
      branch: v.branch,
      commitSha: v.commit_sha,
      repoPath: v.repo_path,
      fixtureDigest: v.fixture_digest,
      hiddenDigest: v.hidden_digest,
      validatedAt: v.validated_at,
      createdAt: v.created_at,
    },
    agentsRunCount: r.agents_run_count,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

type ProfileRow = { wallet: string; display_name: string | null; handle: string | null; created_at: Date | string; updated_at: Date | string };
const toProfile = (r: ProfileRow): Profile => ({
  wallet: r.wallet,
  displayName: r.display_name,
  handle: r.handle,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export class PgCatalogStore implements CatalogStore {
  constructor(private readonly pool: Pool) {}

  async listVisibleTasks(wallet: string | null): Promise<CatalogTask[]> {
    try {
      const { rows } = await this.pool.query<TaskRow>(`${TASKS_SQL} order by t.kind, t.created_at, t.slug`, [wallet]);
      return rows.map(toTask);
    } catch (e) {
      rethrow(e);
    }
  }

  async getVisibleTask(idOrSlug: string, wallet: string | null): Promise<CatalogTask | null> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
    try {
      const { rows } = await this.pool.query<TaskRow>(
        `${TASKS_SQL} and ${isUuid ? "t.id = $2::uuid" : "t.slug = $2"}`,
        [wallet, idOrSlug],
      );
      return rows[0] ? toTask(rows[0]) : null;
    } catch (e) {
      rethrow(e);
    }
  }

  async listTags(): Promise<Tag[]> {
    try {
      const { rows } = await this.pool.query<Tag>(`select id, name, kind, sort from public.tags order by kind desc, sort, name`);
      return rows;
    } catch (e) {
      rethrow(e);
    }
  }

  async listModels(): Promise<CatalogModel[]> {
    try {
      const { rows } = await this.pool.query<{
        id: string;
        label: string;
        provider: string;
        context_length: number | null;
        prompt_price_usd_m: string | null;
        completion_price_usd_m: string | null;
        supports_tools: boolean;
        enabled: boolean;
        sort: number;
        openrouter_created_at: Date | null;
        synced_at: Date | null;
        releases: { id: string; released_at: string | null; is_latest: boolean }[];
      }>(
        `select m.*,
                coalesce((select json_agg(json_build_object('id', r.id, 'released_at', r.released_at, 'is_latest', r.is_latest)
                                          order by r.is_latest desc, r.released_at desc nulls last, r.id desc)
                            from public.model_releases r where r.model_id = m.id), '[]'::json) as releases
           from public.models m
          order by m.enabled desc, m.sort, m.label`,
      );
      return rows.map((r) => ({
        id: r.id,
        label: r.label,
        provider: r.provider,
        contextLength: r.context_length,
        promptPriceUsdPerM: num(r.prompt_price_usd_m),
        completionPriceUsdPerM: num(r.completion_price_usd_m),
        supportsTools: r.supports_tools,
        enabled: r.enabled,
        sort: r.sort,
        openrouterCreatedAt: iso(r.openrouter_created_at),
        syncedAt: iso(r.synced_at),
        releases: r.releases.map((x) => ({ id: x.id, releasedAt: x.released_at, isLatest: x.is_latest })),
      }));
    } catch (e) {
      rethrow(e);
    }
  }

  async getProfile(wallet: string): Promise<Profile | null> {
    try {
      const { rows } = await this.pool.query<ProfileRow>(`select * from public.profiles where wallet = $1`, [wallet]);
      return rows[0] ? toProfile(rows[0]) : null;
    } catch (e) {
      rethrow(e);
    }
  }

  async upsertProfile(wallet: string, patch: { displayName?: string | null; handle?: string | null }): Promise<Profile> {
    try {
      const { rows } = await this.pool.query<ProfileRow>(
        `insert into public.profiles (wallet, display_name, handle) values ($1, $3, $5)
         on conflict (wallet) do update set
           display_name = case when $2 then excluded.display_name else public.profiles.display_name end,
           handle       = case when $4 then excluded.handle else public.profiles.handle end,
           updated_at   = now()
         returning *`,
        [wallet, patch.displayName !== undefined, patch.displayName ?? null, patch.handle !== undefined, patch.handle ?? null],
      );
      return toProfile(rows[0]!);
    } catch (e) {
      if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505" && patch.handle) {
        throw new HandleTakenError(patch.handle);
      }
      rethrow(e);
    }
  }
}

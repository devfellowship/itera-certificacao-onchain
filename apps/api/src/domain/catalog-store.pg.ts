import { hasSelfDeclaredSchema, hostedOnly } from "./schema-features.js";
import type { Pool } from "pg";
import {
  CATALOG_MIGRATION,
  HandleTakenError,
  type CatalogModel,
  type CatalogStore,
  type CatalogTask,
  type Profile,
  type ProfilePatch,
  type PublicUserPage,
  type Tag,
  type TaskVersionInfo,
} from "./catalog-store.js";
import type { SyncedModel } from "./models-sync.js";
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
 * runs.task_id, so the count joins on the curated version's pack. Hosted runs only (0021: a
 * self-declared run never counts in a public number).
 */
const tasksSql = (sd: boolean) => `
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
           where tv.task_id = t.id and tv.pack_id is not null${hostedOnly(sd, "r")})::int as agents_run_count
    from public.tasks t
   where (t.visibility = 'public' or (t.owner_wallet is not null and t.owner_wallet = $1))
     and t.deleted_at is null`; // 0009_user_tasks: DELETE /tasks/:id is a soft delete

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

type ProfileRow = {
  wallet: string;
  display_name: string | null;
  handle: string | null;
  /** Absent before 0015_profile_avatars.sql. */
  avatar_url?: string | null;
  avatar_key?: string | null;
  bio?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};
const toProfile = (r: ProfileRow): Profile => ({
  wallet: r.wallet,
  displayName: r.display_name,
  handle: r.handle,
  avatarUrl: r.avatar_url ?? null,
  avatarKey: r.avatar_key ?? null,
  bio: r.bio ?? null,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export class PgCatalogStore implements CatalogStore {
  constructor(private readonly pool: Pool) {}

  async listVisibleTasks(wallet: string | null): Promise<CatalogTask[]> {
    try {
      const { rows } = await this.pool.query<TaskRow>(`${tasksSql(await hasSelfDeclaredSchema(this.pool))} order by t.kind, t.created_at, t.slug`, [wallet]);
      return rows.map(toTask);
    } catch (e) {
      rethrow(e);
    }
  }

  async getVisibleTask(idOrSlug: string, wallet: string | null): Promise<CatalogTask | null> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
    try {
      const { rows } = await this.pool.query<TaskRow>(
        `${tasksSql(await hasSelfDeclaredSchema(this.pool))} and ${isUuid ? "t.id = $2::uuid" : "t.slug = $2"}`,
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

  async isModelEnabled(id: string): Promise<boolean | null> {
    try {
      const { rows } = await this.pool.query<{ enabled: boolean }>(`select enabled from public.models where id = $1`, [id]);
      return rows[0] ? rows[0].enabled : null;
    } catch (e) {
      rethrow(e);
    }
  }

  /**
   * One transaction. Existing models keep `label`, `enabled` and `sort` (ITERA's curation); OpenRouter
   * facts are refreshed. The seed's placeholder release (id = model id) is replaced by the canonical
   * slug; the newest canonical slug is the only is_latest row of a model.
   */
  async applyModelsSync(models: SyncedModel[], syncedAt: string) {
    const col = <T>(f: (m: SyncedModel) => T) => models.map(f);
    const input = `select * from unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::numeric[], $6::numeric[],
                                        $7::boolean[], $8::timestamptz[], $9::text[])
                     as x(id, label, provider, ctx, pp, cp, tools, created, rid)`;
    const params = [
      col((m) => m.id),
      col((m) => m.label),
      col((m) => m.provider),
      col((m) => m.contextLength),
      col((m) => m.promptPriceUsdPerM),
      col((m) => m.completionPriceUsdPerM),
      col((m) => m.supportsTools),
      col((m) => m.createdAt),
      col((m) => m.release.id),
      syncedAt,
    ];
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const up = await client.query<{ inserted: boolean }>(
        `insert into public.models (id, label, provider, context_length, prompt_price_usd_m, completion_price_usd_m,
                                    supports_tools, enabled, sort, openrouter_created_at, synced_at)
         select id, label, provider, ctx, pp, cp, tools, false, 100, created, $10::timestamptz from (${input}) i
         on conflict (id) do update set
           provider = excluded.provider, context_length = excluded.context_length,
           prompt_price_usd_m = excluded.prompt_price_usd_m, completion_price_usd_m = excluded.completion_price_usd_m,
           supports_tools = excluded.supports_tools, openrouter_created_at = excluded.openrouter_created_at,
           synced_at = excluded.synced_at
         returning (xmax = 0) as inserted`,
        params,
      );
      await client.query(
        `delete from public.model_releases r using (${input}) i
          where r.model_id = i.id and r.id = r.model_id and i.rid <> i.id`,
        params.slice(0, 9),
      );
      await client.query(
        `update public.model_releases r set is_latest = false from (${input}) i
          where r.model_id = i.id and r.id <> i.rid and r.is_latest`,
        params.slice(0, 9),
      );
      const rel = await client.query<{ inserted: boolean }>(
        `insert into public.model_releases (id, model_id, released_at, is_latest, synced_at)
         select rid, id, created, true, $10::timestamptz from (${input}) i
         on conflict (id) do update set is_latest = true, released_at = coalesce(excluded.released_at, public.model_releases.released_at),
           synced_at = excluded.synced_at
           where public.model_releases.model_id = excluded.model_id
         returning (xmax = 0) as inserted`,
        params,
      );
      await client.query("commit");
      const inserted = up.rows.filter((r) => r.inserted).length;
      return { inserted, updated: up.rows.length - inserted, newReleases: rel.rows.filter((r) => r.inserted).length };
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      rethrow(e);
    } finally {
      client.release();
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

  async listProfiles(wallets: string[]): Promise<Profile[]> {
    const unique = [...new Set(wallets)].slice(0, 500);
    if (unique.length === 0) return [];
    try {
      const { rows } = await this.pool.query<ProfileRow>(`select * from public.profiles where wallet = any($1::text[])`, [unique]);
      return rows.map(toProfile);
    } catch (e) {
      rethrow(e);
    }
  }

  async getProfileByUsername(username: string): Promise<Profile | null> {
    try {
      const { rows } = await this.pool.query<ProfileRow>(`select * from public.profiles where handle = $1`, [username]);
      return rows[0] ? toProfile(rows[0]) : null;
    } catch (e) {
      rethrow(e);
    }
  }

  async profileStats(wallet: string): Promise<{ agents: number; tasks: number }> {
    try {
      const { rows } = await this.pool.query<{ agents: string; tasks: string }>(
        `select (select count(*) from public.agents where owner_wallet = $1) as agents,
                (select count(*) from public.tasks where owner_wallet = $1) as tasks`,
        [wallet],
      );
      return { agents: Number(rows[0]?.agents ?? 0), tasks: Number(rows[0]?.tasks ?? 0) };
    } catch (e) {
      rethrow(e);
    }
  }

  async publicUser(username: string): Promise<PublicUserPage | null> {
    const profile = await this.getProfileByUsername(username);
    if (!profile) return null;
    try {
      const [agents, tasks] = await Promise.all([
        this.pool.query<{ id: string; slug: string | null; name: string; description: string | null; avatar_url: string | null; created_at: Date }>(
          `select id::text, slug, name, description, avatar_url, created_at from public.agents
            where owner_wallet = $1 and visibility <> 'private' and connector = 'github'
              -- same rule as the public ranking: a non-owner sees an agent once it has issued evidence
              and exists (select 1 from public.evaluations e where e.agent_id = agents.id and e.status = 'issued')
            order by coalesce(listed_at, created_at) desc limit 50`,
          [profile.wallet],
        ),
        this.pool.query<{ id: string; slug: string; name: string; description: string | null }>(
          `select id::text, slug, name, description from public.tasks
            where owner_wallet = $1 and visibility = 'public' order by created_at desc limit 50`,
          [profile.wallet],
        ),
      ]);
      return {
        profile,
        agents: agents.rows.map((a) => ({ id: a.id, slug: a.slug, name: a.name, description: a.description, avatarUrl: a.avatar_url ?? null, createdAt: iso(a.created_at) })),
        tasks: tasks.rows.map((t) => ({ id: t.id, slug: t.slug, name: t.name, description: t.description })),
      };
    } catch (e) {
      rethrow(e);
    }
  }

  async upsertProfile(wallet: string, patch: ProfilePatch): Promise<Profile> {
    // The avatar and bio columns arrive with 0015; the statement names them only when the patch does.
    const avatar = patch.avatarUrl !== undefined || patch.avatarKey !== undefined || patch.bio !== undefined;
    try {
      const { rows } = await this.pool.query<ProfileRow>(
        `insert into public.profiles (wallet, display_name, handle${avatar ? ", avatar_url, avatar_key, bio" : ""})
         values ($1, $3, $5${avatar ? ", $7, $9, $11" : ""})
         on conflict (wallet) do update set
           display_name = case when $2 then excluded.display_name else public.profiles.display_name end,
           handle       = case when $4 then excluded.handle else public.profiles.handle end,
           ${avatar ? `avatar_url = case when $6 then excluded.avatar_url else public.profiles.avatar_url end,
           avatar_key   = case when $8 then excluded.avatar_key else public.profiles.avatar_key end,
           bio          = case when $10 then excluded.bio else public.profiles.bio end,` : ""}
           updated_at   = now()
         returning *`,
        [
          wallet,
          patch.displayName !== undefined,
          patch.displayName ?? null,
          patch.handle !== undefined,
          patch.handle ?? null,
          ...(avatar
            ? [patch.avatarUrl !== undefined, patch.avatarUrl ?? null, patch.avatarKey !== undefined, patch.avatarKey ?? null, patch.bio !== undefined, patch.bio ?? null]
            : []),
        ],
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

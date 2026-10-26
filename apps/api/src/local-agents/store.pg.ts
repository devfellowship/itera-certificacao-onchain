/**
 * Postgres store of local agents and custom models (task L4). Needs 0021: before it, a statement that
 * names a 0021 column or table fails with 42703 / 42P01 and the store throws SchemaNotReadyError (the
 * router answers 503 schema_not_ready). Reads of the custom models answer [] before 0021.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { hasSelfDeclaredSchema } from "../domain/schema-features.js";
import { slugify } from "../http/github-router.js";
import {
  LOCAL_AGENTS_MIGRATION,
  LocalAgentsError,
  localCommitSha,
  type CustomModel,
  type CustomModelInput,
  type KnownModel,
  type LocalAgent,
  type LocalAgentInput,
  type LocalAgentPatch,
  type LocalAgentsStore,
} from "./store.js";

function pgCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}
function pgConstraint(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "constraint" in e ? String((e as { constraint: unknown }).constraint) : undefined;
}
function rethrow(e: unknown): never {
  const code = pgCode(e);
  if (code === "42703" || code === "42P01") throw new SchemaNotReadyError(LOCAL_AGENTS_MIGRATION, e);
  if (code === "23505" && pgConstraint(e) === "agents_vendor_id_name_key") {
    throw new LocalAgentsError(409, "agent_name_taken", "you have an agent with this name");
  }
  throw e;
}
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

const AGENT_SELECT = `
  select a.id, a.owner_wallet, a.name, a.slug, a.description, a.visibility, a.status, a.model, a.provider_key, a.route_key,
         a.identity_evidence ->> 'harness' as harness, a.requires, a.created_at,
         v.id as v_id, v.commit_sha as v_commit_sha, jsonb_array_length(v.files) as v_file_count, v.created_at as v_created_at
    from public.agents a
    left join lateral (
      select id, commit_sha, files, created_at from public.agent_versions where agent_id = a.id order by created_at desc limit 1
    ) v on true
   where a.connector = 'local'`;

type AgentRow = Record<string, unknown>;

function toAgent(r: AgentRow): LocalAgent {
  return {
    id: String(r.id),
    ownerWallet: String(r.owner_wallet),
    name: String(r.name),
    slug: (r.slug as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    visibility: r.visibility === "listed" ? "listed" : "private",
    status: String(r.status),
    connector: "local",
    model: String(r.model ?? ""),
    providerKey: (r.provider_key as string | null) ?? null,
    routeKey: (r.route_key as string | null) ?? null,
    harness: (r.harness as string | null) ?? null,
    requires: (r.requires as string[] | null) ?? [],
    latestVersion: r.v_id
      ? { id: String(r.v_id), commitSha: String(r.v_commit_sha), fileCount: Number(r.v_file_count ?? 0), createdAt: iso(r.v_created_at) }
      : null,
    createdAt: iso(r.created_at),
  };
}

function toModel(r: AgentRow): CustomModel {
  return {
    id: String(r.id),
    label: String(r.label),
    providerKey: (r.provider_key as string | null) ?? null,
    providerLabel: (r.provider_label as string | null) ?? null,
    routeKey: String(r.route_key),
    createdAt: iso(r.created_at),
  };
}

export class PgLocalAgentsStore implements LocalAgentsStore {
  constructor(private readonly pool: () => Pool) {}

  schemaReady(): Promise<boolean> {
    return hasSelfDeclaredSchema(this.pool());
  }

  async listKnownModels(): Promise<KnownModel[]> {
    try {
      const { rows } = await this.pool().query(`select id, label from public.models where enabled order by sort, label`);
      return rows.map((r) => ({ id: String(r.id), label: String(r.label) }));
    } catch (e) {
      if (pgCode(e) === "42P01") return [];
      throw e;
    }
  }

  async catalogHas(id: string): Promise<boolean> {
    try {
      return Boolean((await this.pool().query(`select 1 from public.models where id = $1`, [id])).rowCount);
    } catch (e) {
      if (pgCode(e) === "42P01") return false;
      throw e;
    }
  }

  async listCustomModels(owner: string): Promise<CustomModel[]> {
    try {
      const { rows } = await this.pool().query(
        `select id, label, provider_key, provider_label, route_key, created_at from public.user_models where owner_wallet = $1 order by label, id`,
        [owner],
      );
      return rows.map(toModel);
    } catch (e) {
      // Before 0021 there is no custom model: an empty list, not an error (GET /model-options stays up).
      if (pgCode(e) === "42P01") return [];
      throw e;
    }
  }

  async createCustomModel(owner: string, m: CustomModelInput, max: number): Promise<CustomModel> {
    return this.tx(async (c) => {
      await c.query("select pg_advisory_xact_lock(hashtext($1))", [`user-models:${owner}`]);
      const n = (await c.query(`select count(*)::int as n from public.user_models where owner_wallet = $1`, [owner])).rows[0].n as number;
      if ((await c.query(`select 1 from public.user_models where owner_wallet = $1 and id = $2`, [owner, m.id])).rowCount) {
        throw new LocalAgentsError(409, "custom_model_exists", `you have a custom model ${m.id}`);
      }
      if (n >= max) throw new LocalAgentsError(409, "custom_model_limit", `at most ${max} custom models`);
      const { rows } = await c.query(
        `insert into public.user_models (owner_wallet, id, label, provider_key, provider_label, route_key)
         values ($1, $2, $3, $4, $5, $6) returning id, label, provider_key, provider_label, route_key, created_at`,
        [owner, m.id, m.label, m.providerKey, m.providerLabel, m.routeKey],
      );
      return toModel(rows[0]);
    });
  }

  async deleteCustomModel(owner: string, id: string): Promise<void> {
    await this.tx(async (c) => {
      await c.query("select pg_advisory_xact_lock(hashtext($1))", [`user-models:${owner}`]);
      if (!(await c.query(`select 1 from public.user_models where owner_wallet = $1 and id = $2 for update`, [owner, id])).rowCount) {
        throw new LocalAgentsError(404, "custom_model_not_found", "custom model not found");
      }
      const used = await c.query(`select 1 from public.agents where owner_wallet = $1 and model = $2 limit 1`, [owner, id]);
      if (used.rowCount) throw new LocalAgentsError(409, "model_in_use", "an agent of yours uses this model: change its model first");
      await c.query(`delete from public.user_models where owner_wallet = $1 and id = $2`, [owner, id]);
    });
  }

  async createLocalAgent(owner: string, input: LocalAgentInput): Promise<LocalAgent> {
    const id = randomUUID();
    await this.tx(async (c) => {
      const vendorName = `wallet:${owner}`;
      let vendor = (await c.query(`select id from public.vendors where display_name = $1 limit 1`, [vendorName])).rows[0];
      vendor ??= (await c.query(`insert into public.vendors (display_name) values ($1) returning id`, [vendorName])).rows[0];
      await c.query(
        `insert into public.agents (id, vendor_id, name, endpoint_url, owner_wallet, model, connector, description, visibility, status,
                                    provider_key, route_key, requires, identity_evidence, listed_at)
         values ($1, $2, $3, $4, $5, $6, 'local', $7, $8, 'active', $9, $10, $11, $12, case when $8 = 'listed' then now() end)`,
        [id, vendor.id, input.name, `local://${id}`, owner, input.model, input.description, input.visibility, input.providerKey, input.routeKey,
          input.requires, JSON.stringify(input.harness ? { harness: input.harness } : {})],
      );
      await c.query(`insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, '[]'::jsonb)`, [id, localCommitSha(input.name)]);
    });
    await this.assignSlug(id, input.name);
    return (await this.getLocalAgent(id))!;
  }

  async getLocalAgent(id: string): Promise<LocalAgent | null> {
    try {
      const { rows } = await this.pool().query(`${AGENT_SELECT} and a.id = $1`, [id]);
      return rows[0] ? toAgent(rows[0]) : null;
    } catch (e) {
      // Before 0021 there is no local agent (and no provider_key column).
      if (pgCode(e) === "42703") return null;
      throw e;
    }
  }

  async listLocalAgents(owner: string): Promise<LocalAgent[]> {
    try {
      const { rows } = await this.pool().query(`${AGENT_SELECT} and a.owner_wallet = $1 order by a.created_at desc`, [owner]);
      return rows.map(toAgent);
    } catch (e) {
      if (pgCode(e) === "42703") return [];
      throw e;
    }
  }

  async updateLocalAgent(id: string, p: LocalAgentPatch): Promise<LocalAgent> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (p.name !== undefined) set("name", p.name);
    if (p.description !== undefined) set("description", p.description);
    if (p.model !== undefined) set("model", p.model);
    if (p.providerKey !== undefined) set("provider_key", p.providerKey);
    if (p.routeKey !== undefined) set("route_key", p.routeKey);
    if (p.requires !== undefined) set("requires", p.requires);
    if (p.visibility !== undefined) {
      set("visibility", p.visibility);
      if (p.visibility === "listed") sets.push("listed_at = coalesce(listed_at, now())");
    }
    if (p.harness !== undefined) {
      values.push(p.harness);
      sets.push(`identity_evidence = case when $${values.length}::text is null then identity_evidence - 'harness'
                   else identity_evidence || jsonb_build_object('harness', $${values.length}::text) end`);
    }
    if (sets.length) {
      try {
        await this.pool().query(`update public.agents set ${sets.join(", ")} where id = $1 and connector = 'local'`, values);
      } catch (e) {
        rethrow(e);
      }
    }
    return (await this.getLocalAgent(id))!;
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool().connect();
    try {
      await c.query("begin");
      const out = await fn(c);
      await c.query("commit");
      return out;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      if (e instanceof LocalAgentsError) throw e;
      rethrow(e);
    } finally {
      c.release();
    }
  }

  /** The slug rule of the GitHub agents: the kebab-case name, then `name-xxxx` on a collision. */
  private async assignSlug(id: string, name: string): Promise<void> {
    const base = slugify(name);
    if (!base) return;
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${randomBytes(2).toString("hex")}`;
      try {
        const r = await this.pool().query(
          `update public.agents set slug = $2 where id = $1 and slug is null and not exists (select 1 from public.agents where slug = $2) returning slug`,
          [id, candidate],
        );
        if (r.rowCount) return;
      } catch (e) {
        if (pgCode(e) !== "23505") throw e;
      }
    }
  }
}

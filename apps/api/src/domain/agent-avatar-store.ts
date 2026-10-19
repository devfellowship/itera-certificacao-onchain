import type { Pool } from "pg";
import { SchemaNotReadyError } from "./runs-store.js";

/**
 * Agent pictures (U36, Tainan TG 21086). Needs 0015_profile_avatars.sql (agents.avatar_url, avatar_key).
 * Writes go through POST /agents/:id/avatar (owner) and PUT /admin/agents/:id/avatar (admin seed);
 * reads are batched by the response middleware (http/profile-enrich.ts).
 */
export interface AgentAvatarRow {
  id: string;
  slug: string | null;
  avatarUrl: string | null;
}

export interface AgentAvatarStore {
  /** Owner and current picture key, or null when the agent does not exist. */
  getAgent(id: string): Promise<{ ownerWallet: string | null; avatarKey: string | null } | null>;
  setAvatar(id: string, avatarUrl: string | null, avatarKey: string | null): Promise<void>;
  setName(id: string, name: string): Promise<void>;
  /** Agents (by id or slug) that HAVE a picture. One query. */
  listAvatars(ids: string[], slugs: string[]): Promise<AgentAvatarRow[]>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

function rethrow(e: unknown): never {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
  // 42703 undefined_column: 0015 is not applied yet.
  if (code === "42703") throw new SchemaNotReadyError("0015_profile_avatars.sql", e);
  throw e;
}

export class PgAgentAvatarStore implements AgentAvatarStore {
  constructor(private readonly pool: Pool) {}

  async getAgent(id: string) {
    if (!isUuid(id)) return null;
    try {
      const { rows } = await this.pool.query<{ owner_wallet: string | null; avatar_key: string | null }>(
        `select owner_wallet, avatar_key from public.agents where id = $1`,
        [id],
      );
      return rows[0] ? { ownerWallet: rows[0].owner_wallet, avatarKey: rows[0].avatar_key } : null;
    } catch (e) {
      rethrow(e);
    }
  }

  async setAvatar(id: string, avatarUrl: string | null, avatarKey: string | null) {
    try {
      await this.pool.query(`update public.agents set avatar_url = $2, avatar_key = $3 where id = $1`, [id, avatarUrl, avatarKey]);
    } catch (e) {
      rethrow(e);
    }
  }

  async setName(id: string, name: string) {
    try {
      await this.pool.query(`update public.agents set name = $2 where id = $1`, [id, name]);
    } catch (e) {
      rethrow(e);
    }
  }

  async listAvatars(ids: string[], slugs: string[]) {
    const i = [...new Set(ids.filter(isUuid))].slice(0, 500);
    const s = [...new Set(slugs)].slice(0, 500);
    if (i.length === 0 && s.length === 0) return [];
    try {
      const { rows } = await this.pool.query<{ id: string; slug: string | null; avatar_url: string }>(
        `select id::text, slug, avatar_url from public.agents
          where avatar_url is not null and (id = any($1::uuid[]) or slug = any($2::text[]))`,
        [i, s],
      );
      return rows.map((r) => ({ id: r.id, slug: r.slug, avatarUrl: r.avatar_url }));
    } catch (e) {
      rethrow(e);
    }
  }
}

export class FakeAgentAvatarStore implements AgentAvatarStore {
  agents = new Map<string, { ownerWallet: string | null; slug: string | null; avatarUrl: string | null; avatarKey: string | null }>();
  async getAgent(id: string) {
    const a = this.agents.get(id);
    return a ? { ownerWallet: a.ownerWallet, avatarKey: a.avatarKey } : null;
  }
  async setAvatar(id: string, avatarUrl: string | null, avatarKey: string | null) {
    const a = this.agents.get(id);
    if (a) Object.assign(a, { avatarUrl, avatarKey });
  }
  async setName(id: string, name: string) {
    const a = this.agents.get(id);
    if (a) Object.assign(a, { name });
  }
  async listAvatars(ids: string[], slugs: string[]) {
    return [...this.agents.entries()]
      .filter(([id, a]) => a.avatarUrl && (ids.includes(id) || (a.slug !== null && slugs.includes(a.slug))))
      .map(([id, a]) => ({ id, slug: a.slug, avatarUrl: a.avatarUrl }));
  }
}

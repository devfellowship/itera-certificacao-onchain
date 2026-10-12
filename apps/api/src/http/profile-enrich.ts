import type { NextFunction, Request, Response } from "express";
import type { Profile } from "../domain/catalog-store.js";

/**
 * Owner and author profiles in every API response (U36, plan 20261012-itera-testmyagent-ui-refactor).
 *
 * Agents, ranking rows, evaluations, public profiles, tasks and the leaderboard each name a user by
 * a wallet field (`ownerWallet`, `authorWallet`, `agentOwnerWallet`, `owner_wallet`, `wallet`, …).
 * Rather than a profiles join in every store, this middleware wraps `res.json`: it collects those
 * wallets from the body, reads their profiles in ONE query (10 s cache), and adds next to each field:
 *
 *   `<x>Wallet: "…"`  →  `<x>Profile: {wallet, username, displayName, avatarUrl}`
 *   `owner_wallet`    →  `owner_profile`
 *   `wallet` + `displayName`/`handle`/`username`/`avatarUrl` in the same object (a profile-shaped object) → fills them
 *   `wallet` elsewhere → `walletProfile`
 *
 * Agent pictures (Tainan TG 21086) ride the same pass: an agent-shaped object (string `initials` and
 * `name`, plus a uuid `id` or a `slug`) gets `avatarUrl`; an `agentId` / `agentSlug` field gets an
 * `agentAvatarUrl` sibling. Only agents WITH a picture get the field (the web draws a generated tile).
 *
 * A wallet without a profile row gets nothing (the web falls back to initials). An `authorName`
 * next to an `authorWallet` takes the display name (else `@username`) when the profile has one.
 * A lookup error never fails the response: the body goes out unchanged.
 */

export interface PublicProfile {
  wallet: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export type ProfileLookup = (wallets: string[]) => Promise<Profile[]>;
export type AgentAvatarLookup = (ids: string[], slugs: string[]) => Promise<Array<{ id: string; slug: string | null; avatarUrl: string | null }>>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Agent refs of one object: [ids, slugs, kind] where kind "self" = the object is the agent. */
function agentRef(o: Record<string, unknown>): Array<{ id?: string; slug?: string; target: "avatarUrl" | "agentAvatarUrl" }> {
  const out: Array<{ id?: string; slug?: string; target: "avatarUrl" | "agentAvatarUrl" }> = [];
  if (str(o.initials) && str(o.name) && !("wallet" in o)) {
    const id = str(o.id) && UUID_RE.test(o.id) ? o.id : undefined;
    const slug = str(o.slug) ? o.slug : undefined;
    if (id || slug) out.push({ id, slug, target: "avatarUrl" });
  }
  if ((str(o.agentId) && UUID_RE.test(o.agentId)) || str(o.agentSlug)) {
    out.push({ id: str(o.agentId) && UUID_RE.test(o.agentId) ? o.agentId : undefined, slug: str(o.agentSlug) ? o.agentSlug : undefined, target: "agentAvatarUrl" });
  }
  return out;
}

export function collectAgentRefs(body: unknown): { ids: string[]; slugs: string[] } {
  const ids = new Set<string>();
  const slugs = new Set<string>();
  walk(body, (o) => {
    for (const r of agentRef(o)) {
      if (r.id) ids.add(r.id);
      if (r.slug) slugs.add(r.slug);
    }
  });
  return { ids: [...ids], slugs: [...slugs] };
}

/** Mutates `body`: `avatarUrl` on agent objects, `agentAvatarUrl` next to agentId / agentSlug. */
export function enrichWithAgentAvatars(body: unknown, byId: Map<string, string>, bySlug: Map<string, string>): void {
  walk(body, (o) => {
    for (const r of agentRef(o)) {
      const url = (r.id && byId.get(r.id)) || (r.slug && bySlug.get(r.slug)) || null;
      if (url && (o[r.target] === undefined || o[r.target] === null)) o[r.target] = url;
    }
  });
}

const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_NODES = 20_000;
const MAX_DEPTH = 10;
const TTL_MS = 10_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function walletKeys(o: Record<string, unknown>): string[] {
  return Object.keys(o).filter((k) => (k === "wallet" || k === "owner_wallet" || /[a-z]Wallet$/.test(k)) && typeof o[k] === "string" && WALLET_RE.test(o[k] as string));
}

function walk(body: unknown, visit: (o: Record<string, unknown>) => void): void {
  let nodes = 0;
  const go = (v: unknown, depth: number) => {
    if (depth > MAX_DEPTH || nodes > MAX_NODES) return;
    nodes += 1;
    if (Array.isArray(v)) for (const x of v) go(x, depth + 1);
    else if (isObj(v)) {
      visit(v);
      for (const x of Object.values(v)) if (typeof x === "object" && x !== null) go(x, depth + 1);
    }
  };
  go(body, 0);
}

export function collectWallets(body: unknown): string[] {
  const out = new Set<string>();
  walk(body, (o) => {
    for (const k of walletKeys(o)) out.add(o[k] as string);
  });
  return [...out];
}

export function toPublicProfile(p: Profile): PublicProfile {
  return { wallet: p.wallet, username: p.handle, displayName: p.displayName, avatarUrl: p.avatarUrl };
}

/** Mutates `body`: adds the profile fields described above. */
export function enrichWithProfiles(body: unknown, profiles: Map<string, PublicProfile>): void {
  walk(body, (o) => {
    for (const k of walletKeys(o)) {
      const p = profiles.get(o[k] as string);
      if (!p) continue;
      if (k === "wallet") {
        if ("displayName" in o || "handle" in o || "username" in o || "avatarUrl" in o) {
          if (o.username === undefined || o.username === null) o.username = p.username;
          if (o.avatarUrl === undefined || o.avatarUrl === null) o.avatarUrl = p.avatarUrl;
          if (o.displayName === undefined || o.displayName === null) o.displayName = p.displayName;
        } else if (!("walletProfile" in o)) o.walletProfile = p;
        continue;
      }
      const target = k === "owner_wallet" ? "owner_profile" : `${k.slice(0, -"Wallet".length)}Profile`;
      if (!(target in o)) o[target] = p;
      if (k === "authorWallet" && typeof o.authorName === "string") {
        const name = p.displayName ?? (p.username ? `@${p.username}` : null);
        if (name) o.authorName = name;
      }
    }
  });
}

/** Express middleware; mount it before the routers. */
export function profileEnrichment(lookup: ProfileLookup, agentLookup?: AgentAvatarLookup) {
  const agentCache = new Map<string, { at: number; url: string | null }>();
  async function resolveAgents(ids: string[], slugs: string[]): Promise<{ byId: Map<string, string>; bySlug: Map<string, string> }> {
    const byId = new Map<string, string>();
    const bySlug = new Map<string, string>();
    if (!agentLookup) return { byId, bySlug };
    const now = Date.now();
    const missIds: string[] = [];
    const missSlugs: string[] = [];
    for (const [list, map, miss, p] of [[ids, byId, missIds, "i:"], [slugs, bySlug, missSlugs, "s:"]] as const) {
      for (const k of list) {
        const hit = agentCache.get(p + k);
        if (hit && now - hit.at < TTL_MS) {
          if (hit.url) map.set(k, hit.url);
        } else miss.push(k);
      }
    }
    if (missIds.length || missSlugs.length) {
      const rows = await agentLookup(missIds, missSlugs);
      if (agentCache.size > 5000) agentCache.clear();
      for (const k of missIds) agentCache.set("i:" + k, { at: now, url: null });
      for (const k of missSlugs) agentCache.set("s:" + k, { at: now, url: null });
      for (const r of rows) {
        if (!r.avatarUrl) continue;
        if (missIds.includes(r.id)) {
          byId.set(r.id, r.avatarUrl);
          agentCache.set("i:" + r.id, { at: now, url: r.avatarUrl });
        }
        if (r.slug && missSlugs.includes(r.slug)) {
          bySlug.set(r.slug, r.avatarUrl);
          agentCache.set("s:" + r.slug, { at: now, url: r.avatarUrl });
        }
      }
    }
    return { byId, bySlug };
  }

  const cache = new Map<string, { at: number; p: PublicProfile | null }>();
  async function resolve(wallets: string[]): Promise<Map<string, PublicProfile>> {
    const now = Date.now();
    const out = new Map<string, PublicProfile>();
    const missing: string[] = [];
    for (const w of wallets) {
      const hit = cache.get(w);
      if (hit && now - hit.at < TTL_MS) {
        if (hit.p) out.set(w, hit.p);
      } else missing.push(w);
    }
    if (missing.length) {
      const found = new Map((await lookup(missing)).map((p) => [p.wallet, toPublicProfile(p)]));
      if (cache.size > 5000) cache.clear();
      for (const w of missing) {
        const p = found.get(w) ?? null;
        cache.set(w, { at: now, p });
        if (p) out.set(w, p);
      }
    }
    return out;
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const original = res.json.bind(res);
    res.json = ((body: unknown) => {
      // A write of the caller's own profile must show at once.
      if (req.method !== "GET" && req.wallet) cache.delete(req.wallet);
      // An agent picture change shows at once too.
      if (req.method !== "GET" && /^\/(admin\/)?agents\/[^/]+\/avatar/.test(req.path)) agentCache.clear();
      const isObject = typeof body === "object" && body !== null;
      const wallets = isObject ? collectWallets(body) : [];
      const refs = isObject && agentLookup ? collectAgentRefs(body) : { ids: [], slugs: [] };
      if (wallets.length === 0 && refs.ids.length === 0 && refs.slugs.length === 0) return original(body);
      Promise.all([
        wallets.length ? resolve(wallets).catch(() => new Map<string, PublicProfile>()) : Promise.resolve(new Map<string, PublicProfile>()),
        refs.ids.length || refs.slugs.length ? resolveAgents(refs.ids, refs.slugs).catch(() => null) : Promise.resolve(null),
      ])
        .then(([profiles, agents]) => {
          try {
            if (profiles.size) enrichWithProfiles(body, profiles);
            if (agents && (agents.byId.size || agents.bySlug.size)) enrichWithAgentAvatars(body, agents.byId, agents.bySlug);
          } catch {
            // never fail a response over a picture
          }
          original(body);
        })
        .catch(() => original(body));
      return res;
    }) as Response["json"];
    next();
  };
}

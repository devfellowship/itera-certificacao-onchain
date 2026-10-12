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
 *   `wallet` + `displayName`/`handle` in the same object (a profile-shaped object) → `username`, `avatarUrl`
 *   `wallet` elsewhere → `walletProfile`
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
        if ("displayName" in o || "handle" in o || "username" in o) {
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
export function profileEnrichment(lookup: ProfileLookup) {
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
      const wallets = typeof body === "object" && body !== null ? collectWallets(body) : [];
      if (wallets.length === 0) return original(body);
      resolve(wallets)
        .then((profiles) => {
          if (profiles.size) enrichWithProfiles(body, profiles);
          original(body);
        })
        .catch(() => original(body));
      return res;
    }) as Response["json"];
    next();
  };
}

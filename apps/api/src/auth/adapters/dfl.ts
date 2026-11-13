import { createHash } from "node:crypto";
import { Router, type Response as ExpressResponse } from "express";
import { dflAuthConfigFromEnv, type DflAuthConfig } from "../../config.js";
import { SchemaNotReadyError } from "../../domain/runs-store.js";
import { dflPrincipalId, type UsersStore } from "../../domain/users-store.js";
import { issueSessionToken } from "../session.js";
import type { ActorType, AuthAdapter, Principal } from "./types.js";

/**
 * Login with DFL (web2 client), task T5 of plan 20261015-testmyagent-web2-client (ADR-2).
 *
 * `POST /auth/dfl/exchange {dflToken}`:
 * 1. The API verifies the DFL access token at DFL Supabase Auth: `GET {DFL_SUPABASE_URL}/auth/v1/user`
 *    with the token as bearer and the public anon key as `apikey` (3 s timeout). The user must have
 *    `aud = authenticated`. A positive answer is cached for 60 s, keyed by the SHA-256 of the token.
 * 2. When `TMA_MIN_IAM_LEVEL` > 0, the API reads the caller's DFL IAM level with
 *    `POST {DFL_SUPABASE_URL}/rest/v1/rpc/get_my_iam_role` (same bearer). The RPC returns
 *    `TABLE(role_id text, level int)`: no row = level 0.
 * 3. The API upserts the `users` row.
 * 4. The actor type (plan 20261112-tma-c8-routing-from-evals, Q b5c4ba38 = B), decided in this order:
 *    a. the token's payload (the middle part, base64url; Supabase already verified the token) carries a non-empty
 *       `client_id` claim → an MCP OAuth grant token (an agent can hold one with a human's `sub`) → `unknown`; an
 *       undecodable payload → `unknown`;
 *    b. `app_metadata.kind === "agent"` in the /auth/v1/user answer → `agent`;
 *    c. else `POST {DFL_SUPABASE_URL}/rest/v1/rpc/current_human_actor` (`Content-Profile: iam`, same bearer, 3 s):
 *       200 + a uuid → `human`; 200 + null → `unknown`; anything else → `unknown` and one log line (never the token).
 *    The login still succeeds without `human`: the claim only gates route approvals (fail closed).
 * 5. The API mints the TMA session (`sub = dfl:<uuid>`, `amr = dfl`, `act` = the actor type, 24 h).
 *
 * Answers: 200 `{sessionToken, expiresAt, user:{id, email}}` · 400 no token · 401 `dfl_token_invalid`
 * · 403 `iam_level_too_low` | `account_disabled` · 503 `dfl_auth_unavailable` (+ `Retry-After: 5`)
 * · 503 `dfl_auth_not_configured`.
 *
 * Security: the DFL token is never logged (not even a prefix), never stored, and never used as a
 * cache key. The web client discards it after the exchange.
 */

const DFL_PRINCIPAL_RE = /^dfl:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DFL_AUTH_TIMEOUT_MS = 3_000;
export const DFL_TOKEN_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 10_000;
/** A Supabase access token is a JWT of ~1 KB. Anything far bigger is not one. */
const MAX_TOKEN_LENGTH = 16_384;
export const DFL_RETRY_AFTER_SECONDS = 5;

export function isDflPrincipalId(value: string): boolean {
  return DFL_PRINCIPAL_RE.test(value);
}

export interface DflUser {
  /** DFL Supabase Auth user id (uuid). */
  id: string;
  email: string | null;
  /** The user's `app_metadata` (an object, else null). `kind: "agent"` marks an agent login. */
  app_metadata: Record<string, unknown> | null;
}

export type DflVerifyResult = { kind: "ok"; user: DflUser } | { kind: "invalid" } | { kind: "unavailable"; reason: string };
export type DflIamResult = { kind: "ok"; level: number } | { kind: "invalid" } | { kind: "unavailable"; reason: string };
export type DflHumanActorResult = { kind: "ok"; actorId: string | null } | { kind: "unavailable"; reason: string };

/** The part of `fetch` the adapter uses. */
export interface FetchAnswer {
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (input: string, init?: RequestInit) => Promise<FetchAnswer>;

export interface DflAuthDeps {
  /** The `users` table. Absent → the exchange answers 503 `dfl_auth_not_configured`. */
  users?: UsersStore;
  /** Defaults to `dflAuthConfigFromEnv()`, read per request. */
  config?: () => DflAuthConfig;
  /** Defaults to `globalThis.fetch`. Tests inject a mock. */
  fetch?: FetchLike;
  now?: () => number;
  /** Defaults to `console.warn`. Never receives the token. */
  log?: (line: string) => void;
}

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function errorReason(e: unknown): string {
  if (e instanceof Error) return e.name === "AbortError" || e.name === "TimeoutError" ? "timeout" : e.name;
  return "error";
}

/** Verifies DFL tokens at Supabase Auth, with a short positive cache. One instance per adapter. */
export class DflTokenVerifier {
  private readonly cache = new Map<string, { user: DflUser; expiresAtMs: number }>();

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly now: () => number,
  ) {}

  async verify(token: string, config: DflAuthConfig & { anonKey: string }): Promise<DflVerifyResult> {
    const key = tokenKey(token);
    const nowMs = this.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAtMs > nowMs) return { kind: "ok", user: cached.user };
    if (cached) this.cache.delete(key);

    let res: FetchAnswer;
    try {
      res = await this.fetchImpl(`${config.supabaseUrl}/auth/v1/user`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, apikey: config.anonKey },
        signal: AbortSignal.timeout(DFL_AUTH_TIMEOUT_MS),
      });
    } catch (e) {
      return { kind: "unavailable", reason: `auth/v1/user ${errorReason(e)}` };
    }
    if (res.status === 429 || res.status >= 500) return { kind: "unavailable", reason: `auth/v1/user answered ${res.status}` };
    if (res.status !== 200) return { kind: "invalid" };
    let body: { id?: unknown; email?: unknown; aud?: unknown; app_metadata?: unknown } | null;
    try {
      body = (await res.json()) as typeof body;
    } catch (e) {
      return { kind: "unavailable", reason: `auth/v1/user body ${errorReason(e)}` };
    }
    if (!body || typeof body.id !== "string" || !UUID_RE.test(body.id) || body.aud !== "authenticated") return { kind: "invalid" };
    const meta = body.app_metadata;
    const user: DflUser = {
      id: body.id.toLowerCase(),
      email: typeof body.email === "string" && body.email ? body.email : null,
      app_metadata: meta !== null && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null,
    };

    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      for (const [k, v] of this.cache) if (v.expiresAtMs <= nowMs) this.cache.delete(k);
      if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.clear();
    }
    this.cache.set(key, { user, expiresAtMs: nowMs + DFL_TOKEN_CACHE_TTL_MS });
    return { kind: "ok", user };
  }

  /** The caller's DFL IAM level (`public.get_my_iam_role()`, SECURITY DEFINER on `auth.uid()`). */
  async iamLevel(token: string, config: DflAuthConfig & { anonKey: string }): Promise<DflIamResult> {
    let res: FetchAnswer;
    try {
      res = await this.fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/get_my_iam_role`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, apikey: config.anonKey, "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(DFL_AUTH_TIMEOUT_MS),
      });
    } catch (e) {
      return { kind: "unavailable", reason: `get_my_iam_role ${errorReason(e)}` };
    }
    if (res.status === 401 || res.status === 403) return { kind: "invalid" };
    if (res.status !== 200) return { kind: "unavailable", reason: `get_my_iam_role answered ${res.status}` };
    let rows: unknown;
    try {
      rows = await res.json();
    } catch (e) {
      return { kind: "unavailable", reason: `get_my_iam_role body ${errorReason(e)}` };
    }
    // TABLE(role_id text, level int): zero rows for a user without a role, one row otherwise. An
    // unreadable answer is a failure, never a level: a default level on an error path turns the
    // gate into decoration.
    const list = Array.isArray(rows) ? rows : rows && typeof rows === "object" ? [rows] : null;
    if (!list) return { kind: "unavailable", reason: "get_my_iam_role answered an unreadable body" };
    let level = 0;
    for (const row of list) {
      const value = Number((row as { level?: unknown } | null)?.level);
      if (!Number.isFinite(value)) return { kind: "unavailable", reason: "get_my_iam_role answered an unreadable level" };
      level = Math.max(level, value);
    }
    return { kind: "ok", level };
  }

  /**
   * The caller's DFL human actor id (`iam.current_human_actor()` over PostgREST, `Content-Profile: iam`). The RPC
   * answers null for an agent user and for a user without a human actor. Any failure is `unavailable`, never human.
   */
  async humanActor(token: string, config: DflAuthConfig & { anonKey: string }): Promise<DflHumanActorResult> {
    let res: FetchAnswer;
    try {
      res = await this.fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/current_human_actor`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, apikey: config.anonKey, "Content-Type": "application/json", "Content-Profile": "iam" },
        body: "{}",
        signal: AbortSignal.timeout(DFL_AUTH_TIMEOUT_MS),
      });
    } catch (e) {
      return { kind: "unavailable", reason: `current_human_actor ${errorReason(e)}` };
    }
    if (res.status !== 200) return { kind: "unavailable", reason: `current_human_actor answered ${res.status}` };
    let value: unknown;
    try {
      value = await res.json();
    } catch (e) {
      return { kind: "unavailable", reason: `current_human_actor body ${errorReason(e)}` };
    }
    if (value === null) return { kind: "ok", actorId: null };
    if (typeof value === "string" && UUID_RE.test(value)) return { kind: "ok", actorId: value.toLowerCase() };
    return { kind: "unavailable", reason: "current_human_actor answered an unreadable body" };
  }

  /** Test-only. */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * The `client_id` claim of a DFL access token, read from its payload without a signature check (Supabase verified the
 * token at /auth/v1/user before this runs). `undecodable` when the token is not a JWT with a JSON object payload.
 */
export function dflTokenClientId(token: string): { kind: "ok"; clientId: string | null } | { kind: "undecodable" } {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return { kind: "undecodable" };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return { kind: "undecodable" };
    const cid = (payload as { client_id?: unknown }).client_id;
    if (cid === undefined || cid === null || cid === "") return { kind: "ok", clientId: null };
    return { kind: "ok", clientId: typeof cid === "string" ? cid : String(cid) };
  } catch {
    return { kind: "undecodable" };
  }
}

/** The actor type of a verified DFL login (see the header, step 4). Never throws; never logs the token. */
export async function dflActorType(
  token: string,
  user: DflUser,
  verifier: DflTokenVerifier,
  config: DflAuthConfig & { anonKey: string },
  log: (line: string) => void,
): Promise<ActorType> {
  const decoded = dflTokenClientId(token);
  // An MCP OAuth grant token (client_id) is never a person's own login, even with a human's sub.
  if (decoded.kind === "undecodable" || decoded.clientId !== null) return "unknown";
  if (user.app_metadata?.kind === "agent") return "agent";
  const human = await verifier.humanActor(token, config);
  if (human.kind === "unavailable") {
    log(`[dfl-auth] actor type unavailable: ${human.reason}`);
    return "unknown";
  }
  return human.actorId !== null ? "human" : "unknown";
}

function unavailable(res: ExpressResponse): void {
  res.set("Retry-After", String(DFL_RETRY_AFTER_SECONDS));
  res.status(503).json({ error: "dfl_auth_unavailable" });
}

export function createDflRouter(deps: DflAuthDeps = {}): Router {
  const readConfig = deps.config ?? (() => dflAuthConfigFromEnv());
  const log = deps.log ?? ((line: string) => console.warn(line));
  const now = deps.now ?? Date.now;
  const verifier = new DflTokenVerifier(deps.fetch ?? ((input, init) => globalThis.fetch(input, init)), now);
  const router = Router();

  router.post("/auth/dfl/exchange", async (req, res) => {
    const dflToken = (req.body as { dflToken?: unknown } | undefined)?.dflToken;
    if (typeof dflToken !== "string" || !dflToken.trim() || dflToken.length > MAX_TOKEN_LENGTH) {
      res.status(400).json({ error: "dflToken_required" });
      return;
    }
    const token = dflToken.trim();
    const config = readConfig();
    if (!config.anonKey || !deps.users) {
      log(`[dfl-auth] exchange refused: ${!config.anonKey ? "DFL_SUPABASE_ANON_KEY is not set" : "no users store is wired"}`);
      res.status(503).json({ error: "dfl_auth_not_configured" });
      return;
    }
    const keyed = { ...config, anonKey: config.anonKey };

    const verified = await verifier.verify(token, keyed);
    if (verified.kind === "invalid") {
      res.status(401).json({ error: "dfl_token_invalid" });
      return;
    }
    if (verified.kind === "unavailable") {
      log(`[dfl-auth] DFL Supabase Auth unavailable: ${verified.reason}`);
      unavailable(res);
      return;
    }

    let iamLevel: number | null = null;
    if (config.minIamLevel > 0) {
      const iam = await verifier.iamLevel(token, keyed);
      if (iam.kind === "invalid") {
        res.status(401).json({ error: "dfl_token_invalid" });
        return;
      }
      if (iam.kind === "unavailable") {
        log(`[dfl-auth] DFL IAM unavailable: ${iam.reason}`);
        unavailable(res);
        return;
      }
      iamLevel = iam.level;
      // Refused before the upsert: a user below the floor gets no row.
      if (iamLevel < config.minIamLevel) {
        res.status(403).json({ error: "iam_level_too_low" });
        return;
      }
    }

    let row;
    try {
      row = await deps.users.upsertDflLogin({ dflUserId: verified.user.id, email: verified.user.email, iamLevel, now: new Date(now()) });
    } catch (e) {
      log(`[dfl-auth] users upsert failed: ${e instanceof SchemaNotReadyError ? e.message : errorReason(e)}`);
      res.status(503).json({ error: e instanceof SchemaNotReadyError ? "schema_not_ready" : "users_store_unavailable" });
      return;
    }
    if (row.disabled) {
      res.status(403).json({ error: "account_disabled" });
      return;
    }

    const actorType = await dflActorType(token, verified.user, verifier, keyed, log);
    const principalId = dflPrincipalId(verified.user.id);
    const { token: sessionToken, expiresAt } = issueSessionToken(principalId, now(), "dfl", undefined, actorType);
    res.json({ sessionToken, expiresAt, user: { id: principalId, email: row.email ?? verified.user.email ?? "" } });
  });

  return router;
}

export function createDflAdapter(deps: DflAuthDeps = {}): AuthAdapter {
  return {
    kind: "dfl",
    router: () => createDflRouter(deps),
    principalFromSubject(sub: string, actorType: ActorType = "unknown"): Principal | null {
      return isDflPrincipalId(sub) ? { id: sub, kind: "dfl", actorType } : null;
    },
  };
}

/** The stateless adapter (session `sub` → principal). Its exchange answers 503
 * `dfl_auth_not_configured`, because it has no users store; `createApp` mounts
 * `createDflAdapter({users})` instead. */
export const dflAdapter: AuthAdapter = createDflAdapter();

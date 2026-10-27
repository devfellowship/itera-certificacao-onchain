import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { DflAuthConfig } from "../config.js";
import { dflAuthConfigFromEnv, CORS_ALLOWED_ORIGINS } from "../config.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { FakeUsersStore } from "../domain/users-store.fake.js";
import type { DflAuthDeps, FetchAnswer, FetchLike } from "./adapters/dfl.js";
import { verifyPrincipalToken } from "./principal.js";
import { issueSessionToken } from "./session.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const SUPABASE = "https://dfl.example.test";
const ANON = "anon-key-for-tests";

interface Call {
  url: string;
  init?: RequestInit;
}

function json(status: number, body: unknown): FetchAnswer {
  return { status, json: async () => body };
}

/** A mock DFL Supabase. `user` answers /auth/v1/user; `iam` answers the IAM RPC. */
function mockDfl(opts: { user?: (token: string) => FetchAnswer | Promise<FetchAnswer>; iam?: () => FetchAnswer | Promise<FetchAnswer> }) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const token = auth.replace(/^Bearer /, "");
    if (url === `${SUPABASE}/auth/v1/user`) return opts.user ? opts.user(token) : json(500, {});
    if (url === `${SUPABASE}/rest/v1/rpc/get_my_iam_role`) return opts.iam ? opts.iam() : json(500, {});
    throw new Error(`unexpected url ${url}`);
  };
  return { calls, fetchImpl };
}

const okUser = (id: string, email = "ana@example.com") => () => json(200, { id, email, aud: "authenticated", role: "authenticated" });

let server: Server | null = null;

async function start(deps: DflAuthDeps): Promise<string> {
  server = createApp(new FakeRepository(), { dflAuth: deps }).listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function restart(deps: DflAuthDeps): Promise<string> {
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  return start(deps);
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
  server = null;
  vi.restoreAllMocks();
});

const config = (over: Partial<DflAuthConfig> = {}) => (): DflAuthConfig => ({ supabaseUrl: SUPABASE, anonKey: ANON, minIamLevel: 0, ...over });

function exchange(base: string, body: unknown) {
  return fetch(`${base}/auth/dfl/exchange`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /auth/dfl/exchange", () => {
  it("valid token → 200, upsert, dfl session (amr=dfl, sub=dfl:<uuid>, 24 h)", async () => {
    const id = randomUUID();
    const users = new FakeUsersStore();
    const { calls, fetchImpl } = mockDfl({ user: okUser(id) });
    const base = await start({ users, config: config(), fetch: fetchImpl, log: () => {} });

    const res = await exchange(base, { dflToken: "dfl-access-token-1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionToken: string; expiresAt: string; user: { id: string; email: string } };
    expect(body.user).toEqual({ id: `dfl:${id}`, email: "ana@example.com" });
    expect(verifyPrincipalToken(body.sessionToken)).toEqual({ id: `dfl:${id}`, kind: "dfl" });
    const ttlMs = Date.parse(body.expiresAt) - Date.now();
    expect(ttlMs).toBeGreaterThan(23.9 * 3600_000);
    expect(ttlMs).toBeLessThanOrEqual(24 * 3600_000);

    expect(users.upserts).toBe(1);
    expect(users.rows.get(`dfl:${id}`)).toMatchObject({ dflUserId: id, email: "ana@example.com", iamLevel: null, disabled: false });
    // The request used the anon key and the token as bearer; the IAM RPC was not called (level 0).
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("apikey")).toBe(ANON);
    expect(headers.get("authorization")).toBe("Bearer dfl-access-token-1");
  });

  it("missing body → 400; expired/invalid token → 401 dfl_token_invalid; wrong aud → 401", async () => {
    let answer: FetchAnswer = json(401, { msg: "expired" });
    const users = new FakeUsersStore();
    const { fetchImpl } = mockDfl({ user: () => answer });
    const base = await start({ users, config: config(), fetch: fetchImpl, log: () => {} });

    expect((await exchange(base, {})).status).toBe(400);
    expect((await exchange(base, { dflToken: "" })).status).toBe(400);
    const expired = await exchange(base, { dflToken: "expired-token" });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ error: "dfl_token_invalid" });

    answer = json(403, { error_code: "bad_jwt" });
    expect((await exchange(base, { dflToken: "bad-token" })).status).toBe(401);

    answer = json(200, { id: randomUUID(), email: "x@example.com", aud: "anon" });
    expect((await exchange(base, { dflToken: "anon-token" })).status).toBe(401);
    expect(users.upserts).toBe(0);
  });

  it("Supabase timeout or 5xx → 503 with Retry-After: 5", async () => {
    let mode: "timeout" | "5xx" = "timeout";
    const { fetchImpl } = mockDfl({
      user: () => {
        if (mode === "5xx") return json(502, {});
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      },
    });
    const base = await start({ users: new FakeUsersStore(), config: config(), fetch: fetchImpl, log: () => {} });

    const timeout = await exchange(base, { dflToken: "slow-token" });
    expect(timeout.status).toBe(503);
    expect(timeout.headers.get("retry-after")).toBe("5");
    expect(await timeout.json()).toEqual({ error: "dfl_auth_unavailable" });

    mode = "5xx";
    const down = await exchange(base, { dflToken: "slow-token" });
    expect(down.status).toBe(503);
    expect(down.headers.get("retry-after")).toBe("5");
  });

  it("uses a 3 s timeout signal on the Supabase call", async () => {
    const { calls, fetchImpl } = mockDfl({ user: okUser(randomUUID()) });
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const base = await start({ users: new FakeUsersStore(), config: config(), fetch: fetchImpl, log: () => {} });
    await exchange(base, { dflToken: "t" });
    expect(timeoutSpy).toHaveBeenCalledWith(3000);
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("a cache hit within 60 s avoids a second fetch; after 60 s the token is verified again", async () => {
    let nowMs = Date.now();
    const users = new FakeUsersStore();
    const { calls, fetchImpl } = mockDfl({ user: okUser(randomUUID()) });
    const base = await start({ users, config: config(), fetch: fetchImpl, log: () => {}, now: () => nowMs });

    expect((await exchange(base, { dflToken: "cached-token" })).status).toBe(200);
    expect((await exchange(base, { dflToken: "cached-token" })).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(users.upserts).toBe(2);

    nowMs += 61_000;
    expect((await exchange(base, { dflToken: "cached-token" })).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("a negative answer is never cached", async () => {
    const { calls, fetchImpl } = mockDfl({ user: () => json(401, {}) });
    const base = await start({ users: new FakeUsersStore(), config: config(), fetch: fetchImpl, log: () => {} });
    await exchange(base, { dflToken: "bad" });
    await exchange(base, { dflToken: "bad" });
    expect(calls).toHaveLength(2);
  });

  it("never writes the token (or any part of it) to a log line", async () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.SECRET-PAYLOAD-abcdef123456.SIGNATURE-xyz789";
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation(capture);

    let answer: () => FetchAnswer = () => {
      throw new Error("network down");
    };
    const users = new FakeUsersStore();
    const { fetchImpl } = mockDfl({ user: () => answer(), iam: () => json(500, {}) });
    // No `log` dep: the adapter logs through console, which is captured.
    const base = await start({ users, config: config(), fetch: fetchImpl });

    expect((await exchange(base, { dflToken: token })).status).toBe(503); // network error
    answer = () => json(500, {});
    expect((await exchange(base, { dflToken: token })).status).toBe(503); // 5xx
    answer = () => json(401, {});
    expect((await exchange(base, { dflToken: token })).status).toBe(401); // invalid
    answer = okUser(randomUUID());
    expect((await exchange(base, { dflToken: token })).status).toBe(200); // ok
    const iamDown = await restart({ users, config: config({ minIamLevel: 50 }), fetch: fetchImpl });
    expect((await exchange(iamDown, { dflToken: token })).status).toBe(503); // IAM 5xx
    const noKey = await restart({ users, config: config({ anonKey: null }), fetch: fetchImpl });
    expect((await exchange(noKey, { dflToken: token })).status).toBe(503); // not configured

    expect(lines.length).toBeGreaterThan(0);
    for (const fragment of [token, token.slice(0, 8), "SECRET-PAYLOAD", "SIGNATURE-xyz789", "eyJhbGci"]) {
      for (const line of lines) expect(line).not.toContain(fragment);
    }
  });

  it("missing DFL_SUPABASE_ANON_KEY → 503 dfl_auth_not_configured, no fetch", async () => {
    const { calls, fetchImpl } = mockDfl({ user: okUser(randomUUID()) });
    const base = await start({ users: new FakeUsersStore(), config: config({ anonKey: null }), fetch: fetchImpl, log: () => {} });
    const res = await exchange(base, { dflToken: "t" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "dfl_auth_not_configured" });
    expect(calls).toHaveLength(0);
  });

  it("TMA_MIN_IAM_LEVEL=50 with level 10 → 403 iam_level_too_low, no row; level 50 → 200 and the level is stored", async () => {
    let rows: unknown = [{ role_id: "guest", level: 10 }];
    const id = randomUUID();
    const users = new FakeUsersStore();
    const { calls, fetchImpl } = mockDfl({ user: okUser(id), iam: () => json(200, rows) });
    const base = await start({ users, config: config({ minIamLevel: 50 }), fetch: fetchImpl, log: () => {} });

    const low = await exchange(base, { dflToken: "member-token" });
    expect(low.status).toBe(403);
    expect(await low.json()).toEqual({ error: "iam_level_too_low" });
    expect(users.upserts).toBe(0);
    const rpc = calls.find((c) => c.url.endsWith("/rest/v1/rpc/get_my_iam_role"))!;
    expect(rpc.init?.method).toBe("POST");
    expect(new Headers(rpc.init?.headers).get("authorization")).toBe("Bearer member-token");

    rows = []; // no role = level 0
    expect((await exchange(base, { dflToken: "member-token" })).status).toBe(403);

    rows = [{ role_id: "member", level: 50 }];
    const ok = await exchange(base, { dflToken: "member-token" });
    expect(ok.status).toBe(200);
    expect(users.rows.get(`dfl:${id}`)?.iamLevel).toBe(50);

    rows = [{ role_id: "member", level: "not-a-number" }];
    const bad = await exchange(base, { dflToken: "member-token" });
    expect(bad.status).toBe(503);
  });

  it("a disabled account → 403 account_disabled", async () => {
    const id = randomUUID();
    const users = new FakeUsersStore();
    const { fetchImpl } = mockDfl({ user: okUser(id) });
    const base = await start({ users, config: config(), fetch: fetchImpl, log: () => {} });
    expect((await exchange(base, { dflToken: "t" })).status).toBe(200);
    users.rows.get(`dfl:${id}`)!.disabled = true;
    const res = await exchange(base, { dflToken: "t" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "account_disabled" });
  });
});

describe("GET /auth/me", () => {
  it("answers {id, kind, wallet, email} for a dfl principal and {id, kind, wallet} for a siws principal", async () => {
    const id = randomUUID();
    const users = new FakeUsersStore();
    const { fetchImpl } = mockDfl({ user: okUser(id, "bia@example.com") });
    const base = await start({ users, config: config(), fetch: fetchImpl, log: () => {} });
    const { sessionToken } = (await (await exchange(base, { dflToken: "t" })).json()) as { sessionToken: string };

    const me = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ id: `dfl:${id}`, kind: "dfl", wallet: `dfl:${id}`, email: "bia@example.com" });

    const wallet = "11111111111111111111111111111111";
    const siws = issueSessionToken(wallet, Date.now(), "siws").token;
    const meSiws = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${siws}` } });
    expect(meSiws.status).toBe(200);
    expect(await meSiws.json()).toEqual({ id: wallet, kind: "siws", wallet });

    expect((await fetch(`${base}/auth/me`)).status).toBe(401);
  });

  it("refuses a disabled dfl account and a level below TMA_MIN_IAM_LEVEL", async () => {
    const id = randomUUID();
    const users = new FakeUsersStore();
    await users.upsertDflLogin({ dflUserId: id, email: "c@example.com", iamLevel: 10 });
    let min = 0;
    const base = await start({ users, config: () => ({ supabaseUrl: SUPABASE, anonKey: ANON, minIamLevel: min }), log: () => {} });
    const auth = { Authorization: `Bearer ${issueSessionToken(`dfl:${id}`, Date.now(), "dfl").token}` };

    expect((await fetch(`${base}/auth/me`, { headers: auth })).status).toBe(200);
    min = 50;
    const low = await fetch(`${base}/auth/me`, { headers: auth });
    expect(low.status).toBe(403);
    expect(await low.json()).toEqual({ error: "iam_level_too_low" });
    min = 0;
    users.rows.get(`dfl:${id}`)!.disabled = true;
    const off = await fetch(`${base}/auth/me`, { headers: auth });
    expect(off.status).toBe(403);
    expect(await off.json()).toEqual({ error: "account_disabled" });
  });
});

describe("config", () => {
  it("defaults the DFL Supabase URL, tolerates a missing anon key, and validates TMA_MIN_IAM_LEVEL", () => {
    expect(dflAuthConfigFromEnv({})).toEqual({ supabaseUrl: "https://yoojxnggaxcqtsyjdrdx.supabase.co", anonKey: null, minIamLevel: 0 });
    expect(dflAuthConfigFromEnv({ DFL_SUPABASE_URL: "https://x.test/", TMA_MIN_IAM_LEVEL: "50", DFL_SUPABASE_ANON_KEY: "k" })).toEqual({
      supabaseUrl: "https://x.test",
      anonKey: "k",
      minIamLevel: 50,
    });
    expect(() => dflAuthConfigFromEnv({ TMA_MIN_IAM_LEVEL: "-1" })).toThrow(/TMA_MIN_IAM_LEVEL/);
    expect(() => dflAuthConfigFromEnv({ TMA_MIN_IAM_LEVEL: "abc" })).toThrow(/TMA_MIN_IAM_LEVEL/);
  });

  it("allows the web2 origins by default (new domain + the old host while it redirects)", () => {
    if (!process.env.ITERA_API_CORS_ORIGINS) {
      expect(CORS_ALLOWED_ORIGINS).toContain("https://testmyagent.com");
      expect(CORS_ALLOWED_ORIGINS).toContain("https://testmyagent.devfellowship.com");
      expect(CORS_ALLOWED_ORIGINS).not.toContain("https://www.testmyagent.com");
    }
  });
});

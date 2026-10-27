/**
 * The CLI device login (task L5) over the fake store: every state of a code (pending, slow_down,
 * approved once, consumed, denied, expired, unknown), the web-session-only approval, the rate limit of
 * /auth/cli/start, the CLI session (`sid`, 24 h, dfl principal), and its revocation under /me. The pg
 * store has its own test (store.pg.test.ts) against a migrated Postgres.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { issueSessionToken, verifySessionClaims, SESSION_TTL_SECONDS } from "../auth/session.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { FakeCliAuthStore } from "./store.fake.js";
import { DEVICE_CODE_TTL_SECONDS, normalizeUserCode, sha256Hex } from "./store.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ALICE = "dfl:00000000-0000-4000-8000-00000000000a";
const BOB = "dfl:00000000-0000-4000-8000-00000000000b";
// The fake clock starts at the real time. A fixed date made this file a time bomb: a CLI session issued at
// the fixed T0 lasts 24 h, and the real-clock check of `requireWallet` refused it once the real time passed T0 + 24 h
// (main went red on 2026-10-27 12:00Z).
const T0 = Math.floor(Date.now() / 1000) * 1000;
const web = (id: string) => issueSessionToken(id, Date.now(), "dfl").token;
const siws = () => issueSessionToken("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", Date.now(), "siws").token;

let server: Server;
let base = "";
let store: FakeCliAuthStore;
let clock = T0;

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

async function boot(over: { startPerWindow?: number; decidePerWindow?: number } = {}) {
  store = new FakeCliAuthStore();
  clock = T0;
  server = createApp(new FakeRepository(), {
    cliAuth: { store, web2BaseUrl: "https://web2.example/", now: () => clock, ...over },
  }).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const start = (clientName?: string) => call("POST", "/auth/cli/start", { body: clientName === undefined ? {} : { client_name: clientName } });
const token = (deviceCode: string) => call("POST", "/auth/cli/token", { body: { device_code: deviceCode } });
const approve = (userCode: string, tok = web(ALICE)) => call("POST", "/auth/cli/approve", { token: tok, body: { user_code: userCode } });

/** start → approve → token: a CLI session of `who`. */
async function login(who = ALICE, clientName = "tma 0.1.0 on test-host") {
  const s = await start(clientName);
  await approve(s.json.user_code, web(who));
  clock += 5_000;
  const t = await token(s.json.device_code);
  expect(t.status).toBe(200);
  return t.json as { sessionToken: string; sessionId: string; expiresAt: string };
}

beforeEach(async () => boot());
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("POST /auth/cli/start", () => {
  it("returns a device code, a user code, the approve URL, the interval and expires_in 600", async () => {
    const s = await start("tma 0.1.0 on samuel-vps");
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ interval: 5, expires_in: DEVICE_CODE_TTL_SECONDS, expires_at: new Date(T0 + 600_000).toISOString() });
    expect(s.json.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.json.user_code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(s.json.verification_url).toBe(`https://web2.example/cli?code=${s.json.user_code}`);
    // Only the sha256 of the device code is stored.
    const [row] = [...store.rows.values()];
    expect(row!.deviceCodeSha256).toBe(sha256Hex(s.json.device_code));
    expect(JSON.stringify(row)).not.toContain(s.json.device_code);
    expect(row!.clientName).toBe("tma 0.1.0 on samuel-vps");
  });

  it("refuses a client name with a newline, a quote mark or 61 characters", async () => {
    for (const bad of ["a\nb", 'say "hi"', "x".repeat(61), 42]) {
      const r = await call("POST", "/auth/cli/start", { body: { client_name: bad } });
      expect(r).toMatchObject({ status: 400, json: { error: "invalid_client_name" } });
    }
    expect(store.rows.size).toBe(0);
  });

  it("is rate limited per IP", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await boot({ startPerWindow: 2 });
    expect((await start()).status).toBe(200);
    expect((await start()).status).toBe(200);
    expect(await start()).toMatchObject({ status: 429, json: { error: "rate_limited" } });
  });

  it("answers 503 schema_not_ready before 0021", async () => {
    store.fail = new SchemaNotReadyError("0021_self_declared_results.sql");
    expect(await start()).toMatchObject({ status: 503, json: { error: "schema_not_ready" } });
  });
});

describe("POST /auth/cli/token — the states of a code", () => {
  it("pending → 428 authorization_pending, and 429 slow_down when the CLI polls sooner than the interval", async () => {
    const s = await start();
    expect(await token(s.json.device_code)).toMatchObject({ status: 428, json: { error: "authorization_pending", interval: 5 } });
    clock += 1_000;
    expect(await token(s.json.device_code)).toMatchObject({ status: 429, json: { error: "slow_down" } });
    clock += 5_000;
    expect(await token(s.json.device_code)).toMatchObject({ status: 428, json: { error: "authorization_pending" } });
  });

  it("approved → ONE 24 h dfl session with a sid; the second poll → 400 code_consumed", async () => {
    const s = await start();
    expect((await approve(s.json.user_code)).json).toMatchObject({ state: "approved" });
    clock += 5_000;
    const t = await token(s.json.device_code);
    expect(t.status).toBe(200);
    expect(t.headers.get("cache-control")).toBe("no-store");
    expect(t.json).toMatchObject({ principal: ALICE });
    expect(Date.parse(t.json.expiresAt)).toBe(Math.floor((T0 + 5_000) / 1000) * 1000 + SESSION_TTL_SECONDS * 1000);
    const claims = verifySessionClaims(t.json.sessionToken, T0 + 10_000);
    expect(claims).toMatchObject({ sub: ALICE, amr: "dfl", sid: t.json.sessionId });
    // The session works on a real route.
    const me = await call("GET", "/auth/me", { token: t.json.sessionToken });
    expect(me).toMatchObject({ status: 200, json: { id: ALICE, kind: "dfl" } });
    clock += 5_000;
    expect(await token(s.json.device_code)).toMatchObject({ status: 400, json: { error: "code_consumed" } });
  });

  it("denied → 400 access_denied, and the code cannot be approved after", async () => {
    const s = await start();
    expect((await call("POST", "/auth/cli/deny", { token: web(ALICE), body: { user_code: s.json.user_code } })).json).toMatchObject({ state: "denied" });
    expect(await token(s.json.device_code)).toMatchObject({ status: 400, json: { error: "access_denied" } });
    expect(await approve(s.json.user_code)).toMatchObject({ status: 409, json: { error: "code_already_used" } });
  });

  it("expired (600 s) → 400 code_expired, for the poll and for the approval", async () => {
    const s = await start();
    clock += DEVICE_CODE_TTL_SECONDS * 1000;
    expect(await token(s.json.device_code)).toMatchObject({ status: 400, json: { error: "code_expired" } });
    expect(await approve(s.json.user_code)).toMatchObject({ status: 400, json: { error: "code_expired" } });
  });

  it("an approved code that the CLI takes after 600 s gives no session", async () => {
    const s = await start();
    await approve(s.json.user_code);
    clock += DEVICE_CODE_TTL_SECONDS * 1000 + 1;
    expect(await token(s.json.device_code)).toMatchObject({ status: 400, json: { error: "code_expired" } });
  });

  it("an unknown or malformed device code → 400 invalid_device_code", async () => {
    expect(await token("A".repeat(43))).toMatchObject({ status: 400, json: { error: "invalid_device_code" } });
    expect(await token("short")).toMatchObject({ status: 400, json: { error: "invalid_device_code" } });
    expect(await call("POST", "/auth/cli/token", { body: {} })).toMatchObject({ status: 400, json: { error: "invalid_device_code" } });
  });
});

describe("POST /auth/cli/approve — one approval, from a web session of a DFL user", () => {
  it("approves once: a second approval (any user) → 409 code_already_used", async () => {
    const s = await start();
    expect((await approve(s.json.user_code)).status).toBe(200);
    expect(await approve(s.json.user_code)).toMatchObject({ status: 409, json: { error: "code_already_used" } });
    expect(await approve(s.json.user_code, web(BOB))).toMatchObject({ status: 409, json: { error: "code_already_used" } });
    // The code stays bound to the first approver.
    clock += 5_000;
    expect((await token(s.json.device_code)).json.principal).toBe(ALICE);
  });

  it("accepts the user code typed in lower case or without the dash", async () => {
    const s = await start();
    const typed = s.json.user_code.replace("-", "").toLowerCase();
    expect((await approve(typed)).json).toMatchObject({ state: "approved", user_code: s.json.user_code });
  });

  it("needs a session (401), a dfl principal (403), and a web session, not a CLI one (403)", async () => {
    const s = await start();
    expect((await call("POST", "/auth/cli/approve", { body: { user_code: s.json.user_code } })).status).toBe(401);
    expect(await approve(s.json.user_code, siws())).toMatchObject({ status: 403, json: { error: "cli_login_dfl_only" } });
    const cli = await login();
    expect(await approve(s.json.user_code, cli.sessionToken)).toMatchObject({ status: 403, json: { error: "cli_session_cannot_approve" } });
  });

  it("404 code_not_found and 400 invalid_user_code", async () => {
    expect(await approve("ABCD-EFGH")).toMatchObject({ status: 404, json: { error: "code_not_found" } });
    expect(await approve("nope")).toMatchObject({ status: 400, json: { error: "invalid_user_code" } });
  });

  it("is rate limited per principal (a user code cannot be guessed)", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await boot({ decidePerWindow: 3 });
    for (let i = 0; i < 3; i++) expect((await approve("ABCD-EFGH")).status).toBe(404);
    expect(await approve("ABCD-EFGH")).toMatchObject({ status: 429, json: { error: "rate_limited" } });
  });

  it("GET /auth/cli/requests/:userCode shows the client name and the state, and never a device code", async () => {
    const s = await start("tma 0.1.0 on samuel-vps");
    const r = await call("GET", `/auth/cli/requests/${s.json.user_code}`, { token: web(ALICE) });
    expect(r).toMatchObject({ status: 200, json: { user_code: s.json.user_code, client_name: "tma 0.1.0 on samuel-vps", state: "pending" } });
    expect(JSON.stringify(r.json)).not.toContain(s.json.device_code);
    expect((await call("GET", `/auth/cli/requests/${s.json.user_code}`)).status).toBe(401);
    expect((await call("GET", "/auth/cli/requests/ZZZZ-ZZZZ", { token: web(ALICE) })).status).toBe(404);
  });
});

describe("CLI sessions under /me — list and revoke", () => {
  it("lists the caller's CLI sessions only, and marks the current one", async () => {
    const a = await login(ALICE, "tma on laptop");
    await login(BOB, "tma on bob-vps");
    const r = await call("GET", "/me/cli-sessions", { token: a.sessionToken });
    expect(r.status).toBe(200);
    expect(r.json.sessions).toHaveLength(1);
    expect(r.json.sessions[0]).toMatchObject({ id: a.sessionId, client_name: "tma on laptop", revoked_at: null, current: true, expires_at: a.expiresAt });
    const fromWeb = await call("GET", "/me/cli-sessions", { token: web(ALICE) });
    expect(fromWeb.json.sessions[0]).toMatchObject({ id: a.sessionId, current: false });
  });

  it("revokes a session: its token gets 401 cli_session_revoked on every route at once; web sessions still work", async () => {
    const a = await login();
    expect((await call("GET", "/auth/me", { token: a.sessionToken })).status).toBe(200);
    expect((await call("DELETE", `/me/cli-sessions/${a.sessionId}`, { token: web(ALICE) })).status).toBe(204);
    for (const [m, p] of [["GET", "/auth/me"], ["GET", "/me/cli-sessions"], ["POST", "/self-declared-results"]] as const) {
      expect(await call(m, p, { token: a.sessionToken, body: m === "POST" ? {} : undefined })).toMatchObject({ status: 401, json: { error: "cli_session_revoked" } });
    }
    expect((await call("GET", "/auth/me", { token: web(ALICE) })).status).toBe(200);
    const list = await call("GET", "/me/cli-sessions", { token: web(ALICE) });
    expect(list.json.sessions[0].revoked_at).toBe(new Date(clock).toISOString());
  });

  it("a CLI session can revoke itself (logout); another user's session → 404", async () => {
    const a = await login(ALICE);
    const b = await login(BOB);
    expect(await call("DELETE", `/me/cli-sessions/${b.sessionId}`, { token: a.sessionToken })).toMatchObject({ status: 404, json: { error: "cli_session_not_found" } });
    expect((await call("GET", "/auth/me", { token: b.sessionToken })).status).toBe(200);
    expect((await call("DELETE", `/me/cli-sessions/${a.sessionId}`, { token: a.sessionToken })).status).toBe(204);
    expect((await call("GET", "/auth/me", { token: a.sessionToken })).status).toBe(401);
    expect((await call("DELETE", "/me/cli-sessions/not-a-uuid", { token: web(ALICE) })).status).toBe(404);
  });

  it("refuses a sid whose row is gone, or that names another principal", async () => {
    const a = await login(ALICE);
    const forged = issueSessionToken(BOB, Date.now(), "dfl", a.sessionId).token;
    expect(await call("GET", "/auth/me", { token: forged })).toMatchObject({ status: 401, json: { error: "cli_session_revoked" } });
    store.rows.clear();
    expect(await call("GET", "/auth/me", { token: issueSessionToken(ALICE, Date.now(), "dfl", "11111111-1111-4111-8111-111111111111").token })).toMatchObject({
      status: 401,
      json: { error: "cli_session_revoked" },
    });
  });

  it("fails closed (503) when the store fails, and a web session costs no lookup", async () => {
    const a = await login();
    const before = store.sessionLookups;
    await call("GET", "/auth/me", { token: web(ALICE) });
    expect(store.sessionLookups).toBe(before);
    store.fail = new Error("db down");
    // A fresh process has no cache: use a sid that was never cached.
    const fresh = issueSessionToken(ALICE, Date.now(), "dfl", "22222222-2222-4222-8222-222222222222").token;
    expect(await call("GET", "/auth/me", { token: fresh })).toMatchObject({ status: 503, json: { error: "cli_sessions_unavailable" } });
    void a;
  });
});

describe("normalizeUserCode", () => {
  it("accepts the typed forms and refuses the rest", () => {
    expect(normalizeUserCode("abcd efgh")).toBe("ABCD-EFGH");
    expect(normalizeUserCode("ABCDEFGH")).toBe("ABCD-EFGH");
    expect(normalizeUserCode("ABC-DEFG")).toBe(null);
    expect(normalizeUserCode("ABCD-EFG!")).toBe(null);
    expect(normalizeUserCode(12345678)).toBe(null);
  });
});

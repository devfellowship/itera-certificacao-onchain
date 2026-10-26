/**
 * PgCliAuthStore (task L5) against a real Postgres. Runs when ITERA_PG_TEST_URL points at a THROWAWAY
 * Postgres with db/migrations applied up to 0021 (the web3 e2e guard job sets it). Never a real project.
 *
 * Proves every state of a device code on the real table and its CHECKs: pending, slow_down, approved ONE
 * time (two concurrent approvals → one winner), consumed ONE time (two concurrent polls → one session),
 * denied, expired, unknown; the session list of a principal; revocation; and the housekeeping delete.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_TTL_SECONDS } from "../auth/session.js";
import { PgCliAuthStore } from "./store.pg.js";
import { DEVICE_CODE_TTL_SECONDS, newDeviceCode, newUserCode, sha256Hex } from "./store.js";

const URL_ = process.env.ITERA_PG_TEST_URL;

describe.skipIf(!URL_)("PgCliAuthStore on Postgres (0021 applied)", () => {
  const pool = new Pool({ connectionString: URL_, max: 6 });
  const store = new PgCliAuthStore(() => pool);
  const ALICE = `dfl:${randomUUID()}`;
  const BOB = `dfl:${randomUUID()}`;
  const T0 = new Date("2031-01-01T00:00:00Z");
  const at = (s: number) => new Date(T0.getTime() + s * 1000);
  const made: string[] = [];

  async function fresh(clientName: string | null = "tma 0.1.0 on pg-test", t = T0) {
    const device = newDeviceCode();
    const user = newUserCode();
    const hash = sha256Hex(device);
    made.push(hash);
    await store.create({ deviceCodeSha256: hash, userCode: user, clientName, expiresAt: new Date(t.getTime() + DEVICE_CODE_TTL_SECONDS * 1000) }, t);
    return { device, user, hash };
  }

  beforeAll(async () => {
    const { rows } = await pool.query(`select 1 from information_schema.columns where table_name = 'cli_device_codes' and column_name = 'session_id'`);
    expect(rows).toHaveLength(1);
  });

  afterAll(async () => {
    await pool.query(`delete from public.cli_device_codes where device_code_sha256 = any($1) or principal = any($2)`, [made, [ALICE, BOB]]);
    await pool.end();
  });

  it("stores only the sha256 of the device code, and the client name", async () => {
    const c = await fresh("tma on samuel-vps");
    const { rows } = await pool.query(`select * from public.cli_device_codes where user_code = $1`, [c.user]);
    expect(rows[0]).toMatchObject({ device_code_sha256: c.hash, client_name: "tma on samuel-vps", principal: null });
    expect(JSON.stringify(rows[0])).not.toContain(c.device);
    expect(await store.describe(c.user, T0)).toMatchObject({ userCode: c.user, clientName: "tma on samuel-vps", state: "pending" });
  });

  it("refuses a user code that is taken (409 user_code_collision) and a client name with a quote mark (CHECK)", async () => {
    const c = await fresh();
    await expect(store.create({ deviceCodeSha256: sha256Hex(newDeviceCode()), userCode: c.user, clientName: null, expiresAt: at(600) }, T0)).rejects.toMatchObject({
      status: 409,
      code: "user_code_collision",
    });
    await expect(store.create({ deviceCodeSha256: sha256Hex(newDeviceCode()), userCode: newUserCode(), clientName: 'say "hi"', expiresAt: at(600) }, T0)).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("pending → slow_down when polled too fast → approved once → consumed", async () => {
    const c = await fresh();
    expect(await store.poll(c.hash, at(1), randomUUID())).toEqual({ kind: "pending" });
    expect(await store.poll(c.hash, at(2), randomUUID())).toEqual({ kind: "slow_down" });
    expect(await store.poll(c.hash, at(8), randomUUID())).toEqual({ kind: "pending" });
    expect(await store.approve(c.user, ALICE, at(10))).toMatchObject({ state: "approved" });
    const sid = randomUUID();
    expect(await store.poll(c.hash, at(11), sid)).toEqual({ kind: "approved", principal: ALICE, sessionId: sid });
    expect(await store.poll(c.hash, at(16), randomUUID())).toEqual({ kind: "consumed" });
    expect(await store.session(sid)).toEqual({ principal: ALICE, revoked: false });
  });

  it("two concurrent approvals: exactly one wins; the other gets 409 code_already_used", async () => {
    const c = await fresh();
    const results = await Promise.allSettled([store.approve(c.user, ALICE, at(5)), store.approve(c.user, BOB, at(5))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 409, code: "code_already_used" });
  });

  it("two concurrent polls of an approved code: exactly one session", async () => {
    const c = await fresh();
    await store.approve(c.user, ALICE, at(5));
    const out = await Promise.all([store.poll(c.hash, at(6), randomUUID()), store.poll(c.hash, at(6), randomUUID()), store.poll(c.hash, at(6), randomUUID())]);
    expect(out.filter((o) => o.kind === "approved")).toHaveLength(1);
    expect(out.filter((o) => o.kind === "consumed")).toHaveLength(2);
  });

  it("denied: no session, and no approval after", async () => {
    const c = await fresh();
    expect(await store.deny(c.user, at(3))).toMatchObject({ state: "denied" });
    expect(await store.poll(c.hash, at(9), randomUUID())).toEqual({ kind: "denied" });
    await expect(store.approve(c.user, ALICE, at(10))).rejects.toMatchObject({ status: 409, code: "code_already_used" });
  });

  it("expired after 600 s: no approval, and an approved code taken late gives no session", async () => {
    const a = await fresh();
    await expect(store.approve(a.user, ALICE, at(600))).rejects.toMatchObject({ status: 400, code: "code_expired" });
    expect(await store.poll(a.hash, at(600), randomUUID())).toEqual({ kind: "expired" });
    const b = await fresh();
    await store.approve(b.user, ALICE, at(500));
    expect(await store.poll(b.hash, at(601), randomUUID())).toEqual({ kind: "expired" });
    await expect(store.approve("ZZZZ-ZZZZ", ALICE, T0)).rejects.toMatchObject({ status: 404, code: "code_not_found" });
    expect(await store.poll(sha256Hex("never-issued"), T0, randomUUID())).toEqual({ kind: "unknown" });
  });

  it("lists the principal's sessions that are not expired, and revokes one", async () => {
    const c = await fresh("tma on laptop");
    await store.approve(c.user, BOB, at(1));
    const sid = randomUUID();
    await store.poll(c.hash, at(2), sid);
    const list = await store.listSessions(BOB, at(3));
    expect(list).toEqual([
      { id: sid, clientName: "tma on laptop", approvedAt: at(1).toISOString(), createdAt: at(2).toISOString(), expiresAt: at(2 + SESSION_TTL_SECONDS).toISOString(), revokedAt: null },
    ]);
    expect(await store.listSessions(ALICE, at(3)).then((l) => l.some((s) => s.id === sid))).toBe(false);
    // Another principal cannot revoke it.
    expect(await store.revoke(ALICE, sid, at(4))).toBe(false);
    expect(await store.revoke(BOB, sid, at(4))).toBe(true);
    expect(await store.session(sid)).toEqual({ principal: BOB, revoked: true });
    // A second revoke keeps the first time.
    expect(await store.revoke(BOB, sid, at(9))).toBe(true);
    expect((await store.listSessions(BOB, at(10)))[0]!.revokedAt).toBe(at(4).toISOString());
    // After 24 h the session is no longer listed.
    expect(await store.listSessions(BOB, at(2 + SESSION_TTL_SECONDS))).toEqual([]);
  });

  it("housekeeping on create: deletes codes expired an hour ago and sessions older than 2 days, keeps the rest", async () => {
    const old = await fresh(null, T0);
    const live = await fresh(null, T0);
    await store.approve(live.user, ALICE, at(1));
    await store.poll(live.hash, at(2), randomUUID());
    await fresh(null, at(2 * 3600)); // two hours later: the pending code of T0 goes, the session stays
    expect(await store.describe(old.user, at(2 * 3600))).toBeNull();
    expect(await store.describe(live.user, at(2 * 3600))).toMatchObject({ state: "consumed" });
    await fresh(null, at(3 * 86400)); // three days later: the session row goes too
    expect(await store.describe(live.user, at(3 * 86400))).toBeNull();
  });
});

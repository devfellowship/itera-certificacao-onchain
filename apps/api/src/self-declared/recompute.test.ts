/**
 * POST /eval-results/recompute (plan 20261112-tma-c4-result-store-trajectory-upload, C4-T10): the router on a fake
 * store. The SQL is proved on Postgres in recompute.pg.test.ts.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueSessionToken } from "../auth/session.js";
import { createRecomputeRouter, type RecomputeOutcome, type RecomputeStore } from "./recompute.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ALICE = "dfl:00000000-0000-4000-8000-00000000000a";
const BOB = "dfl:00000000-0000-4000-8000-00000000000b";
const dfl = (who: string) => issueSessionToken(who, Date.now(), "dfl").token;

class FakeStore implements RecomputeStore {
  calls: Array<{ owner: string | null; dryRun: boolean; limit: number }> = [];
  async recomputeStepKinds(owner: string | null, o: { dryRun: boolean; limit: number }): Promise<RecomputeOutcome> {
    this.calls.push({ owner, ...o });
    return { scanned: 3, updated: o.dryRun ? 0 : 3, remaining: o.dryRun ? 3 : 0, byKind: { read: 2, test: 1 } };
  }
}

let server: Server;
let base = "";
let store: FakeStore;
let ready = true;
let admins: string[] = [];

beforeEach(async () => {
  store = new FakeStore();
  ready = true;
  admins = [];
  const app = express();
  app.use(express.json());
  app.use(createRecomputeRouter({ store, ready: async () => ready, adminWallets: () => admins }));
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const post = async (body: unknown, who?: string) => {
  const res = await fetch(`${base}/eval-results/recompute`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${dfl(who)}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
};

describe("POST /eval-results/recompute", () => {
  it("needs a session", async () => {
    expect((await post({ column: "step_kind" })).status).toBe(401);
    expect(store.calls).toEqual([]);
  });

  it("is a dry run of the caller's own rows by default", async () => {
    const r = await post({ column: "step_kind" }, ALICE);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ column: "step_kind", dry_run: true, scope: "mine", scanned: 3, updated: 0, remaining: 3, by_kind: { read: 2, test: 1 } });
    expect(store.calls).toEqual([{ owner: ALICE, dryRun: true, limit: 5000 }]);
  });

  it("writes only with the boolean false, and passes the limit", async () => {
    const r = await post({ column: "step_kind", dry_run: false, limit: 100 }, ALICE);
    expect(r.json).toMatchObject({ dry_run: false, updated: 3, remaining: 0 });
    expect(store.calls).toEqual([{ owner: ALICE, dryRun: false, limit: 100 }]);
  });

  it("scope all is for an admin only: 403 for anyone else, every owner (null) for an admin", async () => {
    admins = [ALICE];
    const bob = await post({ column: "step_kind", scope: "all", dry_run: false }, BOB);
    expect(bob).toMatchObject({ status: 403, json: { error: "admin_only" } });
    expect(store.calls).toEqual([]);
    const alice = await post({ column: "step_kind", scope: "all" }, ALICE);
    expect(alice.json).toMatchObject({ scope: "all", dry_run: true });
    expect(store.calls).toEqual([{ owner: null, dryRun: true, limit: 5000 }]);
  });

  it("refuses a bad body with 400 and calls nothing", async () => {
    const cases: Array<[unknown, string]> = [
      [[], "invalid_body"],
      [{ column: "step_kind", owner: BOB }, "unknown_key"],
      [{}, "invalid_column"],
      [{ column: "turn_origin" }, "invalid_column"],
      [{ column: "step_kind", dry_run: "false" }, "invalid_dry_run"],
      [{ column: "step_kind", scope: "everyone" }, "invalid_scope"],
      [{ column: "step_kind", limit: 0 }, "invalid_limit"],
      [{ column: "step_kind", limit: 20001 }, "invalid_limit"],
      [{ column: "step_kind", limit: 2.5 }, "invalid_limit"],
    ];
    for (const [body, error] of cases) {
      const r = await post(body, ALICE);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error, JSON.stringify(body)).toBe(error);
    }
    expect(store.calls).toEqual([]);
  });

  it("answers 503 schema_not_ready before 0024", async () => {
    ready = false;
    expect(await post({ column: "step_kind", dry_run: false }, ALICE)).toMatchObject({ status: 503, json: { error: "schema_not_ready" } });
    expect(store.calls).toEqual([]);
  });
});

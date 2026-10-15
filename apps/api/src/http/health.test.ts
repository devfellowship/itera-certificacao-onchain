import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { checkHealth, createHealthHandler, healthRequiresRunner, type HealthDb } from "./health.js";

const NOW = new Date("2026-10-15T12:00:00Z");

interface FakeOpts {
  down?: boolean;
  hang?: boolean;
  queued?: number;
  seenAt?: Date | null;
  missingTable?: boolean;
  queuedFails?: boolean;
}

/** A fake pool: it answers the three health queries by their text. */
function fakePool(o: FakeOpts = {}): HealthDb & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query(text: string) {
      calls.push(text);
      if (o.hang) return new Promise(() => {});
      if (o.down) throw new Error("ECONNREFUSED");
      if (text.startsWith("select 1")) return { rows: [{ "?column?": 1 }] };
      if (text.includes("from runs")) {
        if (o.queuedFails) throw new Error("boom");
        return { rows: [{ n: o.queued ?? 0 }] };
      }
      if (text.includes("runner_heartbeats")) {
        if (o.missingTable) throw Object.assign(new Error('relation "runner_heartbeats" does not exist'), { code: "42P01" });
        return { rows: [{ seen_at: o.seenAt ?? null }] };
      }
      throw new Error(`unexpected query ${text}`);
    },
  };
}

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe("checkHealth", () => {
  it("DB down -> 503 with db: down", async () => {
    const r = await checkHealth({ db: () => fakePool({ down: true }), now: () => NOW });
    expect(r.httpStatus).toBe(503);
    expect(r.body).toEqual({ status: "down", db: "down", queued: null, runnerSeenAt: null });
  });

  it("a DB that does not answer within the timeout counts as down", async () => {
    const r = await checkHealth({ db: () => fakePool({ hang: true }), now: () => NOW, dbTimeoutMs: 20 });
    expect(r.httpStatus).toBe(503);
    expect(r.body.db).toBe("down");
  });

  it("a pool that throws on creation counts as down", async () => {
    const r = await checkHealth({ db: () => { throw new Error("DATABASE_URL is required"); }, now: () => NOW });
    expect(r.httpStatus).toBe(503);
  });

  it("reports queue depth and runnerSeenAt on 200", async () => {
    const r = await checkHealth({ db: () => fakePool({ queued: 7, seenAt: minutesAgo(1) }), now: () => NOW });
    expect(r.httpStatus).toBe(200);
    expect(r.body).toEqual({ status: "ok", db: "ok", queued: 7, runnerSeenAt: minutesAgo(1).toISOString() });
  });

  it("flag on + stale heartbeat (> 5 min) -> 503 runner_stale", async () => {
    const r = await checkHealth({ db: () => fakePool({ seenAt: minutesAgo(6) }), requireRunner: true, now: () => NOW });
    expect(r.httpStatus).toBe(503);
    expect(r.body).toMatchObject({ status: "runner_stale", db: "ok", runnerSeenAt: minutesAgo(6).toISOString() });
  });

  it("flag on + fresh heartbeat -> 200", async () => {
    const r = await checkHealth({ db: () => fakePool({ seenAt: minutesAgo(4) }), requireRunner: true, now: () => NOW });
    expect(r.httpStatus).toBe(200);
  });

  it("flag off + stale heartbeat -> 200 (the default never fails on the runner)", async () => {
    const r = await checkHealth({ db: () => fakePool({ seenAt: minutesAgo(60) }), now: () => NOW });
    expect(r.httpStatus).toBe(200);
    expect(r.body.runnerSeenAt).toBe(minutesAgo(60).toISOString());
  });

  it("missing heartbeat table -> runnerSeenAt null and still 200, even with the flag on", async () => {
    for (const requireRunner of [false, true]) {
      const r = await checkHealth({ db: () => fakePool({ missingTable: true, queued: 2 }), requireRunner, now: () => NOW });
      expect(r.httpStatus).toBe(200);
      expect(r.body).toEqual({ status: "ok", db: "ok", queued: 2, runnerSeenAt: null });
    }
  });

  it("a failing queue count gives queued null, not a 503", async () => {
    const r = await checkHealth({ db: () => fakePool({ queuedFails: true }), now: () => NOW });
    expect(r.httpStatus).toBe(200);
    expect(r.body.queued).toBeNull();
  });
});

describe("healthRequiresRunner", () => {
  it("is on only for the exact value true", () => {
    expect(healthRequiresRunner({})).toBe(false);
    expect(healthRequiresRunner({ TMA_HEALTH_REQUIRE_RUNNER: "1" })).toBe(false);
    expect(healthRequiresRunner({ TMA_HEALTH_REQUIRE_RUNNER: "true" })).toBe(true);
  });
});

describe("createHealthHandler (HTTP)", () => {
  let server: Server;
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function get(pool: HealthDb, extra: { requireRunner?: boolean; cacheMs?: number } = {}) {
    const app = express();
    app.get("/health", createHealthHandler({ db: () => pool, now: () => NOW, cacheMs: 0, ...extra }));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`);
    return { status: res.status, body: await res.json() };
  }

  it("answers 503 with the JSON body when the DB is down", async () => {
    const r = await get(fakePool({ down: true }));
    expect(r.status).toBe(503);
    expect(r.body.db).toBe("down");
  });

  it("answers 200 and keeps status: ok for the Docker healthcheck", async () => {
    const r = await get(fakePool({ queued: 1, seenAt: minutesAgo(1) }));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
  });

  it("shares one result between calls inside the cache window", async () => {
    const pool = fakePool();
    const app = express();
    app.get("/health", createHealthHandler({ db: () => pool, now: () => NOW, cacheMs: 60_000 }));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
    await fetch(url);
    await fetch(url);
    expect(pool.calls.filter((c) => c.startsWith("select 1"))).toHaveLength(1);
  });
});

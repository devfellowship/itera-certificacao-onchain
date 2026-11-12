/**
 * POST /eval-results/cleanup (plan 20261112-tma-c4-result-store-trajectory-upload, C4-T13): the pure plan, and the
 * route over an in-memory store that applies the same plan. The Postgres twin (locks, SQL guards, the real tables) is
 * cleanup.pg.test.ts.
 *
 * Proves: dry_run is the default and deletes nothing; only the boolean false deletes; a delete needs ids; another
 * principal's row is `not_found` and stays; a case or variant with a run is refused with its reason and stays; a
 * variant that stays as a case's baseline is refused, and one whose case goes in the same request goes too; a grader
 * version with a result or with calibration fields is refused; the listing shows only deletable rows; before 0023 the
 * route is 503; a closed body.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueSessionToken } from "../auth/session.js";
import { createEvalCleanupRouter, planCleanup, type CleanupFacts, type CleanupOutcome, type CleanupSelection, type EvalCleanupStore } from "./cleanup.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ALICE = "dfl:00000000-0000-4000-8000-00000000000a";
const BOB = "dfl:00000000-0000-4000-8000-00000000000b";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dfl = (who: string) => issueSessionToken(who, Date.now(), "dfl").token;

const C_FREE = id(1); // alice, no run, baseline variant V_BASE
const C_USED = id(2); // alice, has runs
const C_BOB = id(3); // bob, no run
const V_BASE = id(11); // alice, baseline of C_FREE, no run
const V_USED = id(12); // alice, has runs
const V_STAY = id(13); // alice, no run, baseline of C_USED (a case that stays)
const V_FREE = id(14); // alice, no run, baseline of nothing
const V_BOB = id(15); // bob
const G_FREE = id(21);
const G_USED = id(22);
const G_JUDGE = id(23);

interface Db {
  cases: Array<{ id: string; owner: string; caseKey: string; baseline: string | null; runs: number }>;
  variants: Array<{ id: string; owner: string; label: string; runs: number }>;
  graders: Array<{ id: string; graderId: string; semver: string; results: number; calibrated: boolean }>;
}

const seed = (): Db => ({
  cases: [
    { id: C_FREE, owner: ALICE, caseKey: "free-case", baseline: V_BASE, runs: 0 },
    { id: C_USED, owner: ALICE, caseKey: "used-case", baseline: V_STAY, runs: 3 },
    { id: C_BOB, owner: BOB, caseKey: "bob-case", baseline: V_BOB, runs: 0 },
  ],
  variants: [
    { id: V_BASE, owner: ALICE, label: "baseline", runs: 0 },
    { id: V_USED, owner: ALICE, label: "used", runs: 2 },
    { id: V_STAY, owner: ALICE, label: "stay", runs: 0 },
    { id: V_FREE, owner: ALICE, label: "free", runs: 0 },
    { id: V_BOB, owner: BOB, label: "bob", runs: 0 },
  ],
  graders: [
    { id: G_FREE, graderId: "t13-free", semver: "1.0.0", results: 0, calibrated: false },
    { id: G_USED, graderId: "t13-used", semver: "1.0.0", results: 4, calibrated: false },
    { id: G_JUDGE, graderId: "t13-judge", semver: "1.0.0", results: 0, calibrated: true },
  ],
});

class MemStore implements EvalCleanupStore {
  db = seed();
  calls = 0;
  async cleanup(owner: string, _tenant: string, sel: CleanupSelection, o: { dryRun: boolean }): Promise<CleanupOutcome> {
    this.calls += 1;
    const facts: CleanupFacts = {
      cases: this.db.cases.filter((c) => c.owner === owner).map((c) => ({ id: c.id, caseKey: c.caseKey, runCount: c.runs })),
      variants: this.db.variants
        .filter((v) => v.owner === owner)
        .map((v) => ({ id: v.id, label: v.label, runCount: v.runs, baselineOfCaseIds: this.db.cases.filter((c) => c.baseline === v.id).map((c) => c.id) })),
      graders: this.db.graders.map((g) => ({ id: g.id, graderId: g.graderId, semver: g.semver, resultCount: g.results, calibrated: g.calibrated })),
    };
    const plan = planCleanup(facts, sel);
    if (o.dryRun) return { plan, deleted: false };
    const gone = <T extends { id: string }>(rows: T[], ids: string[]) => rows.filter((r) => !ids.includes(r.id));
    this.db.cases = gone(this.db.cases, plan.cases.map((x) => x.id));
    this.db.variants = gone(this.db.variants, plan.variants.map((x) => x.id));
    this.db.graders = gone(this.db.graders, plan.graderVersions.map((x) => x.id));
    return { plan, deleted: plan.cases.length + plan.variants.length + plan.graderVersions.length > 0 };
  }
}

let server: Server;
let base = "";
let store: MemStore;
let ready = true;

beforeEach(async () => {
  store = new MemStore();
  ready = true;
  const app = express();
  app.use(express.json());
  app.use(createEvalCleanupRouter({ store, ready: async () => ready, tenant: "devfellowship" }));
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const post = async (body: unknown, who?: string, raw?: string) => {
  const res = await fetch(`${base}/eval-results/cleanup`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${dfl(who)}` } : {}) },
    body: raw ?? JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) as any };
  } catch {
    throw new Error(`not JSON (status ${res.status}) for ${raw ?? JSON.stringify(body)}: ${text.slice(0, 300)}`);
  }
};

describe("planCleanup", () => {
  const facts: CleanupFacts = {
    cases: [{ id: C_FREE, caseKey: "a", runCount: 0 }, { id: C_USED, caseKey: "b", runCount: 1 }],
    variants: [
      { id: V_BASE, label: "base", runCount: 0, baselineOfCaseIds: [C_FREE] },
      { id: V_STAY, label: "stay", runCount: 0, baselineOfCaseIds: [C_USED] },
    ],
    graders: [],
  };

  it("releases a baseline variant when its case goes in the same request, and keeps it when the case stays", () => {
    const both = planCleanup(facts, { caseIds: [C_FREE], variantIds: [V_BASE], graderVersionIds: null });
    expect(both.variants.map((v) => v.id)).toEqual([V_BASE]);
    const alone = planCleanup(facts, { caseIds: null, variantIds: [V_BASE], graderVersionIds: null });
    expect(alone.variants).toEqual([]);
    expect(alone.refused).toEqual([{ kind: "variant", id: V_BASE, reason: "baseline_of_case", detail: { case_ids: [C_FREE] } }]);
  });

  it("a case with runs is refused, so its baseline variant stays refused too", () => {
    const p = planCleanup(facts, { caseIds: [C_USED], variantIds: [V_STAY], graderVersionIds: null });
    expect(p.cases).toEqual([]);
    expect(p.refused.map((r) => `${r.kind}:${r.reason}`)).toEqual(["case:referenced_by_runs", "variant:baseline_of_case"]);
  });

  it("a duplicated id is planned once", () => {
    expect(planCleanup(facts, { caseIds: [C_FREE, C_FREE], variantIds: null, graderVersionIds: null }).cases).toHaveLength(1);
  });
});

describe("POST /eval-results/cleanup", () => {
  it("needs a session", async () => {
    expect((await post({}, undefined)).status).toBe(401);
    expect(store.calls).toBe(0);
  });

  it("lists the deletable rows of the caller when no id is given (dry run, nothing is deleted)", async () => {
    const r = await post({}, ALICE);
    expect(r.status).toBe(200);
    expect(r.json.dry_run).toBe(true);
    expect(r.json.deleted).toBe(false);
    expect(r.json.selected.cases.map((c: any) => c.id)).toEqual([C_FREE]);
    // V_STAY stays (the baseline of the used case); V_BASE goes with its case in the listing.
    expect(r.json.selected.variants.map((v: any) => v.id)).toEqual([V_BASE, V_FREE]);
    expect(r.json.selected.grader_versions.map((g: any) => g.id)).toEqual([G_FREE]);
    expect(r.json.refused).toEqual([]);
    expect(store.db.cases).toHaveLength(3);
  });

  it("dry_run is the default: ids with no dry_run field delete nothing", async () => {
    const r = await post({ case_ids: [C_FREE], variant_ids: [V_BASE, V_FREE], grader_version_ids: [G_FREE] }, ALICE);
    expect(r.json).toMatchObject({ dry_run: true, deleted: false });
    expect(r.json.selected.cases).toHaveLength(1);
    expect(store.db).toEqual(seed());
  });

  it("only the boolean false deletes; the string 'false', 0 and null are 400 and delete nothing", async () => {
    for (const bad of ["false", 0, null]) {
      const r = await post({ dry_run: bad, case_ids: [C_FREE] }, ALICE);
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("invalid_dry_run");
    }
    expect(store.db).toEqual(seed());
    expect(store.calls).toBe(0);
  });

  it("deletes the named rows with dry_run false, and nothing else", async () => {
    const r = await post({ dry_run: false, case_ids: [C_FREE], variant_ids: [V_BASE, V_FREE], grader_version_ids: [G_FREE] }, ALICE);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ dry_run: false, deleted: true, refused: [] });
    expect(store.db.cases.map((c) => c.id)).toEqual([C_USED, C_BOB]);
    expect(store.db.variants.map((v) => v.id)).toEqual([V_USED, V_STAY, V_BOB]);
    expect(store.db.graders.map((g) => g.id)).toEqual([G_USED, G_JUDGE]);
  });

  it("a delete needs ids: dry_run false with an empty body is 400 ids_required", async () => {
    const r = await post({ dry_run: false }, ALICE);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("ids_required");
    expect(store.db).toEqual(seed());
  });

  it("another principal's case and variant are not_found and stay (the same answer as an unknown id)", async () => {
    const r = await post({ dry_run: false, case_ids: [C_BOB, id(99)], variant_ids: [V_BOB] }, ALICE);
    expect(r.json.deleted).toBe(false);
    expect(r.json.refused).toEqual([
      { kind: "case", id: C_BOB, reason: "not_found", detail: {} },
      { kind: "case", id: id(99), reason: "not_found", detail: {} },
      { kind: "variant", id: V_BOB, reason: "not_found", detail: {} },
    ]);
    expect(store.db).toEqual(seed());
  });

  it("refuses a referenced case, variant and grader version with the reason, and deletes the free ones of the same request", async () => {
    const r = await post(
      { dry_run: false, case_ids: [C_USED, C_FREE], variant_ids: [V_USED, V_STAY, V_FREE], grader_version_ids: [G_USED, G_JUDGE, G_FREE] },
      ALICE,
    );
    expect(r.json.deleted).toBe(true);
    expect(r.json.selected.cases.map((c: any) => c.id)).toEqual([C_FREE]);
    expect(r.json.selected.variants.map((v: any) => v.id)).toEqual([V_FREE]);
    expect(r.json.selected.grader_versions.map((g: any) => g.id)).toEqual([G_FREE]);
    expect(r.json.refused).toEqual([
      { kind: "case", id: C_USED, reason: "referenced_by_runs", detail: { runs: 3 } },
      { kind: "variant", id: V_USED, reason: "referenced_by_runs", detail: { runs: 2 } },
      { kind: "variant", id: V_STAY, reason: "baseline_of_case", detail: { case_ids: [C_USED] } },
      { kind: "grader_version", id: G_USED, reason: "referenced_by_grader_results", detail: { results: 4 } },
      { kind: "grader_version", id: G_JUDGE, reason: "grader_has_calibration", detail: {} },
    ]);
    expect(store.db.cases.map((c) => c.id)).toEqual([C_USED, C_BOB]);
    expect(store.db.variants.map((v) => v.id)).toEqual([V_BASE, V_USED, V_STAY, V_BOB]);
    expect(store.db.graders.map((g) => g.id)).toEqual([G_USED, G_JUDGE]);
  });

  it("closed body: an unknown key, a bad id, a too long list and a JSON array body are 400", async () => {
    expect((await post({ owner: ALICE }, ALICE)).json).toMatchObject({ error: "unknown_key", path: "/owner" });
    expect((await post({ case_ids: ["not-a-uuid"] }, ALICE)).json.error).toBe("invalid_id");
    expect((await post({ case_ids: "x" }, ALICE)).json.error).toBe("invalid_id");
    expect((await post({ case_ids: Array.from({ length: 201 }, (_, i) => id(1000 + i)) }, ALICE)).json.error).toBe("too_many_ids");
    expect((await post(null, ALICE, "[1]")).json.error).toBe("invalid_body");
    expect(store.calls).toBe(0);
  });

  it("answers 503 schema_not_ready before 0023 and touches nothing", async () => {
    ready = false;
    expect(await post({ dry_run: false, case_ids: [C_FREE] }, ALICE)).toMatchObject({ status: 503, json: { error: "schema_not_ready" } });
    expect(store.calls).toBe(0);
  });
});

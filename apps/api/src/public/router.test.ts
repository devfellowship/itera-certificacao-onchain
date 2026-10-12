import express from "express";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digestOf } from "../domain/digest.js";
import { createPublicRouter } from "./router.js";
import type { ProfileSource, PublicProfilesStore, PublicRunRow } from "./store.js";

const manifest = (hidden: boolean[], total: number) => ({
  scenario_id: "webhook-ledger",
  patch_hash: "p",
  patch_scope: { changed_files: [], allowed: true },
  errors: [],
  score: { public_behavior: 20, hidden_behavior: 40, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5, total },
  tests: {
    public_baseline: { total: 3, passed: 2, failed: 1 },
    public_after_patch: { total: 3, passed: 3, failed: 0 },
    hidden: { total: hidden.length, passed: hidden.filter(Boolean).length, failed: hidden.filter((x) => !x).length, cases: hidden.map((passed) => ({ name: "n", passed })) },
  },
});

const run = (id: string, seq: number, status: string, score: number | null, hidden: boolean[], extra: Partial<PublicRunRow> = {}): PublicRunRow => ({
  id,
  seq,
  taskKey: `task-${seq}`,
  retryOfRunId: null,
  status,
  scoreTotal: score,
  evidenceManifest: score === null ? null : manifest(hidden, score),
  startedAt: "2026-10-12T10:00:00.000Z",
  claimedAt: "2026-10-12T10:00:00.000Z",
  completedAt: "2026-10-12T10:01:30.000Z",
  modelCostUsd: 0.1,
  ...extra,
});

function evaluationSource(): ProfileSource {
  const runs = [run("r1", 1, "pass", 100, [true, true, true]), run("r2", 2, "fail", 60, [true, false]), run("r3", 3, "timeout", null, [])];
  const tasks = [1, 2, 3].map((i) => ({ taskId: `task-${i}`, taskVersionId: `v${i}`, slug: `t${i}`, name: `Task ${i}`, packId: "", packVersion: "", isPublic: true }));
  const proofs = runs.slice(0, 2).map((r) => ({ runId: r.id, status: "confirmed" as const, manifestSha256: `h-${r.id}`, evidenceCid: `cid-${r.id}`, nftMint: `mint-${r.id}`, txSig: `sig-${r.id}`, attestationAddress: `att-${r.id}`, createdAt: "2026-10-12T10:02:00.000Z" }));
  const hash = digestOf({
    evaluation_id: "e1",
    agent: "a1",
    commit: "f4ec71e36d599a0027f87f4351eafaa9a9d6026c",
    model: "anthropic/claude-sonnet-4.6",
    tasks: tasks.map((t) => ({ task_id: t.taskId, task_version_id: t.taskVersionId, slug: t.slug })),
    runs: runs.map((r, i) => ({ run_id: r.id, manifest_sha256: proofs[i]?.manifestSha256 ?? null, outcome: ["PASS", "FAIL", "INVALID"][i], score: r.scoreTotal })),
  });
  return {
    kind: "evaluation",
    slug: "settlewise-7f3a",
    hash,
    evaluation: { id: "e1", agentVersionId: "av1", ownerWallet: "W2", modelId: "anthropic/claude-sonnet-4.6", modelRelease: null, tasks, createdAt: "2026-10-12T09:59:00.000Z", issuedAt: "2026-10-12T10:03:00.000Z", feeUsd: 0.3, feeLamports: 2_000_000, solUsdRate: 150, paymentTxSig: "pay" },
    agent: { id: "a1", name: "Settlewise", slug: "settlewise", description: "Fixes bugs.", repoFullName: "o/r", ownerWallet: "W1", commit: "f4ec71e36d599a0027f87f4351eafaa9a9d6026c" },
    owner: { wallet: "W1", displayName: "Bruno Lima", handle: null },
    evaluatorWallet: "W2",
    modelId: "anthropic/claude-sonnet-4.6",
    modelLabel: "Claude Sonnet 4.6",
    runs,
    proofs,
    taskMeta: {
      "task-1": { name: "Task 1", slug: "t1", description: "d1", tags: [{ id: "stripe-api", name: "Stripe API", kind: "tool" }], labels: ["sealed-tests"] },
      "task-2": { name: "Task 2", slug: "t2", description: "d2", tags: [{ id: "stripe-api", name: "Stripe API", kind: "tool" }, { id: "concurrency", name: "Concurrency", kind: "concept" }], labels: ["open-tests"] },
      "task-3": { name: "Task 3", slug: "t3", description: "d3", tags: [], labels: [] },
    },
  };
}

class FakeStore implements PublicProfilesStore {
  constructor(private readonly sources: ProfileSource[]) {}
  async load(key: string) {
    return this.sources.find((s) => s.slug === key || s.hash === key) ?? null;
  }
}

let base = "";
let close: () => void;
beforeAll(async () => {
  const app = express();
  app.use(createPublicRouter({ store: new FakeStore([evaluationSource()]), webBaseUrl: "https://web.test", apiBaseUrl: "https://api.test" }));
  await new Promise<void>((resolve) => {
    const srv = app.listen(0, () => {
      base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      close = () => srv.close();
      resolve();
    });
  });
});
afterAll(() => close());

describe("public evaluation profile (U14)", () => {
  it("serves the profile: ADR-5 score, 5 parts, counts, cells, labels, cost, proofs", async () => {
    const res = await fetch(`${base}/public/evaluations/settlewise-7f3a`);
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p.score).toBe(80); // mean of PASS 100 and FAIL 60; INVALID excluded
    expect(p.scoreParts).toEqual({ public_behavior: 20, hidden_behavior: 40, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5 });
    expect(p.counts).toEqual({ pass: 1, fail: 1, invalid: 1 });
    expect(p.testsPassed).toBe(4);
    expect(p.testsTotal).toBe(5);
    expect(p.tasks[1].testResults).toEqual([true, false]);
    expect(p.tasks[0].labels).toEqual(["sealed-tests"]);
    expect(p.tags.map((t: { id: string }) => t.id)).toEqual(["stripe-api", "concurrency"]);
    expect(p.selfEvaluated).toBe(false);
    expect(p.agent.authorName).toBe("Bruno Lima");
    expect(p.agent.commit).toBe("f4ec71e");
    expect(p.cost.feeSol).toBe("0.00200");
    expect(p.cost.modelCostUsd).toBeCloseTo(0.3);
    expect(p.record.status).toBe("Confirmed");
    expect(p.record.proofs[0].txUrl).toBe("https://solscan.io/tx/sig-r1?cluster=devnet");
    expect(p.url).toBe("https://web.test/e/settlewise-7f3a");
    expect(p.disclaimer).toContain("these three tasks");
  });

  it("resolves the same profile by hash", async () => {
    const src = evaluationSource();
    const res = await fetch(`${base}/public/evaluations/${src.hash}`);
    expect(res.status).toBe(200);
    expect((await res.json()).slug).toBe("settlewise-7f3a");
  });

  it("answers a generic 404 for unknown or private keys", async () => {
    for (const k of ["unknown-0000", "a".repeat(64), "bad$key"]) {
      const res = await fetch(`${base}/public/evaluations/${encodeURIComponent(k)}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    }
  });

  it("manifest.json rebuilds the ADR-6 manifest and its digest matches", async () => {
    const res = await fetch(`${base}/public/evaluations/settlewise-7f3a/manifest.json`);
    expect(res.status).toBe(200);
    const m = await res.json();
    expect(m.hashMatches).toBe(true);
    expect(m.proofs).toHaveLength(2);
  });

  it("og.png is a 1200×630 PNG", async () => {
    const res = await fetch(`${base}/public/evaluations/settlewise-7f3a/og.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(1, 4).toString()).toBe("PNG");
    expect(buf.readUInt32BE(16)).toBe(1200);
    expect(buf.readUInt32BE(20)).toBe(630);
  });
});

/** How the evaluation view reads a self-declared row (0021; task L3): graded, no payment, no proof. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateApiResponse } from "@itera/contracts";
import { rollup } from "../evaluations/rollup.js";

describe("rollup of a self-declared evaluation", () => {
  it("is graded with paymentKind none and resultOrigin self_declared, and validates as an evaluationView", () => {
    const now = Date.parse("2026-10-26T12:30:00Z");
    const id = randomUUID();
    const evaluation = {
      id, slug: `self-declared-${id.slice(0, 8)}`, shortId: id.slice(0, 8), ownerWallet: "dfl:00000000-0000-4000-8000-00000000000a", agentId: randomUUID(),
      agentVersionId: randomUUID(), modelId: "openrouter/deepseek/deepseek-v4.1-flash", modelRelease: null,
      tasks: [{ taskId: randomUUID(), taskVersionId: randomUUID() }] as any, status: "graded" as const, paymentKind: "none" as const,
      resultOrigin: "self_declared" as const, taskCount: 1, priceUsdPerRun: 0, feeUsd: 0, feeLamports: 0, solUsdRate: 0, priceSource: "none",
      paymentId: null, txSig: null, score: 90, passCount: 1, failCount: 0, invalidCount: 0, testsPassed: 0, testsTotal: 0, manifestSha256: null,
      isPublic: false, freeRetriesUsed: 0, createdAt: new Date(now).toISOString(), startedAt: "2026-10-26T12:00:00Z", completedAt: "2026-10-26T12:20:00Z",
      issuedAt: null, cancelledAt: null,
    };
    const run = {
      id, evaluationId: id, seq: 1, taskId: evaluation.tasks[0].taskId, taskVersionId: evaluation.tasks[0].taskVersionId, status: "pass" as const,
      phase: "done" as const, scoreTotal: 90, evidenceManifest: { kind: "tma-local-result/1", metrics_shape: "tma-score/1", items: [] }, runStartSig: null,
      error: null, retryOfRunId: null, startedAt: "2026-10-26T12:00:00Z", claimedAt: null, completedAt: "2026-10-26T12:20:00Z",
    };
    const out = rollup({ evaluation, runs: [run], proofs: [], agent: { name: "Local agent", slug: null, repoFullName: null }, agentCommit: null, nowMs: now });
    expect(out.columns.status).toBe("graded");
    expect(out.view).toMatchObject({ status: "graded", paymentKind: "none", resultOrigin: "self_declared", score: 90 });
    expect(validateApiResponse("evaluationView", out.view)).toMatchObject({ ok: true });
  });
});

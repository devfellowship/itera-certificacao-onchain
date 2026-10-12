import { describe, expect, it } from "vitest";
import { validateEvidenceManifest, validateEvidenceStatement } from "@itera/contracts";
import { digestOf } from "../domain/digest.js";
import { buildEvidenceDocument, EVIDENCE_PREDICATE_TYPE, IN_TOTO_STATEMENT_V1 } from "./evidence.js";
import { manifestBytes, sha256Hex } from "./ipfs.js";
import type { ProofRun } from "./proof-store.js";

// An EvalLog as the evaluator 0.3.0 + runner write it (Inspect blocks + result), trimmed.
const suite = (total: number, passed: number, file: string, label = "public case") => ({
  total, passed, failed: total - passed, state: "ok",
  cases: Array.from({ length: total }, (_, i) => ({ name: `${label} ${i}`, file, passed: i < passed })),
});
const evalLog = {
  schema_version: "0.3.0",
  evaluator_version: "0.2.0",
  scenario_id: "webhook-ledger",
  generated_at: "2026-10-12T18:00:00.000Z",
  fixture_hash: "f".repeat(64),
  patch_hash: "a".repeat(64),
  patch_scope: { changed_files: ["src/ledger.ts"], allowed: true, violations: [] },
  tests: { public_baseline: suite(3, 2, "tests/public/public.test.ts"), public_after_patch: suite(3, 3, "tests/public/public.test.ts"), hidden: suite(5, 5, "tests/hidden/hidden.test.ts", "secret case") },
  score: { public_behavior: 20, hidden_behavior: 50, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5, total: 100 },
  errors: [],
  environment_digest: "e".repeat(64),
  executor: { profile: "sandbox-container" },
  limitations: ["One grading run per agent run; no repetition and no confidence interval."],
  version: 2,
  status: "success",
  eval: { task: "itera/webhook-ledger", task_version: "1", task_digest: "c".repeat(64), scorers: ["hidden_behavior"], solver: { name: "opencode", model: "m" } },
  plan: { name: "testmyagent", steps: [{ solver: "agent", params: {} }] },
  results: { total_samples: 1, completed_samples: 1, scores: [] },
  stats: { started_at: "2026-10-12T17:59:00.000Z", completed_at: "2026-10-12T18:00:00.000Z" },
  samples: [{ id: "itera/webhook-ledger", epoch: 1, input: "d".repeat(64), target: "tests/hidden pass", scores: { hidden_behavior: { value: 50, answer: "5/5", explanation: "5 of 5 hidden tests pass" } }, metadata: {} }],
  result: { state: "completed", verdict: "pass", scored: true },
};

const run: ProofRun = {
  runId: "11111111-1111-4111-8111-111111111111",
  ownerWallet: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  runStartSig: "5sig",
  status: "pass",
  evidenceManifest: evalLog,
  scoreTotal: 100,
  benchmarkId: "webhook-ledger",
  benchmarkVersion: "1",
  agentId: "agent-1",
  agentName: "acme agent",
  agentRepo: "acme/agent",
  agentCommit: "0123456789abcdef0123456789abcdef01234567",
  modelId: "anthropic/claude-sonnet-4.5",
} as ProofRun;

describe("pinned evidence = in-toto Statement v1 (itera-evidence/v2)", () => {
  const bytes = manifestBytes(buildEvidenceDocument(run));
  const pinned = JSON.parse(new TextDecoder().decode(bytes));

  it("matches packages/contracts/schemas/evidence-statement.schema.json and carries the EvalLog", () => {
    expect(validateEvidenceStatement(pinned)).toMatchObject({ ok: true });
    expect(pinned._type).toBe(IN_TOTO_STATEMENT_V1);
    expect(pinned.predicateType).toBe(EVIDENCE_PREDICATE_TYPE);
    expect(pinned.predicate.run.run_start_sig).toBe("5sig");
    expect(validateEvidenceManifest(pinned.predicate.manifest)).toMatchObject({ ok: true });
  });

  it("binds the subject to the canonical digest of the pinned EvalLog (what verify.ts recomputes)", () => {
    expect(pinned.subject).toEqual([{ name: `testmyagent-run:${run.runId}`, digest: { sha256: digestOf(pinned.predicate.manifest) } }]);
  });

  it("keeps the proof-hash semantics: manifest_sha256 = sha256 of the exact pinned bytes, deterministic", () => {
    expect(sha256Hex(manifestBytes(buildEvidenceDocument(run)))).toBe(sha256Hex(bytes));
  });

  it("never pins hidden test names", () => {
    expect(new TextDecoder().decode(bytes)).not.toContain("secret case");
    expect(pinned.predicate.manifest.tests.hidden).toEqual({ total: 5, passed: 5, failed: 0, state: "ok" });
  });
});

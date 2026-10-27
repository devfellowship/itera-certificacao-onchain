/**
 * PgEvaluationsStore.deleteEvaluation (DELETE /evaluations/:id, plan 20261026-tma-local-runner-and-self-declared-
 * results, task L19, Q 87769da2 = C) against a real Postgres. Runs when ITERA_PG_TEST_URL points at a THROWAWAY
 * Postgres with db/migrations applied up to 0021 (the web3 e2e guard job sets it). Never point it at a real project.
 *
 * Proves, on rows that the real import path (PgSelfDeclaredStore) writes:
 * - another principal gets `not_found`, and nothing is deleted;
 * - the owner deletes the evaluation and its run in one transaction; the run's observations, run_actions and
 *   run_feedback go with it; the owner's other evaluation, the agent and its release declaration stay;
 * - a second delete answers `not_found`;
 * - a hosted evaluation (the free BYOK path) is refused as `hosted` and stays;
 * - a run with a proof is refused as `has_proofs`; a run that a claim manifest references is refused as
 *   `has_dependents` (the FK refusal rolls the transaction back: the evaluation and the run stay).
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocalResult } from "@itera/contracts";
import { encryptRunKey } from "../domain/run-key.js";
import { resetSchemaFeatures } from "../domain/schema-features.js";
import { PgSelfDeclaredStore } from "../self-declared/store.pg.js";
import { PgEvaluationsStore } from "./store.pg.js";

const URL_ = process.env.ITERA_PG_TEST_URL;
const H = (c: string) => c.repeat(64);

describe.skipIf(!URL_)("PgEvaluationsStore.deleteEvaluation on Postgres (0021 applied)", () => {
  const pool = new Pool({ connectionString: URL_, max: 4 });
  const store = new PgEvaluationsStore(pool);
  const sd = new PgSelfDeclaredStore(pool);
  const tag = `del-${randomUUID().slice(0, 8)}`;
  const ALICE = `dfl:${randomUUID()}`;
  const BOB = `dfl:${randomUUID()}`;
  const opts = { dryRun: false, perDay: 50 };
  let agentA = "";
  let versionA = "";
  let taskId = "";
  let vendorId = "";

  const body = (variant: string | null, score = 90): LocalResult =>
    ({
      format: "tma-local-result/1",
      agent_id: agentA,
      task: { catalog: { slug: tag, version: 1 } },
      metrics_shape: "tma-score/1",
      grader_version: "1.1.0",
      runner: { version: "0.1.0", execution: "tma-sandbox", profile: "opencode", sandbox_image_id: `sha256:${H("d")}` },
      executor: { model_id: "opencode-go/deepseek-v4-pro", provider: "deepseek", route: "opencode-go", harness: "opencode 1.18.31", variant, cost_source: "metered" },
      ran_from: "2026-10-26T12:00:00Z",
      ran_to: "2026-10-26T12:20:00Z",
      summary: { score, runs: 1, items: 1 },
      runs: [{
        item_sha256: H("a"), repeat: 1, status: "pass", score, wall_s: 212, cost_usd: 0.031, tokens_in: 51234, tokens_out: 3120, error_class: null,
        parts: { public_behavior: 20, hidden_behavior: 50, regression: 10, patch_integrity_and_scope: 5, reproducible_evidence: 5 },
      }],
    }) as unknown as LocalResult;

  const count = async (sql: string, params: unknown[]) => (await pool.query(`select count(*)::int as n from ${sql}`, params)).rows[0].n as number;
  const rowsOf = async (id: string) => ({
    evaluations: await count(`public.evaluations where id = $1`, [id]),
    runs: await count(`public.runs where evaluation_id = $1`, [id]),
  });

  beforeAll(async () => {
    resetSchemaFeatures();
    vendorId = (await pool.query(`insert into public.vendors (display_name) values ($1) returning id`, [tag])).rows[0].id;
    agentA = (await pool.query(
      `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, model, connector, visibility, status)
       values ($1, $2, $3, $4, 'zai/glm-5.3', 'endpoint', 'listed', 'active') returning id`,
      [vendorId, tag, `https://${tag}.example`, ALICE],
    )).rows[0].id;
    versionA = (await pool.query(`insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, '[]'::jsonb) returning id`, [agentA, "c".repeat(40)])).rows[0].id;
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'del-test')`, [tag]);
    taskId = (await pool.query(
      `insert into public.tasks (slug, kind, name, description, visibility, status) values ($1, 'itera', 'Delete test task', 'Synthetic.', 'public', 'ready') returning id`,
      [tag],
    )).rows[0].id;
    await pool.query(`insert into public.task_versions (task_id, version, source, pack_id, pack_version, runnable) values ($1, 1, 'curated', $2, '1', true)`, [taskId, tag]);
  });

  afterAll(async () => {
    const owners = [ALICE, BOB];
    await pool.query(`delete from public.claim_manifests where task_ref = $1`, [tag]);
    await pool.query(`delete from public.proofs where owner_wallet = any($1)`, [owners]);
    await pool.query(`delete from public.runs where owner_wallet = any($1)`, [owners]);
    await pool.query(`delete from public.evaluations where owner_wallet = any($1)`, [owners]);
    await pool.query(`delete from public.release_declarations where agent_id = $1`, [agentA]);
    await pool.query(`delete from public.task_versions where task_id = $1`, [taskId]);
    await pool.query(`delete from public.tasks where id = $1`, [taskId]);
    await pool.query(`delete from public.task_packs where id = $1`, [tag]);
    await pool.query(`delete from public.agent_versions where agent_id = $1`, [agentA]);
    await pool.query(`delete from public.agents where id = $1`, [agentA]);
    await pool.query(`delete from public.vendors where id = $1`, [vendorId]);
    await pool.end();
  });

  it("refuses another principal, then deletes the owner's evaluation with its run and the run's child rows", async () => {
    const target = await sd.importResult(ALICE, body(null), opts);
    const other = await sd.importResult(ALICE, body("other"), opts);
    expect(target.evaluationId).not.toBe(other.evaluationId);
    const run = target.runId;
    await pool.query(`insert into public.observations (run_id, output_artifact_ref) values ($1, 'artifact:out.txt')`, [run]);
    await pool.query(`insert into public.run_actions (run_id, seq, tool, target, ok) values ($1, 1, 'bash', 'ls', true)`, [run]);
    await pool.query(`insert into public.run_feedback (run_id, wallet, matched_reality) values ($1, $2, true)`, [run, ALICE]);

    expect(await store.deleteEvaluation({ id: target.evaluationId, ownerWallet: BOB })).toEqual({ outcome: "not_found" });
    expect(await rowsOf(target.evaluationId)).toEqual({ evaluations: 1, runs: 1 });
    expect(await count(`public.observations where run_id = $1`, [run])).toBe(1);

    expect(await store.deleteEvaluation({ id: target.evaluationId, ownerWallet: ALICE })).toEqual({
      outcome: "deleted", evaluationId: target.evaluationId, deletedRuns: 1,
    });
    expect(await rowsOf(target.evaluationId)).toEqual({ evaluations: 0, runs: 0 });
    expect(await count(`public.runs where id = $1`, [run])).toBe(0);
    expect(await count(`public.observations where run_id = $1`, [run])).toBe(0);
    expect(await count(`public.run_actions where run_id = $1`, [run])).toBe(0);
    expect(await count(`public.run_feedback where run_id = $1`, [run])).toBe(0);
    // The owner's other evaluation, the agent and its release declaration stay.
    expect(await rowsOf(other.evaluationId)).toEqual({ evaluations: 1, runs: 1 });
    expect(await count(`public.agents where id = $1`, [agentA])).toBe(1);
    expect(await count(`public.release_declarations where agent_id = $1`, [agentA])).toBe(1);

    expect(await store.deleteEvaluation({ id: target.evaluationId, ownerWallet: ALICE })).toEqual({ outcome: "not_found" });
  });

  it("refuses a hosted evaluation of the owner as `hosted` and keeps it", async () => {
    const evaluationId = randomUUID();
    const runId = randomUUID();
    await store.createFreeEvaluation({
      evaluationId, runIds: [runId], ownerWallet: ALICE, shortId: evaluationId.slice(0, 8), agentId: agentA, agentVersionId: versionA,
      agentCommit: "c".repeat(40), modelId: "qwen/qwen3-coder", modelRelease: null,
      tasks: [{ taskId: tag, taskVersionId: null, slug: tag, name: tag, packId: tag, packVersion: "1", isPublic: true }],
      isPublic: true, modelApiKeyEnc: encryptRunKey("sk-or-v1-" + "a".repeat(40), "k".repeat(48)), maxActiveRuns: 10,
    });
    expect(await store.deleteEvaluation({ id: evaluationId, ownerWallet: ALICE })).toEqual({ outcome: "not_deletable", reason: "hosted" });
    expect(await rowsOf(evaluationId)).toEqual({ evaluations: 1, runs: 1 });
  });

  it("refuses a run with a proof (`has_proofs`) and a run that a claim manifest references (`has_dependents`)", async () => {
    const withProof = await sd.importResult(ALICE, body("proof"), opts);
    await pool.query(`insert into public.proofs (run_id, owner_wallet, status) values ($1, $2, 'pending')`, [withProof.runId, ALICE]);
    expect(await store.deleteEvaluation({ id: withProof.evaluationId, ownerWallet: ALICE })).toEqual({ outcome: "not_deletable", reason: "has_proofs" });
    expect(await rowsOf(withProof.evaluationId)).toEqual({ evaluations: 1, runs: 1 });

    const withManifest = await sd.importResult(ALICE, body("manifest"), opts);
    await pool.query(`insert into public.claim_manifests (run_id, task_ref, release_ref) values ($1, $2, 'r1')`, [withManifest.runId, tag]);
    expect(await store.deleteEvaluation({ id: withManifest.evaluationId, ownerWallet: ALICE })).toEqual({ outcome: "not_deletable", reason: "has_dependents" });
    expect(await rowsOf(withManifest.evaluationId)).toEqual({ evaluations: 1, runs: 1 });
  });
});

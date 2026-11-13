/**
 * PgTrajectoriesReader (GET /trajectories, studio S9, plan 20261112-tma-c5-studio-area-web2, C5-T9) on a real Postgres.
 * Runs when ITERA_PG_TEST_URL points at a THROWAWAY Postgres with db/migrations applied up to 0024. Never point it at a
 * real project.
 * Proves the scope (a hosted run of an issued public evaluation, or the caller's own run; never another principal's
 * private hosted run or upload), the steps in seq order with step_kind and ok, a run with no steps, the filters, and
 * that a pending run is left out.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetSchemaFeatures } from "../domain/schema-features.js";
import { PgTrajectoriesReader } from "./trajectories.js";

const URL_ = process.env.ITERA_PG_TEST_URL;

describe.skipIf(!URL_)("PgTrajectoriesReader on Postgres (0024 applied)", () => {
  const pool = new Pool({ connectionString: URL_, max: 4 });
  const reader = new PgTrajectoriesReader(() => pool);
  const tag = `tj-${randomUUID().slice(0, 8)}`;
  const ALICE = `dfl:${randomUUID()}`;
  const BOB = `dfl:${randomUUID()}`;
  let agentId = "";
  let versionId = "";
  let releaseId = "";
  let vendorId = "";
  const runs: Record<string, string> = {};
  const evals: Record<string, string> = {};

  const addEval = async (key: string, status: string, isPublic: boolean) => {
    const id = randomUUID();
    await pool.query(
      `insert into public.evaluations (id, slug, short_id, owner_wallet, agent_id, agent_version_id, model_id, tasks, status, task_count, payment_kind, score, is_public)
       values ($1, $2, $3, $4, $5, $6, 'zai/glm-5.3', '[]'::jsonb, $7, 1, 'free_byok', 50, $8)`,
      [id, `${tag}-${key}`, `S${id.replaceAll("-", "").slice(0, 20)}`, BOB, agentId, versionId, status, isPublic],
    );
    evals[key] = id;
  };
  const addRun = async (key: string, o: { owner: string; origin: "hosted" | "self_declared"; evalKey?: string; status?: string; steps?: Array<[string, boolean]>; at: string }) => {
    const id = randomUUID();
    await pool.query(
      `insert into public.runs (id, release_declaration_id, task_pack_id, task_pack_version, nonce, status, agent_version_id, owner_wallet, result_origin, evaluation_id, task_id, started_at)
       values ($1, $2, $3, '1', $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, releaseId, tag, `${tag}-${key}`, o.status ?? "pass", versionId, o.owner, o.origin, o.evalKey ? evals[o.evalKey] : null, `${tag}-task`, o.at],
    );
    // Inserted in reverse to prove the seq order of the aggregate.
    const steps = o.steps ?? [];
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const [kind, ok] = steps[i]!;
      await pool.query(`insert into public.run_actions (run_id, seq, tool, ok, step_kind) values ($1, $2, 'x', $3, $4)`, [id, i + 1, ok, kind]);
    }
    runs[key] = id;
  };

  beforeAll(async () => {
    resetSchemaFeatures();
    vendorId = (await pool.query(`insert into public.vendors (display_name) values ($1) returning id`, [tag])).rows[0].id;
    agentId = (await pool.query(
      `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, model, connector, visibility, status)
       values ($1, $2, $3, $4, 'zai/glm-5.3', 'endpoint', 'private', 'active') returning id`,
      [vendorId, `tj ${tag}`, `bench://${tag}`, BOB],
    )).rows[0].id;
    versionId = (await pool.query(`insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, '[]'::jsonb) returning id`, [agentId, `prompt-${"e".repeat(33)}`])).rows[0].id;
    releaseId = (await pool.query(`insert into public.release_declarations (agent_id, release_ref) values ($1, 'r1') returning id`, [agentId])).rows[0].id;
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'tj-test')`, [tag]);
    await addEval("pub", "issued", true);
    await addEval("priv", "review", false);
    await addRun("public", { owner: BOB, origin: "hosted", evalKey: "pub", at: "2026-11-12T12:03:00Z", steps: [["read", true], ["write", true], ["test", false], ["test", true]] });
    await addRun("bobPrivate", { owner: BOB, origin: "hosted", evalKey: "priv", at: "2026-11-12T12:02:00Z", steps: [["read", true]] });
    await addRun("bobUpload", { owner: BOB, origin: "self_declared", at: "2026-11-12T12:01:00Z", steps: [["search", true]] });
    await addRun("aliceUpload", { owner: ALICE, origin: "self_declared", status: "fail", at: "2026-11-12T12:00:00Z" });
    await addRun("pending", { owner: ALICE, origin: "self_declared", status: "pending", at: "2026-11-12T12:04:00Z" });
  });

  afterAll(async () => {
    await pool.query(`delete from public.runs where task_pack_id = $1`, [tag]);
    await pool.query(`delete from public.evaluations where agent_id = $1`, [agentId]);
    await pool.query(`delete from public.task_packs where id = $1`, [tag]);
    await pool.query(`delete from public.release_declarations where agent_id = $1`, [agentId]);
    await pool.query(`delete from public.agent_versions where agent_id = $1`, [agentId]);
    await pool.query(`delete from public.agents where id = $1`, [agentId]);
    await pool.query(`delete from public.vendors where id = $1`, [vendorId]);
    await pool.end();
  });

  it("is ready once 0024 is applied", async () => {
    expect(await reader.ready()).toBe(true);
  });

  it("alice sees the public hosted run and her own upload, newest first; never bob's private run or upload; no pending run", async () => {
    const list = await reader.list(ALICE, { task: `${tag}-task` }, 100);
    expect(list.map((r) => r.id)).toEqual([runs.public, runs.aliceUpload]);
    expect(list[0]).toEqual({
      id: runs.public, evaluationId: evals.pub, agentId, status: "pass", resultOrigin: "hosted",
      stepKinds: ["read", "write", "test", "test"], oks: [true, true, false, true],
    });
    expect(list[1]).toMatchObject({ resultOrigin: "self_declared", status: "fail", stepKinds: [], oks: [], agentId: null });
  });

  it("bob sees his own private hosted run and upload", async () => {
    const list = await reader.list(BOB, { task: `${tag}-task` }, 100);
    expect(list.map((r) => r.id)).toEqual([runs.public, runs.bobPrivate, runs.bobUpload]);
  });

  it("applies the agent, origin and limit filters", async () => {
    expect((await reader.list(BOB, { agentId }, 100)).map((r) => r.id)).toEqual([runs.public, runs.bobPrivate]);
    expect((await reader.list(BOB, { task: `${tag}-task`, origin: "self_declared" }, 100)).map((r) => r.id)).toEqual([runs.bobUpload]);
    expect((await reader.list(BOB, { task: `${tag}-task` }, 1)).map((r) => r.id)).toEqual([runs.public]);
  });
});

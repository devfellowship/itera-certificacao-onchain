/**
 * PgRecomputeStore (POST /eval-results/recompute, plan 20261112-tma-c4-result-store-trajectory-upload, C4-T10) against a
 * real Postgres. Runs when ITERA_PG_TEST_URL points at a THROWAWAY Postgres with db/migrations applied up to 0024 (the
 * web3 e2e guard job sets it). Never point it at a real project.
 *
 * The rows are what the hosted runner wrote before 0024: run_actions with a tool and a target and no step_kind.
 * Proves: a dry run reads and counts and writes nothing; scope mine fills only the caller's hosted rows; another
 * owner's rows, a self-declared run's rows, and a value that is already set are not changed; a second call changes 0
 * rows; the limit caps one call and `remaining` counts the rest; scope all (owner null) also fills a run with no owner.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgRecomputeStore } from "./recompute.pg.js";

const URL_ = process.env.ITERA_PG_TEST_URL;

describe.skipIf(!URL_)("PgRecomputeStore on Postgres (0024 applied)", () => {
  const pool = new Pool({ connectionString: URL_, max: 4 });
  const store = new PgRecomputeStore(pool);
  const tag = `rc-${randomUUID().slice(0, 8)}`;
  const ALICE = `dfl:${randomUUID()}`;
  const BOB = `dfl:${randomUUID()}`;
  let agentId = "";
  let versionId = "";
  let releaseId = "";
  let vendorId = "";
  const runs: Record<string, string> = {};

  /** The rows of a hosted run before 0024: tool + target, no step_kind. */
  const STEPS: Array<[string, string | null]> = [
    ["read", "src/webhook/handler.ts"],
    ["bash", "cd app && npm test -- --run"],
    ["bash", "git commit -m fix"],
    ["repos_read_file_lines", "devfellowship/dfl-infra"],
    ["todowrite", null],
  ];

  const addRun = async (key: string, owner: string | null, origin: "hosted" | "self_declared" = "hosted") => {
    const id = randomUUID();
    await pool.query(
      `insert into public.runs (id, release_declaration_id, task_pack_id, task_pack_version, nonce, status, agent_version_id, owner_wallet, result_origin)
       values ($1, $2, $3, '1', $4, 'pass', $5, $6, $7)`,
      [id, releaseId, tag, `${tag}-${key}`, versionId, owner, origin],
    );
    for (const [i, [tool, target]] of STEPS.entries()) {
      await pool.query(`insert into public.run_actions (run_id, seq, tool, target, ok) values ($1, $2, $3, $4, true)`, [id, i + 1, tool, target]);
    }
    runs[key] = id;
  };
  const kinds = async (key: string) =>
    (await pool.query(`select step_kind from public.run_actions where run_id = $1 order by seq`, [runs[key]])).rows.map((r) => r.step_kind);

  beforeAll(async () => {
    vendorId = (await pool.query(`insert into public.vendors (display_name) values ($1) returning id`, [tag])).rows[0].id;
    agentId = (await pool.query(
      `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, model, connector, visibility, status)
       values ($1, $2, $3, $4, 'zai/glm-5.3', 'endpoint', 'private', 'active') returning id`,
      [vendorId, `rc ${tag}`, `bench://${tag}`, ALICE],
    )).rows[0].id;
    versionId = (await pool.query(`insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, '[]'::jsonb) returning id`, [agentId, `prompt-${"e".repeat(33)}`])).rows[0].id;
    releaseId = (await pool.query(`insert into public.release_declarations (agent_id, release_ref) values ($1, 'r1') returning id`, [agentId])).rows[0].id;
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'rc-test')`, [tag]);
    await addRun("a1", ALICE);
    await addRun("a2", ALICE);
    await addRun("aSelf", ALICE, "self_declared");
    await addRun("b1", BOB);
    await addRun("none", null);
    // A value that is already set must stay.
    await pool.query(`update public.run_actions set step_kind = 'agent' where run_id = $1 and seq = 1`, [runs.a2]);
  });

  afterAll(async () => {
    await pool.query(`delete from public.runs where task_pack_id = $1`, [tag]);
    await pool.query(`delete from public.task_packs where id = $1`, [tag]);
    await pool.query(`delete from public.release_declarations where agent_id = $1`, [agentId]);
    await pool.query(`delete from public.agent_versions where agent_id = $1`, [agentId]);
    await pool.query(`delete from public.agents where id = $1`, [agentId]);
    await pool.query(`delete from public.vendors where id = $1`, [vendorId]);
    await pool.end();
  });

  const EXPECTED = ["read", "test", "write", "mcp", "other"];

  it("a dry run counts the caller's NULL hosted rows and writes nothing", async () => {
    const r = await store.recomputeStepKinds(ALICE, { dryRun: true, limit: 5000 });
    expect(r).toEqual({ scanned: 9, updated: 0, remaining: 9, byKind: { read: 1, test: 2, write: 2, mcp: 2, other: 2 } });
    expect(await kinds("a1")).toEqual([null, null, null, null, null]);
    expect(await kinds("a2")).toEqual(["agent", null, null, null, null]);
  });

  it("the limit caps one call; remaining counts the rest", async () => {
    const r = await store.recomputeStepKinds(ALICE, { dryRun: false, limit: 4 });
    expect(r).toMatchObject({ scanned: 4, updated: 4, remaining: 5 });
  });

  it("scope mine fills only the caller's hosted rows, keeps a set value, and a second call changes 0 rows", async () => {
    const r = await store.recomputeStepKinds(ALICE, { dryRun: false, limit: 5000 });
    expect(r).toMatchObject({ scanned: 5, updated: 5, remaining: 0 });
    expect(await kinds("a1")).toEqual(EXPECTED);
    expect(await kinds("a2")).toEqual(["agent", ...EXPECTED.slice(1)]);
    expect(await kinds("aSelf")).toEqual([null, null, null, null, null]);
    expect(await kinds("b1")).toEqual([null, null, null, null, null]);
    expect(await kinds("none")).toEqual([null, null, null, null, null]);
    expect(await store.recomputeStepKinds(ALICE, { dryRun: false, limit: 5000 })).toEqual({ scanned: 0, updated: 0, remaining: 0, byKind: {} });
  });

  it("scope all (owner null) fills another owner's and an ownerless hosted run, never a self-declared one", async () => {
    const r = await store.recomputeStepKinds(null, { dryRun: false, limit: 20000 });
    expect(r.remaining).toBe(0);
    expect(r.updated).toBeGreaterThanOrEqual(10);
    expect(await kinds("b1")).toEqual(EXPECTED);
    expect(await kinds("none")).toEqual(EXPECTED);
    expect(await kinds("aSelf")).toEqual([null, null, null, null, null]);
    expect(await kinds("a2")).toEqual(["agent", ...EXPECTED.slice(1)]);
  });
});

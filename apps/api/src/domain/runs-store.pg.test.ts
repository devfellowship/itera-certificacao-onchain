/**
 * PgRunsStore reads of the observations table against a real Postgres (plan TMA L17, task L17a). Runs when
 * ITERA_PG_TEST_URL points at a THROWAWAY Postgres with db/migrations applied (the web3 e2e guard job
 * sets it). Never point it at a real project.
 *
 * Proves: getPatch returns the patch row and never an `artifact:` row, even when the artifact rows are
 * newer; listArtifacts lists one entry per path with the raw byte count (decoded for base64) and the
 * stored digest; getArtifact matches the exact path and answers null otherwise.
 */
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgRunsStore, storedBytes } from "./runs-store.pg.js";

const URL_ = process.env.ITERA_PG_TEST_URL;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PATCH = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
const RESULT = '{"format":"tma-run-result/1","status":"pass"}\n';

describe("storedBytes", () => {
  it("is the stored length for text and the decoded length for base64", () => {
    expect(storedBytes("result.json", 46, "}\n")).toBe(46);
    const b64 = PNG.toString("base64");
    expect(storedBytes("files/out/chart.png", b64.length, b64.slice(-2))).toBe(PNG.length);
    for (const n of [1, 2, 3, 4, 5, 100]) {
      const s = Buffer.alloc(n, 7).toString("base64");
      expect(storedBytes("x.png", s.length, s.slice(-2)), String(n)).toBe(n);
    }
  });
});

describe.skipIf(!URL_)("PgRunsStore artifacts on Postgres", () => {
  const pool = new Pool({ connectionString: URL_, max: 2 });
  const store = new PgRunsStore(pool);
  const tag = `l17a-${randomUUID().slice(0, 8)}`;
  const OWNER = `wallet-${tag}`;
  let vendorId = "";
  let agentId = "";
  let runId = "";
  let emptyRunId = "";

  beforeAll(async () => {
    vendorId = (await pool.query(`insert into public.vendors (display_name) values ($1) returning id`, [tag])).rows[0].id;
    agentId = (
      await pool.query(
        `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, model, connector, visibility, status)
         values ($1, $2, $3, $4, 'zai/glm-5.3', 'endpoint', 'listed', 'active') returning id`,
        [vendorId, tag, `https://${tag}.example`, OWNER],
      )
    ).rows[0].id;
    const avId = (await pool.query(`insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, '[]'::jsonb) returning id`, [agentId, "c".repeat(40)])).rows[0].id;
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'l17a-test')`, [tag]);
    const rdId = (await pool.query(`insert into public.release_declarations (agent_id, release_ref) values ($1, 'r1') returning id`, [agentId])).rows[0].id;
    const insertRun = async (nonce: string) => {
      const id = randomUUID();
      await pool.query(
        `insert into public.runs (id, release_declaration_id, task_pack_id, task_pack_version, nonce, status, evidence_manifest, score_total, agent_version_id, owner_wallet, completed_at)
         values ($1, $2, $3, '1', $4, 'pass', '{}'::jsonb, 100, $5, $6, now())`,
        [id, rdId, tag, nonce, avId, OWNER],
      );
      return id;
    };
    runId = await insertRun(`${tag}-1`);
    emptyRunId = await insertRun(`${tag}-2`);
    // The patch row FIRST, then the artifact rows (newer), the way jobs.pg.ts finish() writes them.
    await pool.query(`insert into public.observations (run_id, output_artifact_ref, output_artifact_content, mode) values ($1, 'patch.diff', $2, 'observed')`, [runId, PATCH]);
    await pool.query(
      `insert into public.observations (run_id, output_artifact_ref, output_artifact_content, response_digest, mode)
       select $1, a.ref, a.content, a.digest, 'observed' from unnest($2::text[], $3::text[], $4::text[]) as a(ref, content, digest)`,
      [runId, ["artifact:result.json", "artifact:files/out/chart.png"], [RESULT, PNG.toString("base64")], [sha(RESULT), sha(PNG)]],
    );
  });

  afterAll(async () => {
    await pool.query(`delete from public.runs where owner_wallet = $1`, [OWNER]);
    await pool.query(`delete from public.release_declarations where agent_id = $1`, [agentId]);
    await pool.query(`delete from public.agent_versions where agent_id = $1`, [agentId]);
    await pool.query(`delete from public.agents where id = $1`, [agentId]);
    await pool.query(`delete from public.vendors where id = $1`, [vendorId]);
    await pool.query(`delete from public.task_packs where id = $1`, [tag]);
    await pool.end();
  });

  it("getPatch returns the patch row and never an artifact row", async () => {
    expect(await store.getPatch(runId)).toBe(PATCH);
    expect(await store.getPatch(emptyRunId)).toBeNull();
    // A run with ONLY artifact rows has no patch.
    await pool.query(`insert into public.observations (run_id, output_artifact_ref, output_artifact_content, response_digest, mode) values ($1, 'artifact:result.json', $2, $3, 'observed')`, [emptyRunId, RESULT, sha(RESULT)]);
    expect(await store.getPatch(emptyRunId)).toBeNull();
  });

  it("listArtifacts lists one entry per path with raw bytes and the digest, in path order", async () => {
    expect(await store.listArtifacts(runId)).toEqual([
      { path: "files/out/chart.png", bytes: PNG.length, sha256: sha(PNG) },
      { path: "result.json", bytes: Buffer.byteLength(RESULT), sha256: sha(RESULT) },
    ]);
    expect(await store.listArtifacts(randomUUID())).toEqual([]);
  });

  it("getArtifact matches the exact path", async () => {
    expect(await store.getArtifact(runId, "files/out/chart.png")).toEqual({ path: "files/out/chart.png", content: PNG.toString("base64"), encoding: "base64", sha256: sha(PNG) });
    expect(await store.getArtifact(runId, "result.json")).toEqual({ path: "result.json", content: RESULT, encoding: "utf-8", sha256: sha(RESULT) });
    expect(await store.getArtifact(runId, "files/out/chart")).toBeNull();
    expect(await store.getArtifact(runId, "patch.diff")).toBeNull();
    expect(await store.getArtifact(randomUUID(), "result.json")).toBeNull();
  });

  it("the observations rows cascade with the run", async () => {
    const id = randomUUID();
    const rd = (await pool.query(`select release_declaration_id from public.runs where id = $1`, [runId])).rows[0].release_declaration_id;
    await pool.query(`insert into public.runs (id, release_declaration_id, task_pack_id, task_pack_version, nonce, status, owner_wallet) values ($1, $2, $3, '1', $4, 'pass', $5)`, [id, rd, tag, `${tag}-3`, OWNER]);
    await pool.query(`insert into public.observations (run_id, output_artifact_ref, output_artifact_content, response_digest, mode) values ($1, 'artifact:result.json', $2, $3, 'observed')`, [id, RESULT, sha(RESULT)]);
    await pool.query(`delete from public.runs where id = $1`, [id]);
    expect((await pool.query(`select count(*)::int as n from public.observations where run_id = $1`, [id])).rows[0].n).toBe(0);
  });
});

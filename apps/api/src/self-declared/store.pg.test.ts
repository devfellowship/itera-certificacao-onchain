/**
 * PgSelfDeclaredStore and the owner-only reads (plan 20261026-tma-local-runner-and-self-declared-results,
 * task L3, Q4 = C) against a real Postgres. Runs when ITERA_PG_TEST_URL points at a THROWAWAY Postgres with
 * db/migrations applied up to 0021 (the web3 e2e guard job sets it). Never point it at a real project.
 *
 * Proves: the same body twice → inserted, then unchanged (one row); new numbers → updated, same ids; the
 * row is graded, payment-free, private and self-declared, with no proof; dry_run writes nothing; a local
 * task is created private; the daily cap counts only new rows; and the public reads — catalog
 * agents_run_count, task reputation, agent ranking, the agent profile — keep only the hosted control row.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocalResult } from "@itera/contracts";
import { PgRankingStore } from "../domain/agent-ranking-store.pg.js";
import { PgProfileStore } from "../domain/agent-profile-store.pg.js";
import { publicEvaluations } from "../domain/agent-profile.js";
import { PgCatalogStore } from "../domain/catalog-store.pg.js";
import { PgReputationStore } from "../domain/reputation-store.pg.js";
import { hasSelfDeclaredSchema, resetSchemaFeatures } from "../domain/schema-features.js";
import { PgRunOriginLookup } from "./run-guard.js";
import { PgSelfDeclaredStore } from "./store.pg.js";
import { SelfDeclaredError } from "./store.js";

const URL_ = process.env.ITERA_PG_TEST_URL;
const H = (c: string) => c.repeat(64);

describe.skipIf(!URL_)("PgSelfDeclaredStore on Postgres (0021 applied)", () => {
  const pool = new Pool({ connectionString: URL_, max: 4 });
  const store = new PgSelfDeclaredStore(pool);
  const tag = `sd-${randomUUID().slice(0, 8)}`;
  const ALICE = `dfl:${randomUUID()}`;
  const BOB = `dfl:${randomUUID()}`;
  const opts = { dryRun: false, perDay: 50 };
  let agentA = "";
  let agentB = "";
  let taskId = "";
  let hostedRunId = "";
  const vendorIds: string[] = [];

  const body = (over: Partial<LocalResult> = {}, score = 90): LocalResult =>
    ({
      format: "tma-local-result/1",
      agent_id: agentA,
      task: { catalog: { slug: tag, version: 1 } },
      metrics_shape: "tma-score/1",
      grader_version: "1.1.0",
      runner: { version: "0.1.0", execution: "tma-sandbox", profile: "opencode", sandbox_image_id: `sha256:${H("d")}` },
      executor: { model_id: "opencode-go/deepseek-v4-pro", provider: "deepseek", route: "opencode-go", harness: "opencode 1.18.31", variant: null, cost_source: "metered" },
      ran_from: "2026-10-26T12:00:00Z",
      ran_to: "2026-10-26T12:20:00Z",
      summary: { score, runs: 1, items: 1 },
      runs: [{
        item_sha256: H("a"), repeat: 1, status: "pass", score, wall_s: 212, cost_usd: 0.031, tokens_in: 51234, tokens_out: 3120, error_class: null,
        parts: { public_behavior: 20, hidden_behavior: 50, regression: 10, patch_integrity_and_scope: 5, reproducible_evidence: 5 },
      }],
      ...over,
    }) as unknown as LocalResult;

  async function agentOf(owner: string, name: string) {
    const vendor = (await pool.query(`insert into public.vendors (display_name) values ($1) returning id`, [`${tag} ${name}`])).rows[0].id;
    vendorIds.push(vendor);
    const id = (await pool.query(
      `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, model, connector, visibility, status)
       values ($1, $2, $3, $4, 'zai/glm-5.3', 'endpoint', 'listed', 'active') returning id`,
      [vendor, `${tag} ${name}`, `https://${tag}-${name}.example`, owner],
    )).rows[0].id as string;
    await pool.query(`insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, '[]'::jsonb)`, [id, "c".repeat(40)]);
    return id;
  }

  beforeAll(async () => {
    resetSchemaFeatures();
    agentA = await agentOf(ALICE, "a");
    agentB = await agentOf(BOB, "b");
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'sd-test')`, [tag]);
    taskId = (await pool.query(
      `insert into public.tasks (slug, kind, name, description, visibility, status) values ($1, 'itera', 'SD test task', 'Synthetic.', 'public', 'ready') returning id`,
      [tag],
    )).rows[0].id;
    const tv = (await pool.query(
      `insert into public.task_versions (task_id, version, source, pack_id, pack_version, runnable) values ($1, 1, 'curated', $2, '1', true) returning id`,
      [taskId, tag],
    )).rows[0].id;
    // The CONTROL: one hosted, finished run of Bob's agent on the same task, so every read below has data.
    const avB = (await pool.query(`select id from public.agent_versions where agent_id = $1`, [agentB])).rows[0].id;
    const rdB = (await pool.query(`insert into public.release_declarations (agent_id, release_ref) values ($1, 'r1') returning id`, [agentB])).rows[0].id;
    hostedRunId = randomUUID();
    await pool.query(
      `insert into public.runs (id, release_declaration_id, task_pack_id, task_pack_version, nonce, status, evidence_manifest, score_total,
         agent_version_id, owner_wallet, task_id, task_version_id, completed_at)
       values ($1, $2, $3, '1', $4, 'pass', '{}'::jsonb, 80, $5, $6, $7, $8, now())`,
      [hostedRunId, rdB, tag, `${tag}-hosted`, avB, BOB, taskId, tv],
    );
  });

  afterAll(async () => {
    const owners = [ALICE, BOB];
    await pool.query(`delete from public.runs where owner_wallet = any($1)`, [owners]);
    await pool.query(`delete from public.evaluations where owner_wallet = any($1)`, [owners]);
    await pool.query(`delete from public.release_declarations where agent_id = any($1::uuid[])`, [[agentA, agentB].filter(Boolean)]);
    const own = (await pool.query(`select id from public.tasks where id = $1 or owner_wallet = any($2)`, [taskId, owners])).rows.map((r) => r.id);
    const tvs = (await pool.query(`select id from public.task_versions where task_id = any($1::uuid[])`, [own])).rows.map((r) => `self-declared-${r.id}`);
    await pool.query(`delete from public.task_versions where task_id = any($1::uuid[])`, [own]);
    await pool.query(`delete from public.tasks where id = any($1::uuid[])`, [own]);
    await pool.query(`delete from public.task_packs where id = any($1)`, [[tag, ...tvs]]);
    await pool.query(`delete from public.agent_versions where agent_id = any($1::uuid[])`, [[agentA, agentB].filter(Boolean)]);
    await pool.query(`delete from public.agents where id = any($1::uuid[])`, [[agentA, agentB].filter(Boolean)]);
    await pool.query(`delete from public.vendors where id = any($1::uuid[])`, [vendorIds]);
    await pool.end();
  });

  const row = async (id: string) =>
    (await pool.query(
      `select e.status, e.payment_kind, e.payment_id, e.is_public, e.result_origin as eval_origin, e.score::float8 as score,
              r.status as run_status, r.result_origin as run_origin, r.evaluation_id, r.owner_wallet, r.provenance ->> 'source' as source,
              (select count(*)::int from public.proofs p where p.run_id = r.id) as proofs
         from public.evaluations e join public.runs r on r.id = e.id where e.id = $1`,
      [id],
    )).rows[0];

  it("sees the 0021 schema", async () => {
    expect(await hasSelfDeclaredSchema(pool)).toBe(true);
  });

  it("inserts, answers unchanged for the same body, and updates the same ids for new numbers", async () => {
    const a = await store.importResult(ALICE, body(), opts);
    expect(a).toMatchObject({ action: "inserted", outcome: "pass" });
    expect(a.runId).toBe(a.evaluationId);
    const b = await store.importResult(ALICE, body(), opts);
    expect(b).toMatchObject({ action: "unchanged", evaluationId: a.evaluationId });
    expect((await pool.query(`select count(*)::int as n from public.evaluations where owner_wallet = $1`, [ALICE])).rows[0].n).toBe(1);
    const c = await store.importResult(ALICE, body({}, 70), opts);
    expect(c).toMatchObject({ action: "updated", evaluationId: a.evaluationId });
    expect(await row(a.evaluationId)).toMatchObject({
      status: "graded", payment_kind: "none", payment_id: null, is_public: false, eval_origin: "self_declared", score: 70,
      run_status: "pass", run_origin: "self_declared", evaluation_id: a.evaluationId, owner_wallet: ALICE, source: "self-declared", proofs: 0,
    });
    expect(await new PgRunOriginLookup(() => pool).originOf(a.runId)).toEqual({ ownerWallet: ALICE, resultOrigin: "self_declared" });
    expect(await new PgRunOriginLookup(() => pool).originOf(hostedRunId)).toEqual({ ownerWallet: BOB, resultOrigin: "hosted" });
  });

  it("writes nothing on a dry run", async () => {
    const before = (await pool.query(`select count(*)::int as n from public.evaluations where owner_wallet = $1`, [ALICE])).rows[0].n;
    const d = await store.importResult(ALICE, body({ executor: { ...body().executor, model_id: "opencode-go/kimi-k3" } }), { ...opts, dryRun: true });
    expect(d).toMatchObject({ action: "inserted", dryRun: true });
    expect((await pool.query(`select count(*)::int as n from public.evaluations where owner_wallet = $1`, [ALICE])).rows[0].n).toBe(before);
    expect((await pool.query(`select 1 from public.runs where id = $1`, [d.runId])).rowCount).toBe(0);
  });

  it("creates a local task as a private user task with a local version, and refuses another user's slug", async () => {
    const local = { local: { slug: `${tag}-local`, name: "My private task", contract_sha256: H("1"), environment_sha256: H("2"), hidden_tests_sha256: H("3") } };
    const o = await store.importResult(ALICE, body({ task: local as any }), opts);
    const t = (await pool.query(
      `select t.kind, t.visibility, t.owner_wallet, v.source, v.runnable from public.tasks t join public.task_versions v on v.task_id = t.id where t.id = $1`,
      [o.taskId],
    )).rows;
    expect(t).toEqual([{ kind: "user", visibility: "private", owner_wallet: ALICE, source: "local", runnable: false }]);
    // The same digests → the same version; Bob cannot write into Alice's slug.
    expect((await store.importResult(ALICE, body({ task: local as any }, 50), opts)).taskVersionId).toBe(o.taskVersionId);
    await expect(store.importResult(BOB, body({ agent_id: agentB, task: local as any }), opts)).rejects.toMatchObject({ status: 409, code: "task_slug_taken" });
  });

  it("refuses another user's agent and an unknown model", async () => {
    await expect(store.importResult(BOB, body(), opts)).rejects.toMatchObject({ status: 404, code: "agent_not_found" });
    const unknown = body({ executor: { ...body().executor, model_id: "openrouter/acme/mystery-7b", route: "openrouter" } });
    await expect(store.importResult(ALICE, unknown, opts)).rejects.toBeInstanceOf(SelfDeclaredError);
    await expect(store.importResult(ALICE, unknown, opts)).rejects.toMatchObject({ status: 400, code: "unknown_model" });
  });

  it("counts only NEW rows against the daily cap", async () => {
    const n = (await pool.query(`select count(*)::int as n from public.evaluations where owner_wallet = $1`, [ALICE])).rows[0].n as number;
    await expect(store.importResult(ALICE, body({ executor: { ...body().executor, model_id: "opencode-go/glm-5.3" } }), { ...opts, perDay: n }))
      .rejects.toMatchObject({ status: 429, code: "self_declared_quota" });
    expect((await store.importResult(ALICE, body({}, 60), { ...opts, perDay: n })).action).toBe("updated");
  });

  describe("owner-only reads (plan Q4 = C)", () => {
    it("keeps self-declared rows out of the catalog agents_run_count", async () => {
      for (const caller of [BOB, ALICE, null]) {
        const t = (await new PgCatalogStore(pool).listVisibleTasks(caller)).find((x) => x.id === taskId);
        expect(t?.agentsRunCount).toBe(1); // Bob's hosted agent only, not Alice's self-declared one.
      }
    });

    it("keeps self-declared rows out of the task reputation", async () => {
      const rep = (await new PgReputationStore(() => pool).reputationInputs([taskId])).get(taskId);
      expect(rep).toMatchObject({ runs: 1, distinctWallets: 1 });
    });

    it("keeps self-declared rows out of the agent ranking, for another user and for the owner", async () => {
      const ranking = new PgRankingStore(() => pool);
      const asBob = JSON.stringify(await ranking.load(BOB));
      expect(asBob).toContain(hostedRunId); // control: Bob sees his own hosted run
      const selfDeclared = (await pool.query(`select id from public.runs where owner_wallet = $1 and result_origin = 'self_declared'`, [ALICE])).rows.map((r) => r.id as string);
      expect(selfDeclared.length).toBeGreaterThan(0);
      const asAlice = JSON.stringify(await ranking.load(ALICE));
      for (const id of selfDeclared) {
        expect(asBob).not.toContain(id);
        expect(asAlice).not.toContain(id);
      }
    });

    it("keeps self-declared rows out of the public agent profile, and leaves them in the owner's history", async () => {
      const data = await new PgProfileStore(() => pool).load(agentA);
      const selfDeclared = (await pool.query(`select id from public.runs where owner_wallet = $1 and result_origin = 'self_declared'`, [ALICE])).rows.map((r) => r.id as string);
      expect(data.results.map((r) => r.runId).filter((id) => selfDeclared.includes(id))).toEqual([]);
      expect(publicEvaluations(data)).toEqual([]);
      // Control: the rows exist for the owner's own history (agent-profile.ts shows it only when isMine).
      expect(data.evaluations.map((e) => e.id).sort()).toEqual([...selfDeclared].sort());
      expect(data.evaluations.every((e) => e.ownerWallet === ALICE && !e.isPublic && e.status === "graded")).toBe(true);
    });
  });
});

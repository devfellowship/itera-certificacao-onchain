/**
 * PgLocalAgentsStore (task L4) against a real Postgres. Runs when ITERA_PG_TEST_URL points at a THROWAWAY
 * Postgres with db/migrations applied up to 0021 (the web3 e2e guard job sets it). Never a real project.
 *
 * Proves: a custom model stays in its tenant and never enters public.models (GET /models has the same
 * count); the duplicate, cap and model_in_use rules; a local agent is connector 'local' with no repo, the
 * declared provider and route, and one empty version; the agent name rule; the evaluations store sees
 * the connector (so POST /evaluations answers 409 agent_is_local); and a local agent takes a
 * self-declared result (L3).
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocalResult } from "@itera/contracts";
import { PgCatalogStore } from "../domain/catalog-store.pg.js";
import { PgEvaluationsStore } from "../evaluations/store.pg.js";
import { PgSelfDeclaredStore } from "../self-declared/store.pg.js";
import { PgLocalAgentsStore } from "./store.pg.js";
import { localCommitSha } from "./store.js";

const URL_ = process.env.ITERA_PG_TEST_URL;
const H = (c: string) => c.repeat(64);

describe.skipIf(!URL_)("PgLocalAgentsStore on Postgres (0021 applied)", () => {
  const pool = new Pool({ connectionString: URL_, max: 4 });
  const store = new PgLocalAgentsStore(() => pool);
  const tag = randomUUID().slice(0, 8);
  const ALICE = `dfl:${randomUUID()}`;
  const BOB = `dfl:${randomUUID()}`;
  const owners = [ALICE, BOB];
  const model = (id: string) => ({ id, label: `Custom ${tag}`, providerKey: null, providerLabel: "Acme Labs", routeKey: "ollama" });
  const agentInput = (over: Record<string, unknown> = {}) => ({
    name: `Local ${tag}`, description: null, model: "opencode-go/kimi-k3", providerKey: "kimi", routeKey: "opencode-go", harness: "opencode 1.18.31",
    visibility: "private" as const, requires: [], ...over,
  });

  beforeAll(async () => {
    expect(await store.schemaReady()).toBe(true);
  });

  afterAll(async () => {
    const agents = (await pool.query(`select id from public.agents where owner_wallet = any($1)`, [owners])).rows.map((r) => r.id);
    await pool.query(`delete from public.runs where owner_wallet = any($1)`, [owners]);
    await pool.query(`delete from public.evaluations where owner_wallet = any($1)`, [owners]);
    await pool.query(`delete from public.release_declarations where agent_id = any($1::uuid[])`, [agents]);
    const tasks = (await pool.query(`select id from public.task_versions where task_id in (select id from public.tasks where owner_wallet = any($1))`, [owners])).rows.map((r) => `self-declared-${r.id}`);
    await pool.query(`delete from public.task_versions where task_id in (select id from public.tasks where owner_wallet = any($1))`, [owners]);
    await pool.query(`delete from public.tasks where owner_wallet = any($1)`, [owners]);
    await pool.query(`delete from public.task_packs where id = any($1)`, [tasks]);
    await pool.query(`delete from public.agents where id = any($1::uuid[])`, [agents]);
    await pool.query(`delete from public.vendors where display_name = any($1)`, [owners.map((o) => `wallet:${o}`)]);
    await pool.query(`delete from public.user_models where owner_wallet = any($1)`, [owners]);
    await pool.end();
  });

  it("keeps a custom model in its tenant and out of public.models", async () => {
    const catalog = new PgCatalogStore(pool);
    const before = (await catalog.listModels()).length;
    const knownBefore = (await store.listKnownModels()).length;
    const m = await store.createCustomModel(ALICE, model(`acme/m-${tag}`), 50);
    expect(m).toMatchObject({ id: `acme/m-${tag}`, providerKey: null, providerLabel: "Acme Labs", routeKey: "ollama" });
    expect((await store.listCustomModels(ALICE)).map((x) => x.id)).toEqual([`acme/m-${tag}`]);
    expect(await store.listCustomModels(BOB)).toEqual([]);
    expect((await catalog.listModels()).length).toBe(before);
    expect((await store.listKnownModels()).length).toBe(knownBefore);
    expect(await store.catalogHas(`acme/m-${tag}`)).toBe(false);
    // The same id for another tenant is a separate row.
    expect((await store.createCustomModel(BOB, model(`acme/m-${tag}`), 50)).id).toBe(`acme/m-${tag}`);
  });

  it("refuses a duplicate and a row above the cap", async () => {
    await expect(store.createCustomModel(ALICE, model(`acme/m-${tag}`), 50)).rejects.toMatchObject({ status: 409, code: "custom_model_exists" });
    await expect(store.createCustomModel(ALICE, model(`acme/m2-${tag}`), 1)).rejects.toMatchObject({ status: 409, code: "custom_model_limit" });
  });

  it("creates a local agent: connector local, no repo, declared provider and route, one empty version", async () => {
    const a = await store.createLocalAgent(ALICE, agentInput());
    expect(a).toMatchObject({ connector: "local", ownerWallet: ALICE, model: "opencode-go/kimi-k3", providerKey: "kimi", routeKey: "opencode-go", harness: "opencode 1.18.31", status: "active", visibility: "private" });
    expect(a.slug).toMatch(/^local-/);
    expect(a.latestVersion).toMatchObject({ commitSha: localCommitSha(`Local ${tag}`), fileCount: 0 });
    const row = (await pool.query(`select connector, repo_full_name, gh_installation_id, endpoint_url from public.agents where id = $1`, [a.id])).rows[0];
    expect(row).toEqual({ connector: "local", repo_full_name: null, gh_installation_id: null, endpoint_url: `local://${a.id}` });
    expect((await store.listLocalAgents(ALICE)).map((x) => x.id)).toEqual([a.id]);
    expect(await store.listLocalAgents(BOB)).toEqual([]);
    await expect(store.createLocalAgent(ALICE, agentInput())).rejects.toMatchObject({ status: 409, code: "agent_name_taken" });
    // The evaluations store reads the connector, so resolve.ts answers 409 agent_is_local.
    expect((await new PgEvaluationsStore(pool).getAgent(a.id))?.connector).toBe("local");
  });

  it("updates a local agent and blocks the delete of a custom model in use", async () => {
    const a = await store.createLocalAgent(ALICE, agentInput({ name: `Custom user ${tag}`, model: `acme/m-${tag}`, routeKey: "ollama", providerKey: null }));
    await expect(store.deleteCustomModel(ALICE, `acme/m-${tag}`)).rejects.toMatchObject({ status: 409, code: "model_in_use" });
    // Bob's row of the same id is not in use by Bob: it deletes.
    await store.deleteCustomModel(BOB, `acme/m-${tag}`);
    await expect(store.deleteCustomModel(BOB, `acme/m-${tag}`)).rejects.toMatchObject({ status: 404, code: "custom_model_not_found" });
    const u = await store.updateLocalAgent(a.id, { model: "ollama/qwen3-coder", providerKey: "qwen", harness: null, description: "Local only." });
    expect(u).toMatchObject({ model: "ollama/qwen3-coder", providerKey: "qwen", harness: null, description: "Local only." });
    await expect(store.updateLocalAgent(a.id, { name: `Local ${tag}` })).rejects.toMatchObject({ status: 409, code: "agent_name_taken" });
    await store.deleteCustomModel(ALICE, `acme/m-${tag}`);
    expect(await store.listCustomModels(ALICE)).toEqual([]);
  });

  it("takes a self-declared result for a local agent (L3)", async () => {
    const a = (await store.listLocalAgents(ALICE)).find((x) => x.name === `Local ${tag}`)!;
    const result = {
      format: "tma-local-result/1",
      agent_id: a.id,
      task: { local: { slug: `local-${tag}`, name: "Private task", contract_sha256: H("1"), environment_sha256: H("2"), hidden_tests_sha256: H("3") } },
      metrics_shape: "tma-score/1",
      grader_version: "1.1.0",
      runner: { version: "0.1.0", execution: "external", profile: "own-harness", sandbox_image_id: null },
      executor: { model_id: a.model, provider: "kimi", route: "opencode-go", harness: "opencode 1.18.31", variant: null, cost_source: "reported" },
      ran_from: "2026-10-26T12:00:00Z",
      ran_to: "2026-10-26T12:20:00Z",
      summary: { score: 70, runs: 1, items: 1 },
      runs: [{
        item_sha256: H("a"), repeat: 1, status: "fail", score: 70, wall_s: 100, cost_usd: null, tokens_in: null, tokens_out: null, error_class: null,
        parts: { public_behavior: 20, hidden_behavior: 30, regression: 10, patch_integrity_and_scope: 5, reproducible_evidence: 5 },
      }],
    } as unknown as LocalResult;
    const o = await new PgSelfDeclaredStore(pool).importResult(ALICE, result, { dryRun: false, perDay: 50 });
    expect(o).toMatchObject({ action: "inserted", outcome: "fail" });
    const e = (await pool.query(`select agent_version_id, result_origin, payment_kind from public.evaluations where id = $1`, [o.evaluationId])).rows[0];
    expect(e).toEqual({ agent_version_id: a.latestVersion!.id, result_origin: "self_declared", payment_kind: "none" });
  });
});

/**
 * db/migrations/0021_self_declared_results.sql against a real Postgres (plan
 * 20261026-tma-local-runner-and-self-declared-results, task L2). Runs when ITERA_PG_TEST_URL points at a
 * THROWAWAY Postgres with db/migrations applied, as a role that may ALTER the tables (the web3 e2e guard
 * job sets it to its own database). Never point it at a real project: the test applies the migration file.
 *
 * Proves: the file applies twice with no error; the relabel turns a bench-import row (and only it) into a
 * self-declared, payment-free, private row, and a second apply changes nothing; the CHECKs refuse the
 * forbidden shapes (a hosted 'none', a public self-declared row, a local agent with a repo, a local task
 * version without digests, a custom model with no provider, an approved device code with no principal, and
 * the L5 device-login states: approved and denied together, a consumed code with no session id, a revoked
 * pending code, a client name with a quote mark).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL_ = process.env.ITERA_PG_TEST_URL;
const SQL = readFileSync(new URL("../../../../db/migrations/0021_self_declared_results.sql", import.meta.url), "utf8");
const H = (c: string) => c.repeat(64);

function pgCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

describe.skipIf(!URL_)("migration 0021 on Postgres", () => {
  const pool = new Pool({ connectionString: URL_, max: 2 });
  const tag = `m0021-${randomUUID().slice(0, 8)}`;
  const owner = `dfl:${randomUUID()}`;
  const ids = { bench: randomUUID(), hosted: randomUUID() };
  let agentId = "";
  let versionId = "";
  let releaseId = "";
  let taskId = "";

  /** One evaluation + its run, as bench-import (provenance.source = bench-import) or the hosted worker wrote them. */
  async function evalWithRun(id: string, source: "bench-import" | "worker", isPublic: boolean) {
    await pool.query(
      `insert into public.evaluations (id, slug, short_id, owner_wallet, agent_id, agent_version_id, model_id, tasks, status, task_count, payment_kind, score, is_public)
       values ($1, $2, $3, $4, $5, $6, 'zai/glm-5.3', '[]'::jsonb, 'graded', 1, 'free_byok', 61.2, $7)`,
      [id, `${tag}-${source}`, `S${id.replaceAll("-", "").slice(0, 20)}`, owner, agentId, versionId, isPublic],
    );
    await pool.query(
      `insert into public.runs (id, release_declaration_id, task_pack_id, task_pack_version, nonce, status, evidence_manifest, score_total,
         agent_version_id, owner_wallet, task_id, evaluation_id, seq, provenance)
       values ($1, $2, $3, '1', $4, 'fail', '{}'::jsonb, 61, $5, $6, $7, $1, 1, $8)`,
      [id, releaseId, tag, `${tag}-${id}`, versionId, owner, taskId, JSON.stringify({ source })],
    );
  }
  const origin = async (id: string) =>
    (await pool.query(
      `select e.result_origin as eval_origin, e.payment_kind, e.is_public, r.result_origin as run_origin
         from public.evaluations e join public.runs r on r.evaluation_id = e.id where e.id = $1`,
      [id],
    )).rows[0];

  beforeAll(async () => {
    await pool.query(SQL);
    const vendor = await pool.query(`insert into public.vendors (display_name) values ($1) returning id`, [tag]);
    agentId = (await pool.query(
      `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, model, connector, visibility, status)
       values ($1, $2, $3, $4, 'zai/glm-5.3', 'endpoint', 'private', 'active') returning id`,
      [vendor.rows[0].id, `bench ${tag}`, `bench://${tag}`, owner],
    )).rows[0].id;
    versionId = (await pool.query(`insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, '[]'::jsonb) returning id`, [agentId, `prompt-${"c".repeat(33)}`])).rows[0].id;
    releaseId = (await pool.query(`insert into public.release_declarations (agent_id, release_ref) values ($1, 'r1') returning id`, [agentId])).rows[0].id;
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'm0021-test')`, [tag]);
    taskId = (await pool.query(
      `insert into public.tasks (slug, kind, owner_wallet, name, description, visibility) values ($1, 'user', $2, 'm0021 task', 'Synthetic.', 'private') returning id`,
      [tag, owner],
    )).rows[0].id;
    // The state BEFORE 0021: a bench-import row that claims hosted/free_byok (and was published), and a hosted row.
    await evalWithRun(ids.bench, "bench-import", true);
    await evalWithRun(ids.hosted, "worker", true);
  });

  afterAll(async () => {
    await pool.query(`delete from public.runs where task_pack_id = $1`, [tag]);
    await pool.query(`delete from public.evaluations where owner_wallet = $1`, [owner]);
    await pool.query(`delete from public.task_versions where task_id = $1`, [taskId]);
    await pool.query(`delete from public.tasks where id = $1`, [taskId]);
    await pool.query(`delete from public.agents where owner_wallet = $1 or name like $2`, [owner, `${tag}%`]);
    await pool.query(`delete from public.vendors where display_name = $1`, [tag]);
    await pool.query(`delete from public.task_packs where id = $1`, [tag]);
    await pool.query(`delete from public.user_models where owner_wallet = $1`, [owner]);
    await pool.query(`delete from public.cli_device_codes where user_code like 'ZZ%'`);
    await pool.end();
  });

  it("applies twice with no error, and the relabel is idempotent", async () => {
    await pool.query(SQL);
    const once = await origin(ids.bench);
    await pool.query(SQL);
    expect(await origin(ids.bench)).toEqual(once);
  });

  it("relabels only the bench-import rows: self_declared, payment_kind none, private", async () => {
    expect(await origin(ids.bench)).toEqual({ eval_origin: "self_declared", payment_kind: "none", is_public: false, run_origin: "self_declared" });
    expect(await origin(ids.hosted)).toEqual({ eval_origin: "hosted", payment_kind: "free_byok", is_public: true, run_origin: "hosted" });
  });

  it("refuses a hosted 'none' evaluation, a self-declared free_byok one, and a public self-declared one", async () => {
    const bad = [
      `update public.evaluations set payment_kind = 'none' where id = '${ids.hosted}'`,
      `update public.evaluations set result_origin = 'self_declared' where id = '${ids.hosted}'`,
      `update public.evaluations set is_public = true where id = '${ids.bench}'`,
      `update public.evaluations set result_origin = 'other' where id = '${ids.hosted}'`,
      `update public.runs set result_origin = 'other' where id = '${ids.hosted}'`,
    ];
    for (const sql of bad) await expect(pool.query(sql).catch((e) => pgCode(e)), sql).resolves.toBe("23514");
  });

  it("takes connector 'local' with a declared provider and route, but not with a repo", async () => {
    const vendor = (await pool.query(`select id from public.vendors where display_name = $1`, [tag])).rows[0].id;
    const ok = await pool.query(
      `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, model, connector, provider_key, route_key, status)
       values ($1, $2, 'local:', $3, 'opencode-go/deepseek-v4-pro', 'local', 'deepseek', 'opencode-go', 'active') returning connector`,
      [vendor, `${tag} local`, owner],
    );
    expect(ok.rows[0].connector).toBe("local");
    const withRepo = pool.query(
      `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, connector, repo_full_name) values ($1, $2, 'local:', $3, 'local', 'a/b')`,
      [vendor, `${tag} local repo`, owner],
    );
    await expect(withRepo.catch((e) => pgCode(e))).resolves.toBe("23514");
    const badKey = pool.query(
      `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, connector, provider_key) values ($1, $2, 'local:', $3, 'local', 'Not A Key')`,
      [vendor, `${tag} local key`, owner],
    );
    await expect(badKey.catch((e) => pgCode(e))).resolves.toBe("23514");
  });

  it("takes a local task version with its three digests only", async () => {
    const ok = await pool.query(
      `insert into public.task_versions (task_id, version, source, contract_digest, fixture_digest, hidden_digest) values ($1, 1, 'local', $2, $3, $4) returning source`,
      [taskId, H("1"), H("2"), H("3")],
    );
    expect(ok.rows[0].source).toBe("local");
    for (const [contract, fixture, hidden] of [[null, H("2"), H("3")], [H("1"), null, H("3")], [H("1"), H("2"), null], [H("1"), "short", H("3")]]) {
      const r = pool.query(
        `insert into public.task_versions (task_id, version, source, contract_digest, fixture_digest, hidden_digest) values ($1, 2, 'local', $2, $3, $4)`,
        [taskId, contract, fixture, hidden],
      );
      await expect(r.catch((e) => pgCode(e))).resolves.toBe("23514");
    }
    const withRepo = pool.query(
      `insert into public.task_versions (task_id, version, source, contract_digest, fixture_digest, hidden_digest, repo_full_name) values ($1, 3, 'local', $2, $3, $4, 'a/b')`,
      [taskId, H("1"), H("2"), H("3")],
    );
    await expect(withRepo.catch((e) => pgCode(e))).resolves.toBe("23514");
  });

  it("keeps a custom model in its owner's rows, with exactly one of provider_key and provider_label", async () => {
    await pool.query(`insert into public.user_models (owner_wallet, id, label, provider_key, route_key) values ($1, 'ollama/gemma4:12b', 'Gemma 4 12B', 'google', 'ollama')`, [owner]);
    await pool.query(`insert into public.user_models (owner_wallet, id, label, provider_label, route_key) values ($1, 'acme/acme-7b', 'Acme 7B', 'Acme Labs', 'openrouter')`, [owner]);
    const dup = pool.query(`insert into public.user_models (owner_wallet, id, label, provider_key, route_key) values ($1, 'ollama/gemma4:12b', 'x', 'google', 'ollama')`, [owner]);
    await expect(dup.catch((e) => pgCode(e))).resolves.toBe("23505");
    for (const [pk, pl, label] of [[null, null, "x"], ["google", "Acme", "x"], ["google", null, 'say "hi"'], ["google", null, "x".repeat(61)]]) {
      const r = pool.query(`insert into public.user_models (owner_wallet, id, label, provider_key, provider_label, route_key) values ($1, 'acme/other', $2, $3, $4, 'ollama')`, [owner, label, pk, pl]);
      await expect(r.catch((e) => pgCode(e))).resolves.toBe("23514");
    }
    const models = await pool.query(`select count(*)::int as n from public.models where id in ('ollama/gemma4:12b', 'acme/acme-7b')`);
    expect(models.rows[0].n).toBe(0);
  });

  it("stores a device code as sha256 only, and refuses an approval with no principal", async () => {
    await pool.query(`insert into public.cli_device_codes (device_code_sha256, user_code, expires_at) values ($1, 'ZZAA-0001', now() + interval '600 seconds')`, [H("a")]);
    const plain = pool.query(`insert into public.cli_device_codes (device_code_sha256, user_code, expires_at) values ('plain-device-code', 'ZZAA-0002', now())`);
    await expect(plain.catch((e) => pgCode(e))).resolves.toBe("23514");
    const noPrincipal = pool.query(`update public.cli_device_codes set approved_at = now() where device_code_sha256 = $1`, [H("a")]);
    await expect(noPrincipal.catch((e) => pgCode(e))).resolves.toBe("23514");
    const unapprovedUse = pool.query(`update public.cli_device_codes set consumed_at = now() where device_code_sha256 = $1`, [H("a")]);
    await expect(unapprovedUse.catch((e) => pgCode(e))).resolves.toBe("23514");
  });

  it("L5: a code is approved or denied, never both; a session id exists exactly when consumed; only an approved code is revoked", async () => {
    const p = `dfl:${randomUUID()}`;
    await pool.query(`insert into public.cli_device_codes (device_code_sha256, user_code, client_name, expires_at) values ($1, 'ZZBB-0001', 'tma on test', now() + interval '600 seconds')`, [H("b")]);
    const both = pool.query(`update public.cli_device_codes set approved_at = now(), principal = $2, denied_at = now() where device_code_sha256 = $1`, [H("b"), p]);
    await expect(both.catch((e) => pgCode(e))).resolves.toBe("23514");
    const revokePending = pool.query(`update public.cli_device_codes set revoked_at = now() where device_code_sha256 = $1`, [H("b")]);
    await expect(revokePending.catch((e) => pgCode(e))).resolves.toBe("23514");
    await pool.query(`update public.cli_device_codes set approved_at = now(), principal = $2 where device_code_sha256 = $1`, [H("b"), p]);
    const consumedNoSession = pool.query(`update public.cli_device_codes set consumed_at = now() where device_code_sha256 = $1`, [H("b")]);
    await expect(consumedNoSession.catch((e) => pgCode(e))).resolves.toBe("23514");
    await pool.query(`update public.cli_device_codes set consumed_at = now(), session_id = $2, revoked_at = now() where device_code_sha256 = $1`, [H("b"), randomUUID()]);
    const quote = pool.query(`insert into public.cli_device_codes (device_code_sha256, user_code, client_name, expires_at) values ($1, 'ZZBB-0002', 'say "hi"', now())`, [H("c")]);
    await expect(quote.catch((e) => pgCode(e))).resolves.toBe("23514");
  });
});

/**
 * One contract, two stores: `createFreeEvaluation` and the `graded` roll-up (plan
 * 20261015-testmyagent-web2-client, T7). The fake store always runs. The pg store runs when
 * ITERA_PG_TEST_URL points at a Postgres with db/migrations applied (the web3 e2e guard job sets it
 * to its own throwaway database). The URL must allow inserts in agents, task_packs, etc.: the test
 * writes its own fixtures and deletes them afterwards.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptRunKey } from "../domain/run-key.js";
import { FakeEvaluationsStore } from "./store.fake.js";
import { PgEvaluationsStore } from "./store.pg.js";
import { QuotaExceededError, TooManyQueuedError, type EvalTask, type EvaluationsStore, type NewFreeEvaluation, type RollupColumns } from "./store.js";

interface Harness {
  store: EvaluationsStore;
  agentId: string;
  agentVersionId: string;
  commit: string;
  task: EvalTask;
  /** A task whose run insert fails (the task pack does not exist: runs → task_packs FK). */
  badTask: EvalTask;
  runKey(runId: string): Promise<string | null>;
  rowsOf(owner: string): Promise<{ evaluations: number; runs: number }>;
  cleanup(): Promise<void>;
}

const SECRET = "k".repeat(48);
const sealed = () => encryptRunKey("sk-or-v1-" + "a".repeat(40), SECRET);

function input(h: Harness, owner: string, tasks: EvalTask[], maxActiveRuns = 3): NewFreeEvaluation {
  const evaluationId = randomUUID();
  return {
    evaluationId,
    runIds: tasks.map(() => randomUUID()),
    ownerWallet: owner,
    shortId: evaluationId.replace(/-/g, "").slice(0, 8),
    agentId: h.agentId,
    agentVersionId: h.agentVersionId,
    agentCommit: h.commit,
    modelId: "qwen/qwen3-coder",
    modelRelease: null,
    tasks,
    isPublic: true,
    modelApiKeyEnc: sealed(),
    maxActiveRuns,
  };
}

const gradedColumns: RollupColumns = {
  status: "graded", score: 80, passCount: 1, failCount: 0, invalidCount: 0, testsPassed: 6, testsTotal: 6,
  startedAt: null, completedAt: new Date().toISOString(), issuedAt: null, manifestSha256: null, slug: null, wipeModelKey: true,
};

function contract(name: string, setup: () => Promise<Harness>) {
  describe(`EvaluationsStore.createFreeEvaluation contract (${name})`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await setup();
    });
    afterAll(async () => {
      await h?.cleanup();
    });

    it("inserts a free_byok evaluation and N queued runs, each with the sealed key and no payment sig", async () => {
      const owner = `dfl:${randomUUID()}`;
      const req = input(h, owner, [h.task, h.task]);
      const created = await h.store.createFreeEvaluation(req);
      expect(created).toEqual({ evaluationId: req.evaluationId, runIds: req.runIds });
      const ev = await h.store.getEvaluation(req.evaluationId);
      expect(ev).toMatchObject({ paymentKind: "free_byok", status: "pending", ownerWallet: owner, paymentId: null, feeLamports: 0, feeUsd: 0, taskCount: 2 });
      const runs = await h.store.listRuns(req.evaluationId);
      expect(runs.map((r) => [r.id, r.status, r.seq, r.runStartSig])).toEqual([
        [req.runIds[0], "queued", 1, null],
        [req.runIds[1], "queued", 2, null],
      ]);
      for (const r of runs) {
        const key = await h.runKey(r.id);
        expect(key).toMatch(/^v1\./);
      }
    });

    it("writes nothing when a run insert fails mid-transaction", async () => {
      const owner = `dfl:${randomUUID()}`;
      await expect(h.store.createFreeEvaluation(input(h, owner, [h.task, h.badTask]))).rejects.toThrow();
      expect(await h.rowsOf(owner)).toEqual({ evaluations: 0, runs: 0 });
    });

    it("refuses with TooManyQueuedError when the owner already has >= max queued/running runs", async () => {
      const owner = `dfl:${randomUUID()}`;
      await h.store.createFreeEvaluation(input(h, owner, [h.task, h.task]));
      // 2 active < 3: one more evaluation passes.
      await h.store.createFreeEvaluation(input(h, owner, [h.task]));
      // 3 active >= 3: refused, and nothing is written.
      const err = await h.store.createFreeEvaluation(input(h, owner, [h.task])).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TooManyQueuedError);
      expect(err).toMatchObject({ active: 3, max: 3 });
      expect(await h.rowsOf(owner)).toEqual({ evaluations: 2, runs: 3 });
    });

    it("refuses with QuotaExceededError when the runs of the last 24 h plus the new ones pass the daily limit", async () => {
      const owner = `dfl:${randomUUID()}`;
      const quota = (tasks: EvalTask[], extra: Partial<NewFreeEvaluation> = {}) => ({ ...input(h, owner, tasks, 100), dailyRunLimit: 4, ...extra });
      await h.store.createFreeEvaluation(quota([h.task, h.task]));
      // An evaluation of N tasks counts N runs: 2 used + 3 new > 4.
      const err = await h.store.createFreeEvaluation(quota([h.task, h.task, h.task])).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(QuotaExceededError);
      expect(err).toMatchObject({ used: 2, limit: 4 });
      const resetMs = Date.parse((err as QuotaExceededError).resetAt) - Date.now();
      expect(resetMs).toBeGreaterThan(24 * 3600_000 - 60_000);
      expect(resetMs).toBeLessThanOrEqual(24 * 3600_000);
      // Nothing was written by the refused request; two more runs still fit.
      expect(await h.rowsOf(owner)).toEqual({ evaluations: 1, runs: 2 });
      await h.store.createFreeEvaluation(quota([h.task, h.task]));
      // 25 h later the 4 runs left the 24 h window.
      await h.store.createFreeEvaluation(quota([h.task], { now: new Date(Date.now() + 25 * 3600_000) }));
      // Another owner has its own quota.
      await h.store.createFreeEvaluation({ ...input(h, `dfl:${randomUUID()}`, [h.task], 100), dailyRunLimit: 4 });
    });

    it("parallel requests cannot pass the daily limit (the owner's lock serializes the check)", async () => {
      const owner = `dfl:${randomUUID()}`;
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => h.store.createFreeEvaluation({ ...input(h, owner, [h.task], 100), dailyRunLimit: 3 })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toHaveLength(3);
      for (const r of rejected) expect(r.reason).toBeInstanceOf(QuotaExceededError);
      expect(await h.rowsOf(owner)).toEqual({ evaluations: 3, runs: 3 });
    });

    it("stores the graded terminal state, and the issuer job no longer lists it", async () => {
      const owner = `dfl:${randomUUID()}`;
      const req = input(h, owner, [h.task]);
      await h.store.createFreeEvaluation(req);
      expect(await h.store.listOpen(1000)).toContain(req.evaluationId);
      await h.store.saveRollup(req.evaluationId, gradedColumns);
      expect((await h.store.getEvaluation(req.evaluationId))?.status).toBe("graded");
      expect(await h.store.listOpen(1000)).not.toContain(req.evaluationId);
    });
  });
}

contract("fake", async () => {
  const store = new FakeEvaluationsStore();
  const agentId = randomUUID();
  const agentVersionId = randomUUID();
  const task: EvalTask = { taskId: "webhook-ledger", taskVersionId: null, slug: "webhook-ledger", name: "Webhook ledger", packId: "webhook-ledger", packVersion: "1", isPublic: true };
  store.tasks.push({ ...task, runnable: true });
  return {
    store,
    agentId,
    agentVersionId,
    commit: "c".repeat(40),
    task,
    badTask: { ...task, taskId: "missing", packId: "no-such-pack" },
    runKey: async (id) => store.runKeys.get(id) ?? null,
    rowsOf: async (owner) => ({
      evaluations: store.evaluations.filter((e) => e.ownerWallet === owner).length,
      runs: store.runs.filter((r) => store.runOwners.get(r.id) === owner).length,
    }),
    cleanup: async () => undefined,
  };
});

const PG_URL = process.env.ITERA_PG_TEST_URL;

if (PG_URL) {
  contract("pg", async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 4 });
    const tag = `t7-contract-${randomUUID().slice(0, 8)}`;
    const vendor = await pool.query(`insert into public.vendors (display_name) values ($1) returning id`, [tag]);
    const agent = await pool.query(
      `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, model, connector, visibility, status)
       values ($1, $2, 'github://t7/contract/.', $2, 'qwen/qwen3-coder', 'github', 'listed', 'active') returning id`,
      [vendor.rows[0].id, tag],
    );
    const agentId: string = agent.rows[0].id;
    const commit = "c".repeat(40);
    const version = await pool.query(`insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, '[]'::jsonb) returning id`, [agentId, commit]);
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'contract-test')`, [tag]);
    const task: EvalTask = { taskId: tag, taskVersionId: null, slug: tag, name: tag, packId: tag, packVersion: "1", isPublic: true };
    return {
      store: new PgEvaluationsStore(pool),
      agentId,
      agentVersionId: version.rows[0].id,
      commit,
      task,
      badTask: { ...task, taskId: "missing", packId: `${tag}-missing` },
      runKey: async (id) => (await pool.query(`select model_api_key_enc from public.runs where id = $1`, [id])).rows[0]?.model_api_key_enc ?? null,
      rowsOf: async (owner) => {
        const { rows } = await pool.query(
          `select (select count(*) from public.evaluations where owner_wallet = $1)::int as evaluations,
                  (select count(*) from public.runs where owner_wallet = $1)::int as runs`,
          [owner],
        );
        return { evaluations: rows[0].evaluations, runs: rows[0].runs };
      },
      cleanup: async () => {
        await pool.query(`delete from public.runs where task_pack_id = $1`, [tag]);
        await pool.query(`delete from public.evaluations where agent_id = $1`, [agentId]);
        await pool.query(`delete from public.release_declarations where agent_id = $1`, [agentId]);
        await pool.query(`delete from public.agents where id = $1`, [agentId]);
        await pool.query(`delete from public.vendors where id = $1`, [vendor.rows[0].id]);
        await pool.query(`delete from public.task_packs where id = $1`, [tag]);
        await pool.end();
      },
    };
  });

  describe("0019 CHECK constraints (pg)", () => {
    it("keeps the fee NOT NULL for solana_pay and the payment NULL for free_byok", async () => {
      const pool = new Pool({ connectionString: PG_URL, max: 1 });
      try {
        const client = await pool.connect();
        try {
          await client.query("begin");
          const vendor = await client.query(`insert into public.vendors (display_name) values ('t7-check') returning id`);
          const agent = await client.query(
            `insert into public.agents (vendor_id, name, endpoint_url) values ($1, 't7-check', 'x') returning id`,
            [vendor.rows[0].id],
          );
          const version = await client.query(`insert into public.agent_versions (agent_id, commit_sha, files) values ($1, 'c', '[]') returning id`, [agent.rows[0].id]);
          const insert = (kind: string, fee: number | null) =>
            client.query(
              `insert into public.evaluations (short_id, owner_wallet, agent_id, agent_version_id, model_id, task_count, payment_kind,
                 price_usd_per_run, fee_usd, fee_lamports, sol_usd_rate, price_source)
               values (substr(md5(random()::text), 1, 8), 'w', $1, $2, 'm', 1, $3, $4::numeric, $4::numeric, $4::bigint, $4::numeric, $5::text)`,
              [agent.rows[0].id, version.rows[0].id, kind, fee, fee === null ? null : "fixed"],
            );
          await client.query("savepoint s");
          await expect(insert("solana_pay", null)).rejects.toMatchObject({ code: "23514" });
          await client.query("rollback to savepoint s");
          await expect(insert("free_byok", null)).resolves.toBeTruthy();
          await expect(insert("solana_pay", 1)).resolves.toBeTruthy();
        } finally {
          await client.query("rollback").catch(() => undefined);
          client.release();
        }
      } finally {
        await pool.end();
      }
    });
  });
}

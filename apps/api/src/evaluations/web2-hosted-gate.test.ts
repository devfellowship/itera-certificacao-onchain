/**
 * web2 = ingested only for now (Tainan TG 23889, task L15a): with the DEFAULT options a `dfl` principal gets
 * `403 hosted_not_available_web2` on the three hosted start routes, nothing is written, no key is probed; the
 * reads stay open; the `siws` path and the anonymous 401 are unchanged; `TMA_WEB2_HOSTED_ENABLED` turns the
 * hosted dfl path back on. The free BYOK tests (free-byok.test.ts, abuse-controls.test.ts, byok-probe.test.ts)
 * keep proving that path with `web2Hosted: true`.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppOptions } from "../app.js";
import { issueSessionToken } from "../auth/session.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { FakeRunsStore } from "../domain/runs-store.fake.js";
import { encryptRunKey } from "../domain/run-key.js";
import { LEGACY_RUNS_GONE_FOR_DFL } from "../http/runs-router.js";
import type { ModelKeyProbe } from "../payments/adapters/free-byok.js";
import type { PaymentGateway } from "../payments/adapters/solana-pay-gateway.js";
import type { EvaluationsConfig } from "./config.js";
import { FakeEvaluationsStore } from "./store.fake.js";
import { HOSTED_NOT_AVAILABLE_WEB2_CODE, hostedNotAvailableWeb2Body, web2HostedEnabledFromEnv } from "./web2-hosted-gate.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SECRET = "k".repeat(48);
const KEY = "sk-or-v1-" + "a".repeat(40);
const WEB2 = "https://web2.example";
const LEDGER_CONTRACT = JSON.parse(readFileSync(new URL("../../../../benchmarks/tsk_webhook_dup/task.json", import.meta.url), "utf-8"));
const config: EvaluationsConfig = {
  baseFeeUsd: 0.1,
  fallbackPriceUsd: 0.2,
  quoteTtlMs: 120_000,
  quoteGraceMs: 15_000,
  treasury: "GZTkDGqnELbVMrnpq5rK8yizzJ5JpMxrTzdKyitrgWWp",
  runsPerWalletPerDay: 30,
  maxTasks: 9,
  webBaseUrl: "https://web.example",
  maxQueuedRunsPerUser: 3,
};

let server: Server;
let base: string;
let store: FakeEvaluationsStore;
let runsStore: FakeRunsStore;
let gateway: PaymentGateway & { verify: ReturnType<typeof vi.fn> };
let probe: ReturnType<typeof vi.fn<ModelKeyProbe>>;
let agentId: string;
let dfl: string;

const dflToken = (id: string) => issueSessionToken(id, Date.now(), "dfl").token;
const siwsToken = () => issueSessionToken(WALLET, Date.now(), "siws").token;

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const freeBody = (extra: Record<string, unknown> = {}) => ({ agentId, taskIds: ["webhook-ledger"], modelApiKey: KEY, ...extra });

/** The app with the DEFAULT gate options (flag off), unless `evaluations` overrides them. */
async function startApp(evaluations: Partial<AppOptions["evaluations"]> = {}) {
  server = createApp(new FakeRepository(), {
    evaluations: {
      store,
      config,
      price: async () => ({ solUsdRate: 100, priceSource: "pyth", publishedAt: new Date().toISOString() }),
      payments: gateway,
      runKeySecret: SECRET,
      probeModelKey: probe,
      web2BaseUrl: WEB2,
      ...evaluations,
    },
    runs: { store: runsStore, runKeySecret: SECRET },
  }).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  store = new FakeEvaluationsStore();
  runsStore = new FakeRunsStore();
  gateway = {
    newReference: () => Keypair.generate().publicKey.toBase58(),
    transferUrl: () => "solana:x",
    buildTransferTx: async () => "AAAA",
    verify: vi.fn(async () => ({ ok: false as const, code: "not_found" as const, message: "not found" })),
  };
  probe = vi.fn<ModelKeyProbe>(async () => ({ ok: true }));
  agentId = randomUUID();
  dfl = `dfl:${randomUUID()}`;
  store.agents.push({ id: agentId, ownerWallet: WALLET, name: "Settle Wise", slug: "settlewise", repoFullName: "acme/agent", agentPath: ".", model: "qwen/qwen3-coder", modelRelease: null, visibility: "listed", pinnedCommit: null, requires: [] });
  store.versions.push({ id: randomUUID(), agentId, commitSha: "9f2c1ab0".padEnd(40, "0") });
  store.tasks.push({ taskId: "webhook-ledger", taskVersionId: null, slug: "webhook-ledger", name: "Webhook ledger", packId: "webhook-ledger", packVersion: "1", isPublic: true, runnable: true, contract: LEDGER_CONTRACT });
  await startApp();
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const expected = hostedNotAvailableWeb2Body(WEB2);

function expectRefused(res: { status: number; body: Record<string, any> }) {
  expect(res.status).toBe(403);
  expect(res.body).toEqual(expected);
  expect(res.body.error).toBe(HOSTED_NOT_AVAILABLE_WEB2_CODE);
  expect(res.body.selfDeclared).toBe("POST /self-declared-results");
  expect(res.body.message).toContain("POST /self-declared-results");
  expect(res.body.localRunner.steps).toHaveLength(3);
  expect(res.body.localRunner.steps[0]).toBe("tma login");
  expect(res.body.localRunner.steps[1]).toMatch(/^tma run --task .* --agent .* --agent-dir .* --model .* --out result\.json$/);
  expect(res.body.localRunner.steps[2]).toBe("tma upload result.json");
  expect(res.body.localRunner.newLocalAgentUrl).toBe(`${WEB2}/agents/new?source=local`);
}

describe("the gate with the default options (TMA_WEB2_HOSTED_ENABLED off)", () => {
  it("1. dfl → POST /evaluations/quote with a valid body → 403 hosted_not_available_web2", async () => {
    expectRefused(await call("POST", "/evaluations/quote", dflToken(dfl), { agentId, taskIds: ["webhook-ledger"] }));
    expect(store.payments).toHaveLength(0);
  });

  it("2. dfl → POST /evaluations with a valid free BYOK body → 403, nothing written, the key never probed", async () => {
    expectRefused(await call("POST", "/evaluations", dflToken(dfl), freeBody()));
    expect(store.evaluations).toHaveLength(0);
    expect(store.runs).toHaveLength(0);
    expect(store.payments).toHaveLength(0);
    expect(store.runKeys.size).toBe(0);
    expect(probe).not.toHaveBeenCalled();
    expect(gateway.verify).not.toHaveBeenCalled();
    // The paid shape of a dfl caller is refused the same way (before the adapter reads the reference).
    expectRefused(await call("POST", "/evaluations", dflToken(dfl), { reference: Keypair.generate().publicKey.toBase58() }));
    expect(gateway.verify).not.toHaveBeenCalled();
  });

  it("3. dfl → POST /evaluations/quote/:reference/transaction → 403 same body", async () => {
    expectRefused(await call("POST", `/evaluations/quote/${Keypair.generate().publicKey.toBase58()}/transaction`, dflToken(dfl), {}));
  });

  it("4. the reads stay open for dfl: GET /evaluations → 200, GET /evaluations/:id of its own evaluation → 200", async () => {
    const task = store.tasks[0]!;
    const evaluationId = randomUUID();
    await store.createFreeEvaluation({
      evaluationId,
      runIds: [randomUUID()],
      ownerWallet: dfl,
      shortId: "abc12345",
      agentId,
      agentVersionId: store.versions[0]!.id,
      agentCommit: store.versions[0]!.commitSha,
      modelId: "qwen/qwen3-coder",
      modelRelease: null,
      tasks: [{ taskId: task.taskId, taskVersionId: task.taskVersionId, slug: task.slug, name: task.name, packId: task.packId, packVersion: task.packVersion, isPublic: true }],
      isPublic: false,
      modelApiKeyEnc: encryptRunKey(KEY, SECRET),
      maxActiveRuns: 3,
    });
    const token = dflToken(dfl);
    const list = await call("GET", "/evaluations", token);
    expect(list.status).toBe(200);
    expect(list.body.evaluations.map((e: any) => e.id)).toEqual([evaluationId]);
    const one = await call("GET", `/evaluations/${evaluationId}`, token);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: evaluationId, paymentKind: "free_byok" });
    // The cancel stays open too (its own answer, not the gate's).
    const cancel = await call("POST", `/evaluations/${evaluationId}/cancel`, token);
    expect(cancel.status).toBe(200);
    expect(cancel.body).toMatchObject({ evaluationId, status: "cancelled" });
  });

  it("5. siws is unchanged: the quote is 201, the unpaid POST /evaluations is 402", async () => {
    const token = siwsToken();
    const q = await call("POST", "/evaluations/quote", token, { agentId, taskIds: ["webhook-ledger"] });
    expect(q.status).toBe(201);
    expect(q.body.error).not.toBe(HOSTED_NOT_AVAILABLE_WEB2_CODE);
    expect(q.body.reference).toEqual(expect.any(String));
    const tx = await call("POST", `/evaluations/quote/${q.body.reference}/transaction`, token, {});
    expect(tx.status).not.toBe(403);
    const res = await call("POST", "/evaluations", token, { reference: q.body.reference });
    expect(res).toMatchObject({ status: 402, body: { code: "payment_not_found" } });
    expect(store.evaluations).toHaveLength(0);
  });

  it("7. anonymous → POST /evaluations/quote → 401 (auth runs first)", async () => {
    const res = await call("POST", "/evaluations/quote", null, { agentId, taskIds: ["webhook-ledger"] });
    expect(res.status).toBe(401);
    expect(res.body.error).not.toBe(HOSTED_NOT_AVAILABLE_WEB2_CODE);
  });

  it("8. dfl → POST /runs → 410 legacy_runs_retired_for_dfl, and the body no longer points to POST /evaluations", async () => {
    runsStore.agents.push({ id: agentId, ownerWallet: dfl, repoFullName: "acme/agent", agentPath: ".", model: "qwen/qwen3-coder" });
    const res = await call("POST", "/runs", dflToken(dfl), { agentId, benchmarkId: "webhook-ledger", benchmarkVersion: "1" });
    expect(res.status).toBe(410);
    expect(res.body).toEqual(LEGACY_RUNS_GONE_FOR_DFL);
    expect(res.body.code).toBe("legacy_runs_retired_for_dfl");
    expect(JSON.stringify(res.body)).not.toContain("POST /evaluations");
    expect(res.body.message).toContain("POST /self-declared-results");
    expect(res.body.replacement).toEqual({ localRunner: { steps: expected.localRunner.steps }, selfDeclared: "POST /self-declared-results" });
    expect(runsStore.runs).toHaveLength(0);
  });

  it("the legacy vendor body of a dfl caller still falls through to the 410 of the retired flow", async () => {
    const res = await call("POST", "/evaluations", dflToken(dfl), { idempotencyKey: "x" });
    expect(res).toMatchObject({ status: 410, body: { code: "legacy_flow_retired" } });
  });
});

describe("6. the flag TMA_WEB2_HOSTED_ENABLED", () => {
  it("reads only the exact value true (trimmed, lower case); default false", () => {
    expect(web2HostedEnabledFromEnv({})).toBe(false);
    expect(web2HostedEnabledFromEnv({ TMA_WEB2_HOSTED_ENABLED: "true" })).toBe(true);
    expect(web2HostedEnabledFromEnv({ TMA_WEB2_HOSTED_ENABLED: "TRUE " })).toBe(true);
    expect(web2HostedEnabledFromEnv({ TMA_WEB2_HOSTED_ENABLED: "1" })).toBe(false);
    expect(web2HostedEnabledFromEnv({ TMA_WEB2_HOSTED_ENABLED: "" })).toBe(false);
    expect(web2HostedEnabledFromEnv({ TMA_WEB2_HOSTED_ENABLED: "false" })).toBe(false);
  });

  it("with web2Hosted: true a dfl quote is not 403 (the old free quote answers)", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await startApp({ web2Hosted: true });
    const q = await call("POST", "/evaluations/quote", dflToken(dfl), { agentId, taskIds: ["webhook-ledger"] });
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ paymentKind: "free_byok", totalUsd: 0, modelKeyRequired: true });
    const created = await call("POST", "/evaluations", dflToken(dfl), freeBody());
    expect(created.status).toBe(202);
    expect(probe).toHaveBeenCalledWith(KEY);
    expect(store.evaluations).toHaveLength(1);
  });
});

describe("hostedNotAvailableWeb2Body", () => {
  it("drops trailing slashes of the base url and names the real tma flags", () => {
    const body = hostedNotAvailableWeb2Body("https://x.example///");
    expect(body.localRunner.newLocalAgentUrl).toBe("https://x.example/agents/new?source=local");
    expect(body.localRunner.steps[1]).toBe("tma run --task <task slug> --agent <agent id> --agent-dir <agent dir> --model <model id> --out result.json");
    expect(body).toEqual(JSON.parse(JSON.stringify(body)));
  });
});

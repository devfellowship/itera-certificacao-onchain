/**
 * Evaluations v2 (plan 20261012-itera-testmyagent-ui-refactor, ADR-1, ADR-2, Gate Q1/Q2):
 *
 *   POST /evaluations/quote                          price N runs in SOL (Pyth → CoinGecko), 120 s
 *   POST /evaluations/quote/:reference/transaction   the unsigned payment tx for the wallet (1 prompt)
 *   POST /evaluations                                verify the payment (Solana Pay) → queue N runs
 *   GET  /evaluations?scope=all|my_agents|others     My evaluations
 *   GET  /evaluations/:id                            roll-up (uiState, stages, tasks, events, proofs)
 *   POST /evaluations/:id/cancel                     queued runs → cancelled; no refund (Gate Q1)
 *
 * One wallet prompt per evaluation: the payment tx carries the transfer (with the Solana Pay
 * reference) and the Memo `itera-eval:v1:{evaluation_id, run_ids, …}`. Its signature is every
 * run's run_start_sig. TestMyAgent pays the model tokens (Gate Q2) and the proof issuance.
 *
 * The legacy vendor flow also answers `POST /evaluations` (body with `idempotencyKey`): such a body
 * falls through to it.
 */
import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { encryptRunKey } from "../domain/run-key.js";
import { requireWallet } from "../http/auth.js";
import { isModelApiKey } from "../http/runs-router.js";
import { lamportsToSol, round4, usdToLamports, type EvaluationsConfig } from "./config.js";
import { buildEvaluationMemo } from "./memo.js";
import { priceRun, type RunCostEstimator } from "./estimate.js";
import { PriceUnavailableError, type SolUsdProvider } from "./price.js";
import { initialsOf, rollup } from "./rollup.js";
import type { PaymentGateway } from "./solana-pay.js";
import { EvaluationConflictError, type EvalTask, type EvaluationListRow, type EvaluationsStore, type PaymentRecord } from "./store.js";

export interface EvaluationsRouterDeps {
  store: EvaluationsStore;
  config: EvaluationsConfig;
  price: SolUsdProvider;
  payments: PaymentGateway;
  /** Forecast model cost of one run. Absent → every run is priced at the fallback. */
  estimate?: RunCostEstimator;
  /** ITERA_RUN_KEY_SECRET — only for the optional BYOK key. */
  runKeySecret?: string;
  now?: () => number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;
const LIST_LIMIT = 200;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function quoteView(p: PaymentRecord, transferUrl: string) {
  const sum = (f: (t: EvalTask) => number | null | undefined) => round4(p.tasks.reduce((a, t) => a + (f(t) ?? 0), 0));
  return {
    quoteId: p.id,
    // Itemized (Tainan TG 20986): forecast model cost + base fee per run, rounded up to the cent.
    modelCostEstimateUsd: sum((t) => t.pricing?.modelCostEstimateUsd),
    baseFeeUsd: sum((t) => t.pricing?.baseFeeUsd),
    totalUsd: p.amountUsd,
    totalLamports: p.amountLamports,
    solUsd: p.solUsdRate,
    priceUsdPerRun: p.priceUsdPerRun,
    taskCount: p.taskCount,
    amountUsd: p.amountUsd,
    solUsdRate: p.solUsdRate,
    priceSource: p.priceSource,
    amountLamports: p.amountLamports,
    sol: lamportsToSol(p.amountLamports),
    treasury: p.treasury,
    reference: p.reference,
    memo: p.memo,
    transferUrl,
    expiresAt: p.quoteExpiresAt,
    evaluationId: p.plannedEvaluationId,
    runIds: p.plannedRunIds,
    tasks: p.tasks.map((t, i) => ({
      taskId: t.taskId,
      slug: t.slug,
      name: t.name,
      seq: i + 1,
      runId: p.plannedRunIds[i],
      modelCostEstimateUsd: t.pricing?.modelCostEstimateUsd ?? null,
      baseFeeUsd: t.pricing?.baseFeeUsd ?? null,
      priceUsd: t.pricing?.priceUsd ?? null,
      estimateBasis: t.pricing?.basis ?? null,
    })),
  };
}

function shareOf(e: EvaluationListRow, webBaseUrl: string) {
  if (e.status !== "issued" || !e.slug) return { kind: "none" as const, url: null };
  if (!e.isPublic) return { kind: "private" as const, url: null };
  return { kind: "link" as const, url: `${webBaseUrl}/e/${e.slug}` };
}

export function createEvaluationsV2Router(deps: EvaluationsRouterDeps): Router {
  const { store, config } = deps;
  const now = deps.now ?? Date.now;
  const router = Router();

  const handle =
    (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler =>
    (req, res, next) => {
      fn(req, res, next).catch((e) => {
        if (e instanceof SchemaNotReadyError) res.status(503).json({ error: e.message });
        else if (e instanceof PriceUnavailableError) res.status(503).json({ error: e.message });
        else next(e);
      });
    };

  router.post(
    "/evaluations/quote",
    requireWallet,
    handle(async (req, res) => {
      const wallet = req.wallet!;
      const body = (req.body ?? {}) as { agentId?: unknown; taskIds?: unknown; modelRelease?: unknown };
      if (!isNonEmptyString(body.agentId) || !UUID_RE.test(body.agentId)) {
        res.status(400).json({ error: "agentId (uuid) is required" });
        return;
      }
      const taskIds = Array.isArray(body.taskIds) ? [...new Set(body.taskIds.filter(isNonEmptyString).map((t) => t.trim()))] : [];
      if (taskIds.length === 0) {
        res.status(400).json({ error: "taskIds (non-empty array) is required" });
        return;
      }
      if (taskIds.length > config.maxTasks) {
        res.status(400).json({ error: `at most ${config.maxTasks} tasks per evaluation` });
        return;
      }
      if (!config.treasury) {
        res.status(503).json({ error: "payments are not configured on this server (ITERA_TREASURY_ADDRESS)" });
        return;
      }
      const agent = await store.getAgent(body.agentId);
      if (!agent || (agent.ownerWallet !== wallet && agent.visibility !== "listed")) {
        res.status(404).json({ error: "agent not found" });
        return;
      }
      const version = await store.agentVersionFor(agent.id, agent.pinnedCommit);
      if (!version) {
        res.status(409).json({ error: "agent has no synced version yet — connect its repository first" });
        return;
      }
      const tasks: EvalTask[] = [];
      for (const id of taskIds) {
        const t = await store.resolveTask(id);
        if (!t) {
          res.status(404).json({ error: `unknown task ${id}` });
          return;
        }
        if (!t.runnable) {
          res.status(409).json({ error: `task ${t.slug} is not runnable yet` });
          return;
        }
        const { runnable: _r, ...task } = t;
        tasks.push(task);
      }
      const recent = await store.countRecentRuns(wallet);
      if (recent + tasks.length > config.runsPerWalletPerDay) {
        res.status(429).json({ error: `daily limit: ${config.runsPerWalletPerDay} runs per wallet per 24h (${recent} used)` });
        return;
      }

      const modelId = agent.model ?? "unknown";
      for (const t of tasks) {
        const est = deps.estimate && t.packId ? await deps.estimate(t.packId, t.packVersion, modelId).catch(() => null) : null;
        t.pricing = priceRun(est, config.baseFeeUsd, config.fallbackPriceUsd);
      }
      const rate = await deps.price();
      const amountUsd = round4(tasks.reduce((a, t) => a + t.pricing!.priceUsd, 0));
      const amountLamports = usdToLamports(amountUsd, rate.solUsdRate);
      const plannedEvaluationId = randomUUID();
      const plannedRunIds = tasks.map(() => randomUUID());
      const memo = buildEvaluationMemo({
        evaluationId: plannedEvaluationId,
        runIds: plannedRunIds,
        agentRepo: agent.repoFullName,
        agentCommit: version.commitSha,
        modelId,
        tasks: tasks.map((t) => `${t.packId || t.slug}@${t.packVersion || "1"}`),
      });
      const payment = await store.createQuote({
        payerWallet: wallet,
        agentId: agent.id,
        agentVersionId: version.id,
        modelId,
        tasks,
        taskCount: tasks.length,
        priceUsdPerRun: round4(amountUsd / tasks.length),
        amountUsd,
        amountLamports,
        solUsdRate: rate.solUsdRate,
        priceSource: rate.priceSource,
        treasury: config.treasury,
        quoteExpiresAt: new Date(now() + config.quoteTtlMs).toISOString(),
        reference: deps.payments.newReference(),
        plannedEvaluationId,
        plannedRunIds,
        memo,
      });
      const transferUrl = deps.payments.transferUrl({
        recipient: payment.treasury,
        lamports: payment.amountLamports,
        reference: payment.reference,
        memo: payment.memo,
        label: "TestMyAgent",
        message: `Evaluation of ${agent.name} · ${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
      });
      res.status(201).json(quoteView(payment, transferUrl));
    }),
  );

  router.post(
    "/evaluations/quote/:reference/transaction",
    requireWallet,
    handle(async (req, res) => {
      const reference = String(req.params.reference);
      const payment = BASE58_RE.test(reference) ? await store.getPaymentByReference(reference) : null;
      if (!payment || payment.payerWallet !== req.wallet) {
        res.status(404).json({ error: "quote not found" });
        return;
      }
      if (payment.evaluationId) {
        res.status(409).json({ error: "this quote is already paid", evaluationId: payment.evaluationId });
        return;
      }
      if (now() > Date.parse(payment.quoteExpiresAt)) {
        res.status(402).json({ error: "quote expired", code: "quote_expired" });
        return;
      }
      const account = (req.body as { account?: unknown } | undefined)?.account ?? req.wallet;
      if (!isNonEmptyString(account) || !BASE58_RE.test(account)) {
        res.status(400).json({ error: "account must be a base58 public key" });
        return;
      }
      try {
        const transaction = await deps.payments.buildTransferTx(account, {
          recipient: payment.treasury,
          lamports: payment.amountLamports,
          reference: payment.reference,
          memo: payment.memo,
        });
        res.json({ transaction, memo: payment.memo, expiresAt: payment.quoteExpiresAt });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // createTransfer checks the payer: "sender not found" / "insufficient funds".
        res.status(/insufficient|not found/i.test(message) ? 402 : 502).json({ error: message, code: /insufficient/i.test(message) ? "insufficient_funds" : "build_failed" });
      }
    }),
  );

  router.post(
    "/evaluations",
    (req, res, next) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // The legacy vendor flow (http/evaluations-router.ts) keeps its body shape.
      if ("idempotencyKey" in body && !("reference" in body) && !("txSig" in body)) {
        next("route");
        return;
      }
      next();
    },
    requireWallet,
    handle(async (req, res) => {
      const wallet = req.wallet!;
      const body = (req.body ?? {}) as { reference?: unknown; txSig?: unknown; modelApiKey?: unknown; modelRelease?: unknown };
      const txSig = isNonEmptyString(body.txSig) ? body.txSig.trim() : null;
      if (txSig && !BASE58_RE.test(txSig)) {
        res.status(400).json({ error: "txSig must be a base58 signature" });
        return;
      }
      let payment: PaymentRecord | null = null;
      if (isNonEmptyString(body.reference)) payment = await store.getPaymentByReference(body.reference.trim());
      else if (txSig) payment = await store.getPaymentByTxSig(txSig);
      else {
        res.status(400).json({ error: "reference (from POST /evaluations/quote) is required" });
        return;
      }
      if (!payment) {
        res.status(404).json({ error: "quote not found" });
        return;
      }
      if (payment.payerWallet !== wallet) {
        res.status(403).json({ error: "this quote belongs to another wallet" });
        return;
      }
      // Idempotent on the payment (and so on txSig): the same evaluation, never a second one.
      if (payment.evaluationId) {
        if (txSig && payment.txSig && txSig !== payment.txSig) {
          res.status(409).json({ error: "this quote was paid by another transaction", evaluationId: payment.evaluationId });
          return;
        }
        res.status(200).json({ evaluationId: payment.evaluationId, status: "existing", txSig: payment.txSig, runs: payment.plannedRunIds.map((runId, i) => ({ runId, taskId: payment!.tasks[i]?.taskId, seq: i + 1 })) });
        return;
      }
      if (txSig) {
        const other = await store.getPaymentByTxSig(txSig);
        if (other && other.id !== payment.id) {
          res.status(409).json({ error: "this transaction already paid another quote" });
          return;
        }
      }

      let modelApiKeyEnc: string | null = null;
      if (body.modelApiKey !== undefined && body.modelApiKey !== null && body.modelApiKey !== "") {
        // Gate Q2 = B: TestMyAgent pays the tokens. BYOK stays optional in the API only.
        if (!isModelApiKey(body.modelApiKey)) {
          res.status(400).json({ error: "modelApiKey is not a plausible API key" });
          return;
        }
        if (!deps.runKeySecret) {
          res.status(503).json({ error: "BYOK is not configured on this server (ITERA_RUN_KEY_SECRET)" });
          return;
        }
        modelApiKeyEnc = encryptRunKey(body.modelApiKey.trim(), deps.runKeySecret);
      }

      const expiresMs = Date.parse(payment.quoteExpiresAt) + config.quoteGraceMs;
      const fields = { recipient: payment.treasury, lamports: payment.amountLamports, reference: payment.reference, memo: payment.memo };
      const verified = await deps.payments.verify(fields, txSig);
      if (!verified.ok) {
        if (verified.code === "not_found") {
          if (now() > expiresMs) res.status(402).json({ error: "quote expired", code: "quote_expired" });
          else res.status(402).json({ error: `payment not found or not confirmed yet: ${verified.message}`, code: "payment_not_found" });
          return;
        }
        res.status(402).json({ error: verified.message, code: /amount not transferred/.test(verified.message) ? "wrong_amount" : "payment_invalid" });
        return;
      }
      if (verified.blockTimeMs !== null && verified.blockTimeMs > expiresMs) {
        res.status(402).json({ error: "quote expired: the transfer landed after the quote window", code: "quote_expired", txSig: verified.txSig });
        return;
      }
      const quotedVersion = await store.getAgentVersion(payment.agentVersionId);
      let created;
      try {
        created = await store.createEvaluationFromPayment({
          paymentId: payment.id,
          txSig: verified.txSig,
          ownerWallet: wallet,
          shortId: payment.plannedEvaluationId.replace(/-/g, "").slice(0, 8),
          isPublic: payment.tasks.every((t) => t.isPublic),
          modelRelease: isNonEmptyString(body.modelRelease) ? body.modelRelease.trim() : null,
          modelApiKeyEnc,
          agentCommit: quotedVersion?.commitSha ?? "unknown",
        });
      } catch (e) {
        if (e instanceof EvaluationConflictError) {
          res.status(409).json({ error: e.message });
          return;
        }
        throw e;
      }
      res.status(created.created ? 202 : 200).json({
        evaluationId: created.evaluationId,
        status: created.created ? "pending" : "existing",
        txSig: verified.txSig,
        runs: created.runIds.map((runId, i) => ({ runId, taskId: payment!.tasks[i]?.taskId, seq: i + 1 })),
      });
    }),
  );

  router.get(
    "/evaluations",
    requireWallet,
    handle(async (req, res) => {
      const wallet = req.wallet!;
      const raw = typeof req.query.scope === "string" ? req.query.scope : "all";
      const scope = raw === "mine" ? "all" : raw === "mine-agents" ? "my_agents" : raw === "other-agents" ? "others" : raw;
      if (!["all", "my_agents", "others"].includes(scope)) {
        res.status(400).json({ error: "scope must be all | my_agents | others" });
        return;
      }
      const rows = await store.listForWallet(wallet, LIST_LIMIT);
      const isMine = (e: EvaluationListRow) => e.agentOwnerWallet === wallet;
      const filtered = rows.filter((e) => scope === "all" || (scope === "my_agents" ? isMine(e) : !isMine(e)));
      const spentLamports = rows.reduce((a, e) => a + e.feeLamports, 0);
      res.json({
        evaluations: filtered.map((e) => ({
          id: e.id,
          shortId: e.shortId,
          slug: e.slug,
          agent: {
            id: e.agentId,
            name: e.agentName,
            slug: e.agentSlug,
            initials: initialsOf(e.agentName),
            // "by {author}": the owner's profile name, else a short wallet. The UI shows "you" for isMine.
            authorName: e.agentAuthorName ?? (e.agentOwnerWallet ? `${e.agentOwnerWallet.slice(0, 4)}…${e.agentOwnerWallet.slice(-4)}` : "unknown"),
            isMine: isMine(e),
          },
          createdAt: e.createdAt,
          feeLamports: e.feeLamports,
          feeSol: lamportsToSol(e.feeLamports),
          feeUsd: e.feeUsd,
          tasks: e.tasks.map((t) => ({ id: t.taskId, slug: t.slug, name: t.name })),
          counts: { pass: e.passCount, fail: e.failCount, invalid: e.invalidCount },
          score: e.score,
          status: e.status,
          share: shareOf(e, config.webBaseUrl),
        })),
        totals: {
          spentLamports,
          spentSol: lamportsToSol(spentLamports),
          usd: round4(rows.reduce((a, e) => a + e.feeUsd, 0)),
          counts: { all: rows.length, myAgents: rows.filter(isMine).length, others: rows.filter((e) => !isMine(e)).length },
        },
      });
    }),
  );

  router.get(
    "/evaluations/:id",
    requireWallet,
    handle(async (req, res) => {
      const id = String(req.params.id);
      const ev = UUID_RE.test(id) ? await store.getEvaluation(id) : null;
      if (!ev || ev.ownerWallet !== req.wallet) {
        res.status(404).json({ error: "evaluation not found" });
        return;
      }
      const [runs, agent, version] = await Promise.all([store.listRuns(ev.id), store.getAgent(ev.agentId), store.getAgentVersion(ev.agentVersionId)]);
      const proofs = await store.listProofs(runs.map((r) => r.id));
      const { view } = rollup({
        evaluation: ev,
        runs,
        proofs,
        agent: { name: agent?.name ?? "agent", slug: agent?.slug ?? null, repoFullName: agent?.repoFullName ?? null },
        agentCommit: version?.commitSha ?? null,
        nowMs: now(),
      });
      res.json({ ...view, shareUrl: view.status === "issued" && view.isPublic && view.slug ? `${config.webBaseUrl}/e/${view.slug}` : null });
    }),
  );

  router.post(
    "/evaluations/:id/cancel",
    requireWallet,
    handle(async (req, res) => {
      const id = String(req.params.id);
      const ev = UUID_RE.test(id) ? await store.getEvaluation(id) : null;
      if (!ev || ev.ownerWallet !== req.wallet) {
        res.status(404).json({ error: "evaluation not found" });
        return;
      }
      if (ev.status === "issued" || ev.status === "failed") {
        res.status(409).json({ error: `evaluation is ${ev.status}; nothing to cancel` });
        return;
      }
      const cancelledRuns = await store.cancel(ev.id);
      res.json({ evaluationId: ev.id, status: "cancelled", cancelledRuns, refund: null });
    }),
  );

  return router;
}

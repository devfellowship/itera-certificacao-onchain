import { randomUUID } from "node:crypto";
import type { RunCostEstimator } from "../../evaluations/estimate.js";
import { priceRun } from "../../evaluations/estimate.js";
import { lamportsToSol, round4, usdToLamports, type EvaluationsConfig } from "../../evaluations/config.js";
import { buildEvaluationMemo } from "../../evaluations/memo.js";
import type { SolUsdProvider } from "../../evaluations/price.js";
import { EvaluationConflictError, type EvalTask, type EvaluationsStore, type PaymentRecord } from "../../evaluations/store.js";
import { sealModelApiKey } from "./model-key.js";
import type { PaymentGateway } from "./solana-pay-gateway.js";
import type { AfterGradedContext, PaymentAdapter, PaymentOutcome } from "./types.js";

/**
 * The `solana_pay` payment adapter (web3 client, SIWS principal). It holds today's paid path
 * without a behaviour change (ADR-6): the same responses, status codes and error bodies.
 *
 *   quote        price N runs in SOL (Pyth → CoinGecko), the Memo, the Solana Pay transfer URL
 *   transaction  the unsigned payment tx for the wallet (1 prompt)
 *   settle       verify the payment (Solana Pay) → queue N runs
 *   afterGraded  issue the proof of each graded run
 */
export interface SolanaPayAdapterDeps {
  store: EvaluationsStore;
  config: EvaluationsConfig;
  price: SolUsdProvider;
  payments: PaymentGateway;
  estimate?: RunCostEstimator;
  runKeySecret?: string;
  now: () => number;
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;

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

/** The web3 path ends with a proof for each graded run (ITERA pays the issuance). Needs no deps,
 * so the issuer calls it without the route deps. */
export async function solanaPayAfterGraded(ctx: AfterGradedContext): Promise<void> {
  await ctx.issueProof();
}

const out = (status: number, body: unknown): PaymentOutcome => ({ status, body });

export function createSolanaPayAdapter(deps: SolanaPayAdapterDeps): PaymentAdapter {
  const { store, config, now } = deps;

  return {
    kind: "solana_pay",

    quoteGate() {
      if (!config.treasury) return out(503, { error: "payments are not configured on this server (ITERA_TREASURY_ADDRESS)" });
      return null;
    },

    async quote({ principalId: wallet, agent, version, tasks }) {
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
        treasury: config.treasury!,
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
      return out(201, quoteView(payment, transferUrl));
    },

    async transaction({ principalId: wallet, reference, body }) {
      const payment = BASE58_RE.test(reference) ? await store.getPaymentByReference(reference) : null;
      if (!payment || payment.payerWallet !== wallet) return out(404, { error: "quote not found" });
      if (payment.evaluationId) return out(409, { error: "this quote is already paid", evaluationId: payment.evaluationId });
      if (now() > Date.parse(payment.quoteExpiresAt)) return out(402, { error: "quote expired", code: "quote_expired" });
      const account = (body as { account?: unknown } | undefined)?.account ?? wallet;
      if (!isNonEmptyString(account) || !BASE58_RE.test(account)) return out(400, { error: "account must be a base58 public key" });
      try {
        const transaction = await deps.payments.buildTransferTx(account, {
          recipient: payment.treasury,
          lamports: payment.amountLamports,
          reference: payment.reference,
          memo: payment.memo,
        });
        return out(200, { transaction, memo: payment.memo, expiresAt: payment.quoteExpiresAt });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // createTransfer checks the payer: "sender not found" / "insufficient funds".
        return out(/insufficient|not found/i.test(message) ? 402 : 502, { error: message, code: /insufficient/i.test(message) ? "insufficient_funds" : "build_failed" });
      }
    },

    async settle({ principalId: wallet, body: rawBody }) {
      const body = (rawBody ?? {}) as { reference?: unknown; txSig?: unknown; modelApiKey?: unknown; modelRelease?: unknown };
      const txSig = isNonEmptyString(body.txSig) ? body.txSig.trim() : null;
      if (txSig && !BASE58_RE.test(txSig)) return out(400, { error: "txSig must be a base58 signature" });
      let payment: PaymentRecord | null = null;
      if (isNonEmptyString(body.reference)) payment = await store.getPaymentByReference(body.reference.trim());
      else if (txSig) payment = await store.getPaymentByTxSig(txSig);
      else return out(400, { error: "reference (from POST /evaluations/quote) is required" });
      if (!payment) return out(404, { error: "quote not found" });
      if (payment.payerWallet !== wallet) return out(403, { error: "this quote belongs to another wallet" });
      // Idempotent on the payment (and so on txSig): the same evaluation, never a second one.
      if (payment.evaluationId) {
        if (txSig && payment.txSig && txSig !== payment.txSig) {
          return out(409, { error: "this quote was paid by another transaction", evaluationId: payment.evaluationId });
        }
        const paid = payment;
        return out(200, { evaluationId: paid.evaluationId, status: "existing", txSig: paid.txSig, runs: paid.plannedRunIds.map((runId, i) => ({ runId, taskId: paid.tasks[i]?.taskId, seq: i + 1 })) });
      }
      if (txSig) {
        const other = await store.getPaymentByTxSig(txSig);
        if (other && other.id !== payment.id) return out(409, { error: "this transaction already paid another quote" });
      }

      // Gate Q2 = B: TestMyAgent pays the tokens. BYOK stays optional in the API only.
      const sealed = sealModelApiKey(body.modelApiKey, deps.runKeySecret);
      if (!sealed.ok) return sealed.outcome;
      const modelApiKeyEnc = sealed.modelApiKeyEnc;

      const expiresMs = Date.parse(payment.quoteExpiresAt) + config.quoteGraceMs;
      const fields = { recipient: payment.treasury, lamports: payment.amountLamports, reference: payment.reference, memo: payment.memo };
      const verified = await deps.payments.verify(fields, txSig);
      if (!verified.ok) {
        if (verified.code === "not_found") {
          if (now() > expiresMs) return out(402, { error: "quote expired", code: "quote_expired" });
          return out(402, { error: `payment not found or not confirmed yet: ${verified.message}`, code: "payment_not_found" });
        }
        return out(402, { error: verified.message, code: /amount not transferred/.test(verified.message) ? "wrong_amount" : "payment_invalid" });
      }
      if (verified.blockTimeMs !== null && verified.blockTimeMs > expiresMs) {
        return out(402, { error: "quote expired: the transfer landed after the quote window", code: "quote_expired", txSig: verified.txSig });
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
        if (e instanceof EvaluationConflictError) return out(409, { error: e.message });
        throw e;
      }
      const paid = payment;
      return out(created.created ? 202 : 200, {
        evaluationId: created.evaluationId,
        status: created.created ? "pending" : "existing",
        txSig: verified.txSig,
        runs: created.runIds.map((runId, i) => ({ runId, taskId: paid.tasks[i]?.taskId, seq: i + 1 })),
      });
    },

    afterGraded: solanaPayAfterGraded,
  };
}

/**
 * Evaluations v2 (plan 20261012-itera-testmyagent-ui-refactor, ADR-1, ADR-2, Gate Q1/Q2):
 *
 *   POST /evaluations/quote                          price N runs in SOL (Pyth → CoinGecko), 120 s
 *   POST /evaluations/quote/:reference/transaction   the unsigned payment tx for the wallet (1 prompt)
 *   POST /evaluations                                verify the payment (Solana Pay) → queue N runs;
 *                                                    a DFL principal: the free BYOK path → queue N runs
 *   GET  /evaluations?scope=all|my_agents|others     My evaluations
 *   GET  /evaluations/:id                            roll-up (uiState, stages, tasks, events, proofs)
 *   POST /evaluations/:id/cancel                     queued runs → cancelled; no refund (Gate Q1)
 *
 * One wallet prompt per evaluation: the payment tx carries the transfer (with the Solana Pay
 * reference) and the Memo `itera-eval:v1:{evaluation_id, run_ids, …}`. Its signature is every
 * run's run_start_sig. TestMyAgent pays the model tokens (Gate Q2) and the proof issuance.
 *
 * Payment adapter seam (plan 20261015-testmyagent-web2-client, ADR-6): the quote, the payment
 * transaction and the settle step belong to the payment adapter of the caller's principal kind
 * (`siws` → `solana_pay`, `dfl` → `free_byok`). This router keeps the shared work. See
 * `payments/adapters/`.
 *
 * The legacy vendor flow also answers `POST /evaluations` (body with `idempotencyKey`): such a body
 * falls through to it.
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { requireWallet } from "../http/auth.js";
import { createPaymentAdapters, paymentAdapterFor, type PaymentOutcome } from "../payments/adapters/index.js";
import type { ModelKeyProbe } from "../payments/adapters/free-byok.js";
import type { PriceLookup } from "../domain/model-prices.js";
import type { PlatformKeyConfig } from "../models/platform-key.js";
import type { PaymentGateway } from "../payments/adapters/solana-pay-gateway.js";
import { lamportsToSol, round4, type EvaluationsConfig } from "./config.js";
import type { RunCostEstimator } from "./estimate.js";
import { PriceUnavailableError, type SolUsdProvider } from "./price.js";
import { parseEvaluationRequest, resolveEvaluationRequest } from "./resolve.js";
import { initialsOf, rollup } from "./rollup.js";
import type { EvaluationListRow, EvaluationsStore } from "./store.js";

export interface EvaluationsRouterDeps {
  store: EvaluationsStore;
  config: EvaluationsConfig;
  price: SolUsdProvider;
  payments: PaymentGateway;
  /** Forecast model cost of one run. Absent → every run is priced at the fallback. */
  estimate?: RunCostEstimator;
  /** ITERA_RUN_KEY_SECRET — the BYOK key (optional on solana_pay, required on free_byok). */
  runKeySecret?: string;
  /** The free path's model key probe (T8: the OpenRouter `GET /key` check). Default: format only. */
  probeModelKey?: ModelKeyProbe;
  /** ADR-5 platform-key allowance of the free path. Default: off. */
  platformKey?: PlatformKeyConfig;
  /** OpenRouter list prices, for the platform path's low-cost model rule. */
  modelPrice?: PriceLookup;
  now?: () => number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_LIMIT = 200;

function shareOf(e: EvaluationListRow, webBaseUrl: string) {
  if (e.status !== "issued" || !e.slug) return { kind: "none" as const, url: null };
  if (!e.isPublic) return { kind: "private" as const, url: null };
  return { kind: "link" as const, url: `${webBaseUrl}/e/${e.slug}` };
}

export function createEvaluationsV2Router(deps: EvaluationsRouterDeps): Router {
  const { store, config } = deps;
  const now = deps.now ?? Date.now;
  const router = Router();
  // ADR-6: the payment adapter follows the principal kind (siws → solana_pay, dfl → free_byok).
  const adapters = createPaymentAdapters({ ...deps, now });
  const adapterOf = (req: Request) => paymentAdapterFor(adapters, req.principal!.kind);
  const send = (res: Response, o: PaymentOutcome) => {
    if (o.headers) res.set(o.headers);
    res.status(o.status).json(o.body);
  };

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
      const parsed = parseEvaluationRequest(req.body, config);
      if (!parsed.ok) {
        send(res, parsed.outcome);
        return;
      }
      const adapter = adapterOf(req);
      const gate = adapter.quoteGate();
      if (gate) {
        send(res, gate);
        return;
      }
      const resolved = await resolveEvaluationRequest(store, config, wallet, parsed);
      if (!resolved.ok) {
        send(res, resolved.outcome);
        return;
      }
      const { agent, version, tasks } = resolved;
      send(res, await adapter.quote({ principalId: wallet, agent, version, tasks }));
    }),
  );

  router.post(
    "/evaluations/quote/:reference/transaction",
    requireWallet,
    handle(async (req, res) => {
      send(res, await adapterOf(req).transaction({ principalId: req.wallet!, reference: String(req.params.reference), body: req.body }));
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
      send(res, await adapterOf(req).settle({ principalId: wallet, body: req.body }));
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
            // U36: the profile middleware adds authorProfile (username, picture) from this wallet.
            authorWallet: e.agentOwnerWallet ?? null,
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
        agent: { name: agent?.name ?? "agent", slug: agent?.slug ?? null, repoFullName: agent?.repoFullName ?? null, ownerWallet: agent?.ownerWallet ?? null },
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
      if (ev.status === "issued" || ev.status === "graded" || ev.status === "failed") {
        res.status(409).json({ error: `evaluation is ${ev.status}; nothing to cancel` });
        return;
      }
      const cancelledRuns = await store.cancel(ev.id);
      res.json({ evaluationId: ev.id, status: "cancelled", cancelledRuns, refund: null });
    }),
  );

  return router;
}

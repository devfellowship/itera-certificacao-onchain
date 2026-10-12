import { Router, type RequestHandler } from "express";
import { computeRanking, type RankingStore } from "../domain/agent-ranking.js";
import { PgRankingStore } from "../domain/agent-ranking-store.pg.js";
import { getPool } from "../domain/pool.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { CoinGeckoSolPriceSource, runPriceUsd, type SolPriceSource } from "../domain/sol-price.js";
import { requireWallet as defaultRequireWallet } from "./auth.js";

/**
 * GET /agents/ranking?scope=all|mine&q=&taskIds=a,b&tag=   wallet — rows of screen 01 (U8)
 *
 * Mount BEFORE the GitHub router: its `GET /agents/:id` would otherwise take "ranking" as an id.
 *
 * Response: {rows:[{rank, id, slug, name, initials, authorName, authorWallet, isMine, when,
 * description, model, modelLabel, draft, visibility, score, taskCount, coverage:{k,n,perTask}|null,
 * runCostUsd, runCostLamports, runCostSol}], counts:{all, mine}, selection:{taskIds, tag},
 * price:{usdPerRun, solUsdRate, priceSource, at}}.
 */
export interface AgentsRankingRouterDeps {
  store: RankingStore;
  price: SolPriceSource;
  priceUsdPerRun: () => number;
  requireWallet: RequestHandler;
}

export function defaultAgentsRankingRouterDeps(): AgentsRankingRouterDeps {
  return {
    store: new PgRankingStore(getPool),
    price: new CoinGeckoSolPriceSource(),
    priceUsdPerRun: () => runPriceUsd(),
    requireWallet: defaultRequireWallet,
  };
}

const MAX_TASK_IDS = 50;
const TASK_ID_RE = /^[A-Za-z0-9._:@/-]{1,100}$/;
const TAG_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export function createAgentsRankingRouter(deps: AgentsRankingRouterDeps): Router {
  const router = Router();

  router.get("/agents/ranking", deps.requireWallet, async (req, res) => {
    try {
      const callerWallet = req.wallet;
      if (!callerWallet) {
        res.status(401).json({ error: "a valid wallet session is required" });
        return;
      }
      const scope = req.query.scope === undefined || req.query.scope === "all" ? "all" : req.query.scope === "mine" ? "mine" : null;
      if (!scope) {
        res.status(400).json({ error: "scope must be all or mine" });
        return;
      }
      const q = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : "";
      const rawIds = typeof req.query.taskIds === "string" ? req.query.taskIds : "";
      const taskIds = rawIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (taskIds.length > MAX_TASK_IDS || taskIds.some((id) => !TASK_ID_RE.test(id))) {
        res.status(400).json({ error: `taskIds must be at most ${MAX_TASK_IDS} comma-separated task ids or slugs` });
        return;
      }
      const tag = typeof req.query.tag === "string" && req.query.tag ? req.query.tag : null;
      if (tag !== null) {
        if (!TAG_RE.test(tag)) {
          res.status(400).json({ error: "tag must be a tag id" });
          return;
        }
        const tagged = await deps.store.taskIdsForTag(tag, callerWallet);
        if (tagged === null) {
          res.status(503).json({ error: "the tag filter needs the catalog tables (tasks, task_tags) to be migrated" });
          return;
        }
        // A tag adds its tasks to the selection (the Task Filter's tag single-select).
        for (const id of tagged) if (!taskIds.includes(id)) taskIds.push(id);
      }

      const [data, rate] = await Promise.all([deps.store.load(callerWallet), taskIds.length > 0 ? deps.price.solUsd() : Promise.resolve(null)]);
      const usdPerRun = deps.priceUsdPerRun();
      const out = computeRanking({ callerWallet, data, scope, q, taskIds, priceUsdPerRun: usdPerRun, solUsdRate: rate?.rate ?? null });
      res.json({
        rows: out.rows,
        counts: out.counts,
        selection: { taskIds, tag },
        price: { usdPerRun, solUsdRate: rate?.rate ?? null, priceSource: rate?.source ?? null, at: rate?.at ?? null, indicative: true },
      });
    } catch (e) {
      if (e instanceof SchemaNotReadyError) {
        res.status(503).json({ error: e.message });
        return;
      }
      console.error("agents-ranking error", e);
      res.status(500).json({ error: "internal error" });
    }
  });

  return router;
}

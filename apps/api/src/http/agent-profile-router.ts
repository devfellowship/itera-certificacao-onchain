import { Router, type RequestHandler, type Response } from "express";
import { agentBadge, buildMyResults, buildProfile, hasPublicProfile, type ProfileAgent, type ProfileData, type ProfileStore } from "../domain/agent-profile.js";
import { PgProfileStore } from "../domain/agent-profile-store.pg.js";
import { getPool } from "../domain/pool.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { CoinGeckoSolPriceSource, lamportsToSol, runPriceUsd, type SolPriceSource, usdToLamports } from "../domain/sol-price.js";
import { optionalWallet as defaultOptionalWallet, requireWallet as defaultRequireWallet } from "./auth.js";
import { renderBadge, renderNotFoundBadge } from "./badge.js";

/**
 * Agent profile (screen 08, U15) and README badge (U16).
 *
 *   GET /agents/:idOrSlug/profile     optional wallet — public profile of a listed agent with issued evidence;
 *                                     its owner also sees it before that (empty states). 404 otherwise, one body.
 *   GET /agents/:idOrSlug/my-results  wallet — this agent's results on the caller's own user tasks, plus the
 *                                     caller's best own agent per task. Never exposes another wallet's task.
 *   GET /badge/agents/:file           none — `<idOrSlug>.svg`, image/svg+xml, cached 5 min
 *   GET /badge/evaluations/:file      none — `<slug>.svg` of a public issued evaluation
 *   GET /b/:file                      none — alias of /badge/evaluations (the snippet of screen 05)
 *
 * Mount before the GitHub router so that no `/agents/:id` pattern there can swallow these paths.
 */
export interface AgentProfileRouterDeps {
  store: ProfileStore;
  price: SolPriceSource;
  priceUsdPerRun: () => number;
  requireWallet: RequestHandler;
  optionalWallet: RequestHandler;
}

export function defaultAgentProfileRouterDeps(): AgentProfileRouterDeps {
  return {
    store: new PgProfileStore(getPool),
    price: new CoinGeckoSolPriceSource(),
    priceUsdPerRun: () => runPriceUsd(),
    requireWallet: defaultRequireWallet,
    optionalWallet: defaultOptionalWallet,
  };
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const BADGE_CACHE_SECONDS = 300;

function sendSvg(res: Response, status: number, svg: string, cacheSeconds: number): void {
  res
    .status(status)
    .set({
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`,
      "X-Content-Type-Options": "nosniff",
      // The SVG has no script and no external reference; this keeps it so if it is ever opened on its own.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Cross-Origin-Resource-Policy": "cross-origin",
    })
    .send(svg);
}

/** `<key>.svg` → key, or null. */
function badgeKey(file: unknown): string | null {
  if (typeof file !== "string" || !file.endsWith(".svg")) return null;
  const key = file.slice(0, -4);
  return KEY_RE.test(key) ? key : null;
}

export function createAgentProfileRouter(deps: AgentProfileRouterDeps): Router {
  const router = Router();
  const notFound = (res: Response) => res.status(404).json({ error: "not found" });

  /** The agent when `viewer` may see it: its owner always, anyone else when it has a public profile. */
  async function visibleAgent(idOrSlug: string, viewer: string | null): Promise<{ agent: ProfileAgent; data: ProfileData } | null> {
    if (!KEY_RE.test(idOrSlug)) return null;
    const agent = await deps.store.findAgent(idOrSlug);
    if (!agent) return null;
    const data = await deps.store.load(agent.id);
    if (agent.ownerWallet === viewer || hasPublicProfile(agent, data)) return { agent, data };
    return null;
  }

  function failure(res: Response, e: unknown, what: string): void {
    if (e instanceof SchemaNotReadyError) {
      res.status(503).json({ error: e.message });
      return;
    }
    console.error(`${what} error`, e);
    res.status(500).json({ error: "internal error" });
  }

  router.get("/agents/:idOrSlug/profile", deps.optionalWallet, async (req, res) => {
    try {
      const viewer = req.wallet ?? null;
      const found = await visibleAgent(String(req.params.idOrSlug), viewer);
      if (!found) return void notFound(res);
      const profile = buildProfile({ agent: found.agent, data: found.data, viewerWallet: viewer });
      // The run price of the "Run … on your tasks" card: the base fee per task, in USD and SOL.
      const usdPerRun = deps.priceUsdPerRun();
      const rate = await deps.price.solUsd().catch(() => null);
      const lamports = rate ? usdToLamports(usdPerRun, rate.rate) : null;
      res.set("Cache-Control", "private, no-store").json({
        ...profile,
        price: { usdPerRun, solUsdRate: rate?.rate ?? null, priceSource: rate?.source ?? null, runCostLamports: lamports, runCostSol: lamports === null ? null : lamportsToSol(lamports), indicative: true },
      });
    } catch (e) {
      failure(res, e, "agent-profile");
    }
  });

  router.get("/agents/:idOrSlug/my-results", deps.requireWallet, async (req, res) => {
    try {
      const viewer = req.wallet;
      if (!viewer) return void res.status(401).json({ error: "a valid wallet session is required" });
      const found = await visibleAgent(String(req.params.idOrSlug), viewer);
      if (!found) return void notFound(res);
      const own = await deps.store.loadOwnTaskResults(viewer);
      res.set("Cache-Control", "private, no-store").json({ results: buildMyResults(found.agent.id, viewer, own) });
    } catch (e) {
      failure(res, e, "agent-my-results");
    }
  });

  router.get("/badge/agents/:file", async (req, res) => {
    try {
      const key = badgeKey(req.params.file);
      const agent = key ? await deps.store.findAgent(key) : null;
      const badge = agent ? agentBadge(agent, await deps.store.load(agent.id)) : null;
      if (!badge) return void sendSvg(res, 404, renderNotFoundBadge(), 60);
      sendSvg(res, 200, renderBadge(badge.score, badge.taskCount), BADGE_CACHE_SECONDS);
    } catch (e) {
      console.error("badge error", e);
      sendSvg(res, 503, renderNotFoundBadge(), 30);
    }
  });

  const evaluationBadge: RequestHandler = async (req, res) => {
    try {
      const key = badgeKey(req.params.file);
      const ev = key ? await deps.store.findPublicEvaluation(key) : null;
      if (!ev) return void sendSvg(res, 404, renderNotFoundBadge(), 60);
      sendSvg(res, 200, renderBadge(ev.score === null ? null : Math.round(ev.score * 10) / 10, ev.taskCount), BADGE_CACHE_SECONDS);
    } catch (e) {
      console.error("badge error", e);
      sendSvg(res, 503, renderNotFoundBadge(), 30);
    }
  };
  router.get("/badge/evaluations/:file", evaluationBadge);
  router.get("/b/:file", evaluationBadge);

  return router;
}

/**
 * Public evaluation profile (screen 05, U14; plan 20261012-itera-testmyagent-ui-refactor, ADR-6/7):
 *
 *   GET /public/evaluations/:slugOrHash               the profile JSON (no auth)
 *   GET /public/evaluations/:slugOrHash/manifest.json the evaluation manifest + per-run proofs
 *   GET /public/evaluations/:slugOrHash/og.png        the 1200×630 link-preview image
 *
 * Unknown and private keys answer the same generic 404, so the route never reveals that a private
 * evaluation exists. CORS is `*` (read-only, public data; crawlers and the web server fetch these).
 */
import { Router, type Request, type Response } from "express";
import { PUBLIC_API_BASE_URL, PUBLIC_WEB_BASE_URL } from "../chain/config.js";
import { renderOgPng } from "../chain/nft-image.js";
import { buildManifestDownload, buildPublicProfile, type PublicProfile } from "./profile.js";
import type { ProfileSource, PublicProfilesStore } from "./store.js";

const KEY_RE = /^[A-Za-z0-9-]{3,100}$/;
const NOT_FOUND = { error: "not found" };

export interface PublicRouterDeps {
  store: PublicProfilesStore;
  webBaseUrl?: string;
  apiBaseUrl?: string;
  /** Max PNGs kept in memory (LRU). */
  ogCacheSize?: number;
}

export function ogSummary(p: PublicProfile): string {
  const n = p.tasks.length;
  return `${p.counts.pass} of ${n} task${n === 1 ? "" : "s"} PASS · ${p.agent.modelLabel}`;
}

export function createPublicRouter(deps: PublicRouterDeps): Router {
  const links = { webBaseUrl: deps.webBaseUrl ?? PUBLIC_WEB_BASE_URL, apiBaseUrl: deps.apiBaseUrl ?? PUBLIC_API_BASE_URL };
  const cacheSize = deps.ogCacheSize ?? 200;
  const ogCache = new Map<string, Buffer>();
  const router = Router();

  const load = async (req: Request, res: Response): Promise<{ src: ProfileSource; profile: PublicProfile } | null> => {
    res.set("Access-Control-Allow-Origin", "*");
    const key = String(req.params.key ?? "");
    if (!KEY_RE.test(key)) {
      res.status(404).json(NOT_FOUND);
      return null;
    }
    const src = await deps.store.load(key);
    if (!src) {
      res.status(404).json(NOT_FOUND);
      return null;
    }
    return { src, profile: buildPublicProfile(src, links) };
  };

  const fail = (res: Response, e: unknown) => {
    console.error(JSON.stringify({ event: "public_profile_error", error: e instanceof Error ? e.message : String(e) }));
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  };

  router.get("/public/evaluations/:key", async (req, res) => {
    try {
      const r = await load(req, res);
      if (!r) return;
      res.set("Cache-Control", "public, max-age=60");
      res.json(r.profile);
    } catch (e) {
      fail(res, e);
    }
  });

  router.get("/public/evaluations/:key/manifest.json", async (req, res) => {
    try {
      const r = await load(req, res);
      if (!r) return;
      res.set("Cache-Control", "public, max-age=300");
      res.set("Content-Disposition", `attachment; filename="testmyagent-${r.profile.slug.slice(0, 40)}-manifest.json"`);
      res.type("application/json").send(JSON.stringify(buildManifestDownload(r.src, r.profile), null, 2));
    } catch (e) {
      fail(res, e);
    }
  });

  router.get("/public/evaluations/:key/og.png", async (req, res) => {
    try {
      const r = await load(req, res);
      if (!r) return;
      const p = r.profile;
      const cacheKey = `${p.hash}:${p.record.status}:${p.score}`;
      let png = ogCache.get(cacheKey);
      if (png) {
        ogCache.delete(cacheKey);
      } else {
        png = renderOgPng({
          agent: p.agent.name,
          summary: ogSummary(p),
          score: p.score,
          status: p.record.status === "Confirmed" ? "Verified onchain" : "Pending onchain",
          url: p.url.replace(/^https?:\/\//, ""),
          hash: p.hash ? `${p.hash.slice(0, 8)}…${p.hash.slice(-8)}` : "",
        });
      }
      ogCache.set(cacheKey, png);
      while (ogCache.size > cacheSize) ogCache.delete(ogCache.keys().next().value!);
      res.set("Cache-Control", "public, max-age=3600");
      res.type("image/png").send(png);
    } catch (e) {
      fail(res, e);
    }
  });

  return router;
}

/**
 * Public task profile (U30, plan 20261012-itera-testmyagent-ui-refactor, ADR-11):
 *
 *   GET /public/tasks/:slug?v=N             the profile JSON (no auth)
 *   GET /public/tasks/:slug/schemas.json    the pinned list_tools schemas of the version
 *
 * Only a catalog task has a page. Unknown, private and user tasks answer the same generic 404, so
 * the route never reveals that a private task exists. CORS is `*` (read-only public data; the web
 * server and crawlers fetch it).
 */
import { Router, type Request, type Response } from "express";
import { PUBLIC_API_BASE_URL, PUBLIC_WEB_BASE_URL } from "../chain/config.js";
import { reputationOf, type ReputationStore } from "../domain/reputation-store.js";
import { buildTaskProfile, schemasDownload, type TaskProfile } from "./task-profile.js";
import type { PublicTaskStore } from "./task-store.js";

const KEY_RE = /^[A-Za-z0-9._-]{1,100}$/;
const NOT_FOUND = { error: "not found" };

export interface PublicTaskRouterDeps {
  store: PublicTaskStore;
  reputation?: ReputationStore;
  /** Per-run model cost cap shown under Limits (ITERA_RUN_MAX_COST_USD). */
  costCapUsd: number;
  /** The flat fee per run shown on the CTA card. */
  runFeeUsd: number;
  webBaseUrl?: string;
  apiBaseUrl?: string;
}

function isMissingSchema(e: unknown): boolean {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
  return code === "42P01" || code === "42703";
}

export function createPublicTaskRouter(deps: PublicTaskRouterDeps): Router {
  const links = { webBaseUrl: deps.webBaseUrl ?? PUBLIC_WEB_BASE_URL, apiBaseUrl: deps.apiBaseUrl ?? PUBLIC_API_BASE_URL };
  const router = Router();

  const load = async (req: Request, res: Response): Promise<TaskProfile | null> => {
    res.set("Access-Control-Allow-Origin", "*");
    const key = String(req.params.slug ?? "");
    const vq = typeof req.query.v === "string" ? req.query.v : undefined;
    const version = vq !== undefined && /^[1-9][0-9]{0,5}$/.test(vq) ? Number(vq) : undefined;
    if (!KEY_RE.test(key) || (vq !== undefined && version === undefined)) {
      res.status(404).json(NOT_FOUND);
      return null;
    }
    const src = await deps.store.loadTask(key);
    if (!src || (version !== undefined && !src.versions.some((v) => v.version === version))) {
      res.status(404).json(NOT_FOUND);
      return null;
    }
    // Results and reputation are best effort: a page still renders when 0008/0010 are missing.
    const [results, reputation] = await Promise.all([
      deps.store.loadResults(src.task.id).catch((e: unknown) => {
        if (isMissingSchema(e)) return [];
        throw e;
      }),
      deps.reputation
        ? reputationOf(deps.reputation, [src.task.id])
            .then((m) => {
              const r = m.get(src.task.id);
              if (!r) return null;
              const { taskId: _t, slug: _s, ownerWallet: _o, ...view } = r;
              return view;
            })
            .catch((e: unknown) => {
              if (isMissingSchema(e)) return null;
              throw e;
            })
        : Promise.resolve(null),
    ]);
    return buildTaskProfile(src, { version, results, reputation, costCapUsd: deps.costCapUsd, runFeeUsd: deps.runFeeUsd, links });
  };

  const fail = (res: Response, e: unknown) => {
    console.error(JSON.stringify({ event: "public_task_error", error: e instanceof Error ? e.message : String(e) }));
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  };

  router.get("/public/tasks/:slug", async (req, res) => {
    try {
      const p = await load(req, res);
      if (!p) return;
      res.set("Cache-Control", "public, max-age=60");
      res.json(p);
    } catch (e) {
      fail(res, e);
    }
  });

  router.get("/public/tasks/:slug/schemas.json", async (req, res) => {
    try {
      const p = await load(req, res);
      if (!p) return;
      res.set("Cache-Control", "public, max-age=300");
      res.set("Content-Disposition", `attachment; filename="testmyagent-${p.slug.slice(0, 40)}-v${p.version.number}-schemas.json"`);
      res.type("application/json").send(JSON.stringify(schemasDownload(p), null, 2));
    } catch (e) {
      fail(res, e);
    }
  });

  return router;
}

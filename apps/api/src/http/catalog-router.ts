import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import {
  HandleTakenError,
  type CatalogModel,
  type CatalogStore,
  type CatalogTask,
  type Profile,
  type Tag,
} from "../domain/catalog-store.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { AGENT_MODELS, DEFAULT_AGENT_MODEL } from "../github/models.js";
import { optionalWallet, requireWallet } from "./auth.js";

/**
 * Catalog routes (U5, plan 20261012-itera-testmyagent-ui-refactor). Tables: 0007_catalog.sql.
 *
 *   GET   /tasks?source=all|curated|public|mine&tag=&kind=itera|user&runnable=true|false&q=   optional auth
 *   GET   /tasks/:idOrSlug                                                                 optional auth
 *   GET   /tags?kind=tool|concept                                                          optional auth
 *   GET   /models?all=1                                                                    public
 *   GET   /me                                                                              wallet
 *   PATCH /me {displayName?, handle?}                                                      wallet
 *
 * Private tasks of other wallets are never returned (a 404 hides them). `counts` is computed on the
 * caller's full visible catalog, before filters (Task Filter design: source counts stay stable).
 *
 * GET /models keeps the fields of the static response (`default`, `models[].id`, `models[].label`)
 * so the running web keeps working. When 0007 is not applied it answers the static list.
 */

const handle =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((e: unknown) => {
      if (e instanceof SchemaNotReadyError) {
        res.status(503).json({ error: e.message });
        return;
      }
      next(e);
    });
  };

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

function taskJson(t: CatalogTask, wallet: string | null) {
  const mine = wallet !== null && t.ownerWallet === wallet;
  const v = t.latest;
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    tags: t.tags.map((g) => ({ id: g.id, name: g.name, kind: g.kind })),
    kind: t.kind,
    source: v?.source ?? null,
    visibility: t.visibility,
    status: t.status,
    runnable: v?.runnable ?? false,
    hiddenTestsCount: v?.hiddenTestsCount ?? null,
    estMinutes: t.estMinutes,
    labels: v?.labels ?? [],
    version: v?.version ?? null,
    mine,
    agentsRunCount: t.agentsRunCount,
  };
}

function taskDetailJson(t: CatalogTask, wallet: string | null) {
  const mine = wallet !== null && t.ownerWallet === wallet;
  const v = t.latest;
  return {
    ...taskJson(t, wallet),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    latestVersion: v && {
      id: v.id,
      version: v.version,
      source: v.source,
      labels: v.labels,
      runnable: v.runnable,
      hiddenTestsCount: v.hiddenTestsCount,
      fixtureDigest: v.fixtureDigest,
      hiddenDigest: v.hiddenDigest,
      validatedAt: v.validatedAt,
      createdAt: v.createdAt,
      ...(v.source === "curated" ? { packId: v.packId, packVersion: v.packVersion } : {}),
      // The repo pin is the owner's business; others only see the digests.
      ...(v.source === "github" && mine
        ? { github: { installationId: v.installationId, repo: v.repoFullName, branch: v.branch, commitSha: v.commitSha, path: v.repoPath } }
        : {}),
    },
  };
}

function matchesSearch(t: CatalogTask, q: string): boolean {
  const needle = q.toLowerCase();
  return [t.name, t.slug, t.id, t.description, ...t.tags.map((g) => g.name), ...t.tags.map((g) => g.id)].some((s) =>
    s.toLowerCase().includes(needle),
  );
}

export function modelJson(m: CatalogModel) {
  return {
    id: m.id,
    label: m.label,
    provider: m.provider,
    enabled: m.enabled,
    supportsTools: m.supportsTools,
    contextLength: m.contextLength,
    pricing: { promptUsdPerM: m.promptPriceUsdPerM, completionUsdPerM: m.completionPriceUsdPerM },
    syncedAt: m.syncedAt,
    releases: m.releases.map((r) => ({ id: r.id, isLatest: r.isLatest, releasedAt: r.releasedAt })),
  };
}

function initials(displayName: string | null, wallet: string): string {
  const words = (displayName ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return wallet.slice(0, 2).toUpperCase();
}

const profileJson = (wallet: string, p: Profile | null) => ({
  wallet,
  displayName: p?.displayName ?? null,
  handle: p?.handle ?? null,
  initials: initials(p?.displayName ?? null, wallet),
});

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,29}$/;

export function createCatalogRouter(store: CatalogStore): Router {
  const router = Router();

  router.get(
    "/tasks",
    optionalWallet,
    handle(async (req, res) => {
      const wallet = req.wallet ?? null;
      const source = str(req.query.source) ?? "all";
      if (!["all", "curated", "public", "mine"].includes(source)) {
        res.status(400).json({ error: "source must be all, curated (alias public) or mine" });
        return;
      }
      const kind = str(req.query.kind);
      if (kind && kind !== "itera" && kind !== "user") {
        res.status(400).json({ error: "kind must be itera or user" });
        return;
      }
      const runnableQ = str(req.query.runnable);
      if (runnableQ && runnableQ !== "true" && runnableQ !== "false") {
        res.status(400).json({ error: "runnable must be true or false" });
        return;
      }
      const tag = str(req.query.tag);
      const q = str(req.query.q) ?? str(req.query.search);

      const all = await store.listVisibleTasks(wallet);
      const isMine = (t: CatalogTask) => wallet !== null && t.ownerWallet === wallet;
      const counts = { all: all.length, public: all.filter((t) => !isMine(t)).length, mine: all.filter(isMine).length };

      const tasks = all.filter((t) => {
        if (source === "mine" && !isMine(t)) return false;
        if ((source === "curated" || source === "public") && isMine(t)) return false;
        if (kind && t.kind !== kind) return false;
        if (runnableQ && (t.latest?.runnable ?? false) !== (runnableQ === "true")) return false;
        if (tag && !t.tags.some((g) => g.id === tag)) return false;
        if (q && !matchesSearch(t, q)) return false;
        return true;
      });
      // Mine first (Task Filter panel groups "My tasks" above the public catalog), then runnable.
      const rank = (t: CatalogTask) => (isMine(t) ? 0 : 2) + (t.latest?.runnable ? 0 : 1);
      tasks.sort((a, b) => rank(a) - rank(b));
      res.json({ tasks: tasks.map((t) => taskJson(t, wallet)), counts });
    }),
  );

  router.get(
    "/tasks/:idOrSlug",
    optionalWallet,
    handle(async (req, res) => {
      const wallet = req.wallet ?? null;
      const t = await store.getVisibleTask(String(req.params.idOrSlug), wallet);
      if (!t) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      res.json({ task: taskDetailJson(t, wallet) });
    }),
  );

  router.get(
    "/tags",
    optionalWallet,
    handle(async (req, res) => {
      const kind = str(req.query.kind);
      if (kind && kind !== "tool" && kind !== "concept") {
        res.status(400).json({ error: "kind must be tool or concept" });
        return;
      }
      const [tags, tasks] = await Promise.all([store.listTags(), store.listVisibleTasks(req.wallet ?? null)]);
      const count = new Map<string, number>();
      for (const t of tasks) for (const g of t.tags) count.set(g.id, (count.get(g.id) ?? 0) + 1);
      res.json({
        tags: tags
          .filter((g: Tag) => !kind || g.kind === kind)
          .map((g) => ({ id: g.id, name: g.name, kind: g.kind, count: count.get(g.id) ?? 0 })),
      });
    }),
  );

  router.get("/models", async (req, res, next) => {
    try {
      const all = await store.listModels();
      const includeDisabled = str(req.query.all) === "1" || str(req.query.all) === "true";
      const models = includeDisabled ? all : all.filter((m) => m.enabled);
      const enabled = all.filter((m) => m.enabled);
      const def = enabled.find((m) => m.id === DEFAULT_AGENT_MODEL)?.id ?? enabled[0]?.id ?? null;
      const syncedAt = all.reduce<string | null>((acc, m) => (m.syncedAt && (!acc || m.syncedAt > acc) ? m.syncedAt : acc), null);
      res.json({ default: def, models: models.map(modelJson), syncedAt, source: "db" });
    } catch (e) {
      if (!(e instanceof SchemaNotReadyError)) {
        next(e);
        return;
      }
      // 0007 not applied: the static allow-list, same shape as before.
      res.json({ default: DEFAULT_AGENT_MODEL, models: AGENT_MODELS, syncedAt: null, source: "static" });
    }
  });

  router.get(
    "/me",
    requireWallet,
    handle(async (req, res) => {
      const wallet = req.wallet!;
      res.json(profileJson(wallet, await store.getProfile(wallet)));
    }),
  );

  router.patch(
    "/me",
    requireWallet,
    handle(async (req, res) => {
      const wallet = req.wallet!;
      const body = (req.body ?? {}) as { displayName?: unknown; handle?: unknown };
      const patch: { displayName?: string | null; handle?: string | null } = {};
      if (body.displayName !== undefined) {
        if (body.displayName === null || body.displayName === "") patch.displayName = null;
        else if (typeof body.displayName === "string" && body.displayName.trim().length >= 1 && body.displayName.trim().length <= 60) {
          patch.displayName = body.displayName.trim();
        } else {
          res.status(400).json({ error: "displayName must be a string of 1 to 60 characters, or null" });
          return;
        }
      }
      if (body.handle !== undefined) {
        if (body.handle === null || body.handle === "") patch.handle = null;
        else if (typeof body.handle === "string" && HANDLE_RE.test(body.handle.trim().toLowerCase())) {
          patch.handle = body.handle.trim().toLowerCase();
        } else {
          res.status(400).json({ error: "handle must be 2 to 30 characters: a-z, 0-9, _ or -, starting with a letter or digit" });
          return;
        }
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: "nothing to update: send displayName and/or handle" });
        return;
      }
      try {
        res.json(profileJson(wallet, await store.upsertProfile(wallet, patch)));
      } catch (e) {
        if (e instanceof HandleTakenError) {
          res.status(409).json({ error: e.message });
          return;
        }
        throw e;
      }
    }),
  );

  return router;
}

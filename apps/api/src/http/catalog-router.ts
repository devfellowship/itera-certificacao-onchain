import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import {
  HandleTakenError,
  type CatalogModel,
  type CatalogStore,
  type CatalogTask,
  type Profile,
  type ProfilePatch,
  type Tag,
} from "../domain/catalog-store.js";
import { shortWallet, taskOverviews, type RankingStore } from "../domain/agent-ranking.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import type { ModelsSyncResult } from "../domain/models-sync.js";
import { AGENT_MODELS, DEFAULT_AGENT_MODEL, isAllowedModel } from "../github/models.js";
import { optionalWallet, requireWallet } from "./auth.js";
import type { EvaluationListRow, EvaluationsStore } from "../evaluations/store.js";

/**
 * Catalog routes (U5, plan 20261012-itera-testmyagent-ui-refactor). Tables: 0007_catalog.sql.
 *
 *   GET   /tasks?source=all|curated|public|mine&tag=&kind=itera|user&runnable=true|false&q=&include=overview   optional auth
 *   GET   /tasks/:idOrSlug                                                                 optional auth
 *   GET   /tags?kind=tool|concept                                                          optional auth
 *   GET   /models?all=1                                                                    public
 *   GET   /me                                                                              wallet
 *   PATCH /me {username?|handle?, displayName?, bio?, avatarUrl?: null}                    wallet
 *   GET   /usernames/:name/available                                                       optional auth
 *   GET   /public/users/:username                                                          public
 *   GET   /models/:id/access                                                               public
 *   POST  /admin/models/sync                                         wallet in ITERA_ADMIN_WALLETS
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

/** Author of a curated (TestMyAgent) task. Same icon the profile seed uses for the DFL profiles (U36). */
export const DFL_AUTHOR = { name: "DevFellowship", avatarUrl: "https://brand.devfellowship.com/downloads/dfl/dfl-icon-180.png" } as const;

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
    // U36: the author of a user task (null for an Itera task); the profile middleware adds ownerProfile.
    ownerWallet: t.ownerWallet,
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

/** U36: `username` is the `handle` column; `handle` stays in the response for older clients. */
export const profileJson = (wallet: string, p: Profile | null) => ({
  wallet,
  username: p?.handle ?? null,
  displayName: p?.displayName ?? null,
  handle: p?.handle ?? null,
  avatarUrl: p?.avatarUrl ?? null,
  bio: p?.bio ?? null,
  initials: initials(p?.displayName ?? p?.handle ?? null, wallet),
});

/** U36: 3 to 30 characters of a-z, 0-9, _ and -. Stored lowercase; unique (409 when taken). */
export const USERNAME_RE = /^[a-z0-9_-]{3,30}$/;
/** Names that would read as the platform, a route or a role. */
export const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "root", "system", "support", "help", "staff", "moderator", "mod",
  "itera", "iterahq", "testmyagent", "tma", "official", "team", "security", "billing",
  "api", "app", "www", "me", "settings", "profile", "profiles", "agents", "agent", "tasks", "task",
  "evaluations", "evaluation", "e", "verify", "login", "logout", "signin", "signup", "auth",
  "new", "edit", "null", "undefined", "anonymous", "unknown", "owner", "everyone",
]);

/** Null when valid, else the 400 message. */
export function usernameProblem(u: string): string | null {
  if (!USERNAME_RE.test(u)) return "username must be 3 to 30 characters: a-z, 0-9, _ or -";
  if (RESERVED_USERNAMES.has(u)) return `username "${u}" is reserved`;
  return null;
}

/**
 * Model access check (U21). ITERA pays the tokens (Gate Q2), so a user can use exactly the models
 * on ITERA's allow-list: `models.enabled`. Without 0007 it is the static allow-list.
 */
export function modelAccessCheck(store: CatalogStore): (modelId: string) => Promise<boolean> {
  return async (modelId) => {
    try {
      return (await store.isModelEnabled(modelId)) === true;
    } catch (e) {
      if (e instanceof SchemaNotReadyError) return isAllowedModel(modelId);
      throw e;
    }
  };
}

export interface CatalogRouterOptions {
  /** Ranking data for `GET /tasks?include=overview` (author, agents count, best result). Without it the flag adds only the author. */
  ranking?: RankingStore;
  /** Owner-scoped evaluation history for task summaries and `GET /tasks/:id/evaluations`. */
  evaluations?: Pick<EvaluationsStore, "listForWallet" | "listForTaskAndWallet">;
  /** Runs one OpenRouter sync (POST /admin/models/sync). Absent → 503. */
  syncModels?: () => Promise<ModelsSyncResult>;
  /** Wallets allowed to call admin routes. Default: ITERA_ADMIN_WALLETS (comma separated). */
  adminWallets?: () => string[];
}

const envAdminWallets = () =>
  (process.env.ITERA_ADMIN_WALLETS ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);

export function createCatalogRouter(store: CatalogStore, opts: CatalogRouterOptions = {}): Router {
  const router = Router();
  const adminWallets = opts.adminWallets ?? envAdminWallets;
  const canAccess = modelAccessCheck(store);

  /** U35 Tasks page: author profile, agents count and best result per task, computed here from the runs (not in SQL). */
  const withOverview = async (tasks: CatalogTask[], wallet: string | null) => {
    const owners = [...new Set(tasks.map((t) => t.ownerWallet).filter((w): w is string => w !== null))];
    const profiles = new Map<string, Profile | null>(await Promise.all(owners.map(async (w) => [w, await store.getProfile(w).catch(() => null)] as const)));
    let overviews: ReturnType<typeof taskOverviews> | null = null;
    if (opts.ranking) {
      // Best effort: a task row is useful without its best result when the runs schema is not ready.
      overviews = await opts.ranking.load(wallet ?? "").then((data) => taskOverviews(data, wallet ?? "", tasks), () => null);
    }
    const history = wallet && opts.evaluations ? await opts.evaluations.listForWallet(wallet, 5_000).catch(() => []) : [];
    return tasks.map((t) => {
      const ov = overviews?.get(t.id);
      const evaluations = history.filter((e) => e.tasks.some((task) => task.taskId === t.id || task.slug === t.slug));
      const historyAgents = evaluations.map((e) => e.agentId);
      const agentsCount = Math.max(t.agentsRunCount, new Set([...(ov?.agentIds ?? []), ...historyAgents]).size);
      const rankingEligible = !(t.latest?.labels ?? []).includes("open-tests");
      const p = t.ownerWallet ? (profiles.get(t.ownerWallet) ?? null) : null;
      const author = t.ownerWallet
        ? { wallet: t.ownerWallet, name: p?.displayName ?? p?.handle ?? shortWallet(t.ownerWallet), handle: p?.handle ?? null, username: p?.handle ?? null, avatarUrl: p?.avatarUrl ?? null, isDfl: false }
        : { wallet: null, name: DFL_AUTHOR.name, handle: null, avatarUrl: DFL_AUTHOR.avatarUrl, isDfl: true };
      return {
        ...taskJson(t, wallet),
        author,
        agentsCount,
        evaluationCount: evaluations.length,
        rankingEligible,
        bestResult: ov?.best
          ? {
              agent: {
                id: ov.best.agent.id,
                slug: ov.best.agent.slug,
                name: ov.best.agent.name,
                initials: ov.best.agent.name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "??",
                avatarUrl: null,
                author: { name: ov.best.agent.authorName ?? shortWallet(ov.best.agent.ownerWallet), wallet: ov.best.agent.ownerWallet, avatarUrl: null },
              },
              score: ov.best.score,
            }
          : null,
      };
    });
  };

  const evaluationJson = (e: EvaluationListRow) => ({
    id: e.id,
    shortId: e.shortId,
    createdAt: e.createdAt,
    status: e.status,
    score: e.score,
    counts: { pass: e.passCount, fail: e.failCount, invalid: e.invalidCount },
    tests: { passed: e.testsPassed, total: e.testsTotal },
    agent: {
      id: e.agentId,
      slug: e.agentSlug,
      name: e.agentName,
      authorName: e.agentAuthorName ?? (e.agentOwnerWallet ? shortWallet(e.agentOwnerWallet) : "unknown"),
      authorWallet: e.agentOwnerWallet,
    },
  });

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
      if (str(req.query.include) !== "overview") {
        res.json({ tasks: tasks.map((t) => taskJson(t, wallet)), counts });
        return;
      }
      res.json({ tasks: await withOverview(tasks, wallet), counts });
    }),
  );

  router.get(
    "/tasks/:idOrSlug/evaluations",
    requireWallet,
    handle(async (req, res) => {
      const wallet = req.wallet!;
      const t = await store.getVisibleTask(String(req.params.idOrSlug), wallet);
      if (!t) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      if (!opts.evaluations) {
        res.status(503).json({ error: "task evaluation history is not configured" });
        return;
      }
      const evaluations = await opts.evaluations.listForTaskAndWallet(t.id, t.slug, wallet);
      res.json({
        task: taskDetailJson(t, wallet),
        evaluations: evaluations.map(evaluationJson),
        summary: {
          evaluations: evaluations.length,
          agents: new Set(evaluations.map((e) => e.agentId)).size,
          rankingEligible: !(t.latest?.labels ?? []).includes("open-tests"),
        },
      });
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

  // Model ids contain "/", so the id is matched by a regex, as GET /models/:id/estimate does.
  router.get(
    /^\/models\/(.+)\/access$/,
    handle(async (req, res) => {
      const modelId = decodeURIComponent(String((req.params as Record<string, string>)[0] ?? ""));
      let known: boolean | null;
      try {
        known = await store.isModelEnabled(modelId);
      } catch (e) {
        if (!(e instanceof SchemaNotReadyError)) throw e;
        known = isAllowedModel(modelId) ? true : null;
      }
      const accessible = await canAccess(modelId);
      res.json({
        modelId,
        accessible,
        reason: accessible ? "allow_listed" : known === null ? "unknown_model" : "not_enabled",
      });
    }),
  );

  router.post(
    "/admin/models/sync",
    requireWallet,
    handle(async (req, res) => {
      if (!adminWallets().includes(req.wallet!)) {
        res.status(403).json({ error: "admin only" });
        return;
      }
      if (!opts.syncModels) {
        res.status(503).json({ error: "models sync is not configured on this server" });
        return;
      }
      try {
        res.json(await opts.syncModels());
      } catch (e) {
        if (e instanceof SchemaNotReadyError) throw e;
        res.status(502).json({ error: `models sync failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    }),
  );

  router.get(
    "/me",
    requireWallet,
    handle(async (req, res) => {
      const wallet = req.wallet!;
      const [p, stats] = await Promise.all([store.getProfile(wallet), store.profileStats(wallet).catch(() => null)]);
      res.json({ ...profileJson(wallet, p), stats });
    }),
  );

  router.patch(
    "/me",
    requireWallet,
    handle(async (req, res) => {
      const wallet = req.wallet!;
      const body = (req.body ?? {}) as { displayName?: unknown; handle?: unknown; username?: unknown; avatarUrl?: unknown; bio?: unknown };
      const patch: ProfilePatch = {};
      if (body.bio !== undefined) {
        if (body.bio === null || (typeof body.bio === "string" && body.bio.trim() === "")) patch.bio = null;
        else if (typeof body.bio === "string" && body.bio.trim().length <= 80) patch.bio = body.bio.trim().replace(/\s+/g, " ");
        else {
          res.status(400).json({ error: "bio must be at most 80 characters, or null" });
          return;
        }
      }
      if (body.displayName !== undefined) {
        if (body.displayName === null || body.displayName === "") patch.displayName = null;
        else if (typeof body.displayName === "string" && body.displayName.trim().length >= 1 && body.displayName.trim().length <= 60) {
          patch.displayName = body.displayName.trim();
        } else {
          res.status(400).json({ error: "displayName must be a string of 1 to 60 characters, or null" });
          return;
        }
      }
      // U36: `username` (new) and `handle` (U5) name the same field; `username` wins.
      const name = body.username !== undefined ? body.username : body.handle;
      if (name !== undefined) {
        if (name === null || name === "") patch.handle = null;
        else if (typeof name === "string") {
          const u = name.trim().toLowerCase();
          const problem = usernameProblem(u);
          if (problem) {
            res.status(400).json({ error: problem });
            return;
          }
          patch.handle = u;
        } else {
          res.status(400).json({ error: "username must be a string, or null" });
          return;
        }
      }
      // The picture is set by POST /me/avatar; PATCH can only remove it.
      if (body.avatarUrl !== undefined) {
        if (body.avatarUrl !== null) {
          res.status(400).json({ error: "avatarUrl accepts only null here: upload a picture with POST /me/avatar" });
          return;
        }
        patch.avatarUrl = null;
        patch.avatarKey = null;
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: "nothing to update: send username, displayName, bio and/or avatarUrl: null" });
        return;
      }
      try {
        res.json(profileJson(wallet, await store.upsertProfile(wallet, patch)));
      } catch (e) {
        if (e instanceof HandleTakenError) {
          res.status(409).json({ error: `username "${e.handle}" is taken` });
          return;
        }
        throw e;
      }
    }),
  );


  // U36: live check of the Edit profile form. The caller's own username counts as available.
  router.get(
    "/usernames/:name/available",
    optionalWallet,
    handle(async (req, res) => {
      const u = String(req.params.name).trim().toLowerCase();
      const problem = usernameProblem(u);
      if (problem) {
        res.json({ username: u, available: false, reason: problem.endsWith("reserved") ? "reserved" : "invalid", error: problem });
        return;
      }
      const owner = await store.getProfileByUsername(u);
      const available = !owner || owner.wallet === req.wallet;
      res.json({ username: u, available, reason: available ? null : "taken" });
    }),
  );

  // U36: the public user page /u/:username (listed agents with issued evidence, public tasks).
  router.get(
    "/public/users/:username",
    handle(async (req, res) => {
      const u = String(req.params.username).trim().toLowerCase();
      const page = USERNAME_RE.test(u) ? await store.publicUser(u) : null;
      if (!page) {
        res.status(404).json({ error: "user not found" });
        return;
      }
      const p = page.profile;
      res.json({
        user: { username: p.handle, displayName: p.displayName, bio: p.bio, avatarUrl: p.avatarUrl, initials: initials(p.displayName ?? p.handle, p.wallet), wallet: p.wallet },
        agents: page.agents.map((a) => ({ ...a, initials: initials(a.name, a.id) })),
        tasks: page.tasks,
      });
    }),
  );
  return router;
}

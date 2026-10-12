import { randomBytes } from "node:crypto";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { CatalogStore } from "../domain/catalog-store.js";
import { type MyTasksStore, type TaskValidation, type UserTask, type UserTaskVersion } from "../domain/my-tasks-store.js";
import type { GithubAgentsRepository } from "../domain/github-agents-repository.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { GitHubApiError, GitHubConfigError, type GitHubAppApi } from "../github/app-client.js";
import { folderDigest, labelsFor, normalizeTaskPath, readTaskLayout, TaskPathError, type TaskLayout } from "../github/task-layout.js";
import { isRankedTask, unrankedReason } from "../domain/reputation.js";
import { isValidBranchName } from "./github-router.js";
import { optionalWallet } from "./auth.js";

/**
 * My tasks (U19, plan 20261012-itera-testmyagent-ui-refactor). Source = a GitHub repo through the
 * TestMyAgent App, pinned to branch + commit (Gate Q4). No copy at rest (Gate Q5): the runner reads
 * the folder at the pinned commit for every validation and every run. A public repo gives "open
 * tests" and an unranked task; a private repo gives sealed tests (Q7).
 *
 *   POST   /tasks/layout {repoFullName, branch?, commitSha?, path?}         wallet — dry run: pin + layout check
 *   POST   /tasks {repoFullName, branch?, commitSha?, path?, name?, description?, tags?, estMinutes?}
 *                                                                            wallet — task (draft) + version 1
 *   GET    /tasks/:id                                                      owner — task + versions + validation
 *                                                                            (others fall through to the catalog route → 404)
 *   PATCH  /tasks/:id {name?, description?, tags?, estMinutes?}             owner — metadata only, versions never change
 *   DELETE /tasks/:id                                                      owner — soft delete
 *   GET    /tasks/:id/versions                                             owner
 *   POST   /tasks/:id/versions {repoFullName?, branch?, commitSha?, path?}  owner — a new pinned commit = a new version, only when
 *                                                                            the task FOLDER changed (U34): the content digest of the folder
 *                                                                            is compared with the latest version; same digest → 200 with that
 *                                                                            version and `unchanged: true`, 201 for a new version
 *   POST   /tasks/:id/versions/:v/validate                                 owner — queue the gate (202)
 *   POST   /tasks/:id/validate                                             owner — same, latest version
 *   GET    /tasks/:id/versions/:v/validation                               owner — latest gate of that version
 *   GET    /tasks/:id/validations/:validationId                            owner
 *
 * A task becomes runnable only when the runner's gate passes (baseline hidden FAIL, solution PASS,
 * 3 repeats identical, verifier time inside the budget).
 */
export interface MyTasksRouterDeps {
  store: MyTasksStore;
  /** Tags list (task_tags references tags). */
  catalog: CatalogStore;
  /** Lazy: throws GitHubConfigError until GITHUB_APP_* is set; routes answer 503 then. */
  github: () => GitHubAppApi;
  installations: Pick<GithubAgentsRepository, "getInstallation">;
  requireWallet: RequestHandler;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const REPO_FULL_NAME_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const COMMIT_INPUT_RE = /^[0-9a-fA-F]{7,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const TASK_NAME_MAX = 60;
export const TASK_DESCRIPTION_MAX = 120;
export const VALIDATION_REPEATS = 3;

function wrap(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (e) {
      if (e instanceof HttpError) res.status(e.status).json({ error: e.message, ...e.extra });
      else if (e instanceof SchemaNotReadyError) res.status(503).json({ error: e.message });
      else if (e instanceof GitHubConfigError) res.status(503).json({ error: "the TestMyAgent GitHub App is not configured on this server yet" });
      else if (e instanceof GitHubApiError) {
        const status = e.status === 404 || e.status === 422 ? 404 : 502;
        res.status(status).json({ error: status === 404 ? "not found on GitHub (repo, branch or commit)" : "GitHub request failed", githubStatus: e.status });
      } else {
        console.error("my-tasks-router error", e);
        res.status(500).json({ error: "internal error" });
      }
    }
  };
}

function wallet(req: Request): string {
  if (!req.wallet) throw new HttpError(401, "a valid wallet session is required");
  return req.wallet;
}

const shortSha = (s: string) => s.slice(0, 7);

/** The four rows of the task editor's VALIDATION panel, from the gate result (counts only, no test names). */
export function gateRows(result: unknown): { key: string; label: string; ok: boolean; value: string }[] | null {
  const r = result as {
    checks?: Record<string, { ok: boolean; detail: string; hidden_total?: number; hidden_failed?: number; public?: string; hidden?: string; runs?: number; max_ms?: number; budget_ms?: number }>;
  } | null;
  const c = r?.checks;
  if (!c) return null;
  const base = c.baseline_hidden_fails;
  const sol = c.solution_passes;
  const rep = c.repeatable;
  const time = c.verifier_time;
  const rows = [
    { key: "baseline", label: "Baseline hidden tests", ok: Boolean(base?.ok), value: base?.ok ? "FAIL as expected ✓" : base?.detail ?? "not checked" },
    {
      key: "solution",
      label: "Solution",
      ok: Boolean(sol?.ok),
      value: sol?.ok && sol.hidden ? `${sol.hidden.replace("/", " / ")} PASS` : sol?.detail ?? "not checked",
    },
    { key: "repeatability", label: "Repeatability", ok: Boolean(rep?.ok), value: rep?.detail ?? "not checked" },
    {
      key: "verifier_time",
      label: "Verifier time",
      ok: Boolean(time?.ok),
      value: time?.ok && typeof time.max_ms === "number" ? `${Math.max(1, Math.round(time.max_ms / 1000))} s` : time?.detail ?? "not checked",
    },
  ];
  if (c.contract && !c.contract.ok) rows.unshift({ key: "contract", label: "Contract", ok: false, value: c.contract.detail });
  // U29 gate step, only for a task that declares MCP servers: boot, seed, tool schema and the
  // state assertions in one check. The task editor shows it under ENVIRONMENT (U31).
  if (c.mcp) rows.unshift({ key: "mcp", label: "MCP servers", ok: Boolean(c.mcp.ok), value: c.mcp.detail || (c.mcp.ok ? "ok" : "not checked") });
  return rows;
}

function validationJson(v: TaskValidation | null) {
  if (!v) return null;
  return {
    id: v.id,
    taskVersionId: v.taskVersionId,
    status: v.status,
    repeats: v.repeats,
    rows: gateRows(v.result),
    result: v.result,
    error: v.error,
    createdAt: v.createdAt,
    claimedAt: v.claimedAt,
    completedAt: v.completedAt,
  };
}

function versionJson(v: UserTaskVersion) {
  return {
    id: v.id,
    version: v.version,
    source: "github" as const,
    github: { installationId: v.installationId, repo: v.repoFullName, branch: v.branch, commitSha: v.commitSha, shortSha: shortSha(v.commitSha), path: v.repoPath },
    repoPrivate: v.repoPrivate,
    testsVisibility: v.repoPrivate ? ("sealed" as const) : ("open" as const),
    ranked: isRankedTask({ kind: "user", source: "github", repoPrivate: v.repoPrivate, labels: v.labels }),
    unrankedReason: unrankedReason({ kind: "user", source: "github", repoPrivate: v.repoPrivate, labels: v.labels }),
    labels: v.labels,
    runnable: v.runnable,
    hiddenTestsCount: v.hiddenTestsCount,
    digests: { fixture: v.fixtureDigest, hidden: v.hiddenDigest, solution: v.solutionDigest },
    validatedAt: v.validatedAt,
    validationRows: gateRows(v.validation),
    contract: v.contract,
    createdAt: v.createdAt,
  };
}

function taskJson(t: UserTask, versions: UserTaskVersion[], validation: TaskValidation | null) {
  const latest = versions[0] ?? null;
  const runnableVersion = versions.find((v) => v.runnable) ?? null;
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    kind: "user" as const,
    visibility: "private" as const,
    status: t.status,
    estMinutes: t.estMinutes,
    tags: t.tags,
    mine: true,
    runnable: runnableVersion !== null,
    runnableVersion: runnableVersion?.version ?? null,
    ranked: latest ? isRankedTask({ kind: "user", source: "github", repoPrivate: latest.repoPrivate, labels: latest.labels }) : false,
    labels: latest?.labels ?? [],
    latestVersion: latest && versionJson(latest),
    versions: versions.map(versionJson),
    validation: validationJson(validation),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

const layoutJson = (l: TaskLayout) =>
  l.ok
    ? { ok: true, entries: l.entries, fileCount: l.fileCount, totalBytes: l.totalBytes }
    : { ok: false, errorCode: l.errorCode, error: l.error, entries: l.entries, ...(l.schemaErrors ? { schemaErrors: l.schemaErrors } : {}) };

export function createMyTasksRouter(deps: MyTasksRouterDeps): Router {
  const router = Router();
  const { store, github, requireWallet } = deps;

  async function installationFor(walletAddr: string, repoFullName: string): Promise<number> {
    if (!REPO_FULL_NAME_RE.test(repoFullName)) throw new HttpError(400, "repoFullName must look like owner/repo");
    const installationId = await github().getRepoInstallationId(repoFullName);
    const inst = installationId === null ? null : await deps.installations.getInstallation(installationId);
    if (installationId === null || !inst || inst.ownerWallet !== walletAddr) {
      throw new HttpError(404, "repo not connected: install the TestMyAgent GitHub App on it from this wallet");
    }
    return installationId;
  }

  /** Pin = (branch, full commit SHA). commitSha absent → HEAD of the branch; branch absent → default branch. */
  async function pin(walletAddr: string, body: Record<string, unknown>) {
    if (typeof body.repoFullName !== "string") throw new HttpError(400, "repoFullName is required (owner/repo)");
    const repoFullName = body.repoFullName;
    let path: string;
    try {
      path = normalizeTaskPath(body.path);
    } catch (e) {
      throw new HttpError(400, e instanceof TaskPathError ? e.message : "invalid path");
    }
    const commitIn = body.commitSha ?? body.commit;
    if (body.branch !== undefined && body.branch !== null && body.branch !== "" && !isValidBranchName(body.branch)) {
      throw new HttpError(400, "branch is not a valid branch name");
    }
    if (commitIn !== undefined && commitIn !== null && commitIn !== "" && (typeof commitIn !== "string" || !COMMIT_INPUT_RE.test(commitIn))) {
      throw new HttpError(400, "commitSha must be a hex commit SHA (7 to 40 characters)");
    }
    const installationId = await installationFor(walletAddr, repoFullName);
    const gh = github();
    const meta = await gh.getRepo(installationId, repoFullName);
    const branch = typeof body.branch === "string" && body.branch ? body.branch : meta.defaultBranch;
    const ref = typeof commitIn === "string" && commitIn ? commitIn.toLowerCase() : branch;
    const commitSha = await gh.resolveHead(installationId, repoFullName, ref);
    if (!SHA_RE.test(commitSha)) throw new HttpError(502, "GitHub returned an invalid commit SHA");
    const layout = await readTaskLayout(gh, installationId, repoFullName, commitSha, path);
    return { installationId, repoFullName, branch, commitSha, path, repoPrivate: meta.private, layout };
  }

  const pinJson = (p: Awaited<ReturnType<typeof pin>>) => ({
    repoFullName: p.repoFullName,
    branch: p.branch,
    commitSha: p.commitSha,
    shortSha: shortSha(p.commitSha),
    path: p.path,
    repoPrivate: p.repoPrivate,
    testsVisibility: p.repoPrivate ? "sealed" : "open",
    ranked: isRankedTask({ kind: "user", source: "github", repoPrivate: p.repoPrivate, labels: labelsFor(p.repoPrivate) }),
    labels: labelsFor(p.repoPrivate),
  });

  async function checkTags(input: unknown): Promise<string[] | undefined> {
    if (input === undefined) return undefined;
    if (!Array.isArray(input) || input.length > 8 || input.some((t) => typeof t !== "string" || !TAG_RE.test(t))) {
      throw new HttpError(400, "tags must be an array of at most 8 tag ids (GET /tags)");
    }
    const known = new Set((await deps.catalog.listTags()).map((t) => t.id));
    const unknown = (input as string[]).filter((t) => !known.has(t));
    if (unknown.length > 0) throw new HttpError(400, `unknown tags: ${unknown.join(", ")} (GET /tags)`);
    return [...new Set(input as string[])];
  }

  function checkText(v: unknown, field: string, max: number, required: boolean): string | undefined {
    if (v === undefined || v === null) {
      if (required) throw new HttpError(400, `${field} is required`);
      return undefined;
    }
    if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
    const s = v.trim();
    if ((required && s.length === 0) || s.length > max) throw new HttpError(400, `${field} must be ${required ? "1" : "0"} to ${max} characters`);
    return s;
  }

  function checkMinutes(v: unknown): number | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 120) throw new HttpError(400, "estMinutes must be an integer from 1 to 120");
    return v as number;
  }

  async function ownTask(req: Request): Promise<UserTask> {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) throw new HttpError(404, "task not found");
    const t = await store.getOwnedTask(id, wallet(req));
    if (!t) throw new HttpError(404, "task not found");
    return t;
  }

  async function ownVersion(req: Request, task: UserTask): Promise<UserTaskVersion> {
    const n = Number(req.params.v);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(404, "version not found");
    const v = await store.getVersion(task.id, n);
    if (!v) throw new HttpError(404, "version not found");
    return v;
  }

  async function detail(task: UserTask) {
    const versions = await store.listVersions(task.id);
    const validation = versions[0] ? await store.latestValidation(versions[0].id) : null;
    return taskJson(task, versions, validation);
  }

  router.post(
    "/tasks/layout",
    requireWallet,
    wrap(async (req, res) => {
      const p = await pin(wallet(req), (req.body ?? {}) as Record<string, unknown>);
      res.json({ pin: pinJson(p), layout: layoutJson(p.layout), contract: p.layout.contract });
    }),
  );

  router.post(
    "/tasks",
    requireWallet,
    wrap(async (req, res) => {
      const walletAddr = wallet(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const nameIn = checkText(body.name, "name", TASK_NAME_MAX, false);
      const descIn = checkText(body.description, "description", TASK_DESCRIPTION_MAX, false);
      const tags = await checkTags(body.tags);
      const minutesIn = checkMinutes(body.estMinutes);
      const p = await pin(walletAddr, body);
      if (!p.layout.ok) throw new HttpError(422, p.layout.error, { pin: pinJson(p), layout: layoutJson(p.layout) });
      const c = p.layout.contract;
      const name = nameIn || (c.metadata?.title ?? c.task.name).slice(0, TASK_NAME_MAX);
      const description = descIn ?? (c.task.description ?? "").slice(0, TASK_DESCRIPTION_MAX);
      const estMinutes = minutesIn !== undefined ? minutesIn : Math.min(120, Math.max(1, Math.round(c.est_minutes)));
      const contractTags = [...(c.metadata?.tags?.tools ?? []), ...(c.metadata?.tags?.concepts ?? [])];
      const known = new Set((await deps.catalog.listTags()).map((t) => t.id));
      const { task, version } = await store.createTask({
        ownerWallet: walletAddr,
        slug: `u-${randomBytes(6).toString("hex")}`,
        name,
        description,
        estMinutes,
        tags: tags ?? [...new Set(contractTags.filter((t) => known.has(t)))].slice(0, 8),
        version: {
          installationId: p.installationId,
          repoFullName: p.repoFullName,
          branch: p.branch,
          commitSha: p.commitSha,
          repoPath: p.path,
          repoPrivate: p.repoPrivate,
          labels: labelsFor(p.repoPrivate),
          contract: c,
          createdBy: walletAddr,
        },
      });
      res.status(201).json({ task: taskJson(task, [version], null), version: versionJson(version), layout: layoutJson(p.layout) });
    }),
  );

  // Owner view. Anything else (a slug, a catalog task, another wallet's task) goes on to the
  // catalog route, which answers the public view or 404.
  router.get(
    "/tasks/:id",
    optionalWallet,
    wrap(async (req, res, next) => {
      const id = String(req.params.id);
      if (!req.wallet || !UUID_RE.test(id)) return next();
      const t = await store.getOwnedTask(id, req.wallet);
      if (!t) return next();
      res.json({ task: await detail(t) });
    }),
  );

  router.patch(
    "/tasks/:id",
    requireWallet,
    wrap(async (req, res) => {
      const task = await ownTask(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch = {
        name: checkText(body.name, "name", TASK_NAME_MAX, body.name !== undefined),
        description: checkText(body.description, "description", TASK_DESCRIPTION_MAX, false),
        estMinutes: checkMinutes(body.estMinutes),
        tags: await checkTags(body.tags),
      };
      if (Object.values(patch).every((v) => v === undefined)) {
        throw new HttpError(400, "nothing to update: send name, description, tags or estMinutes (a new commit is POST /tasks/:id/versions)");
      }
      if (task.status === "validating") throw new HttpError(409, "the task is being validated; wait for the gate to finish");
      res.json({ task: await detail(await store.updateTask(task.id, patch)) });
    }),
  );

  router.delete(
    "/tasks/:id",
    requireWallet,
    wrap(async (req, res) => {
      const task = await ownTask(req);
      await store.softDelete(task.id);
      res.json({ id: task.id, deleted: true });
    }),
  );

  router.get(
    "/tasks/:id/versions",
    requireWallet,
    wrap(async (req, res) => {
      const task = await ownTask(req);
      res.json({ versions: (await store.listVersions(task.id)).map(versionJson) });
    }),
  );

  router.post(
    "/tasks/:id/versions",
    requireWallet,
    wrap(async (req, res) => {
      const walletAddr = wallet(req);
      const task = await ownTask(req);
      if (task.status === "validating") throw new HttpError(409, "the task is being validated; wait for the gate to finish");
      const versions = await store.listVersions(task.id);
      const latest = versions[0];
      const body = (req.body ?? {}) as Record<string, unknown>;
      const merged = {
        repoFullName: body.repoFullName ?? latest?.repoFullName,
        branch: body.branch ?? latest?.branch,
        commitSha: body.commitSha ?? body.commit,
        path: body.path ?? latest?.repoPath,
      };
      const p = await pin(walletAddr, merged);
      if (!p.layout.ok) throw new HttpError(422, p.layout.error, { pin: pinJson(p), layout: layoutJson(p.layout) });
      // Multi-task repos (U34): a commit that touched another folder is not a new version of this task.
      // Same pin → same folder; otherwise compare the content digest of the folder at both commits.
      const prior = latest && latest.repoFullName === p.repoFullName && latest.repoPath === p.path ? latest : null;
      if (prior) {
        let unchanged = prior.commitSha === p.commitSha;
        if (!unchanged) {
          const gh = github();
          const [now, before] = await Promise.all([
            gh.listTree(p.installationId, p.repoFullName, p.commitSha),
            gh.listTree(p.installationId, p.repoFullName, prior.commitSha),
          ]);
          unchanged = !now.truncated && !before.truncated && folderDigest(now.entries, p.path) === folderDigest(before.entries, p.path);
        }
        if (unchanged) {
          res.status(200).json({ version: versionJson(prior), unchanged: true, layout: layoutJson(p.layout) });
          return;
        }
      }
      const sameCommit = versions.find((v) => v.repoFullName === p.repoFullName && v.commitSha === p.commitSha && v.repoPath === p.path);
      if (sameCommit) {
        throw new HttpError(409, `version ${sameCommit.version} already pins ${p.repoFullName}@${shortSha(p.commitSha)}`, { version: versionJson(sameCommit) });
      }
      const version = await store.addVersion(task.id, {
        installationId: p.installationId,
        repoFullName: p.repoFullName,
        branch: p.branch,
        commitSha: p.commitSha,
        repoPath: p.path,
        repoPrivate: p.repoPrivate,
        labels: labelsFor(p.repoPrivate),
        contract: p.layout.contract,
        createdBy: walletAddr,
      });
      res.status(201).json({ version: versionJson(version), unchanged: false, layout: layoutJson(p.layout) });
    }),
  );

  async function validate(req: Request, res: Response, version: UserTaskVersion, task: UserTask) {
    const { validation, created } = await store.enqueueValidation({ taskId: task.id, taskVersionId: version.id, requestedBy: wallet(req), repeats: VALIDATION_REPEATS });
    res.status(202).json({ validationId: validation.id, created, version: version.version, validation: validationJson(validation) });
  }

  router.post(
    "/tasks/:id/versions/:v/validate",
    requireWallet,
    wrap(async (req, res) => {
      const task = await ownTask(req);
      await validate(req, res, await ownVersion(req, task), task);
    }),
  );

  router.post(
    "/tasks/:id/validate",
    requireWallet,
    wrap(async (req, res) => {
      const task = await ownTask(req);
      const latest = (await store.listVersions(task.id))[0];
      if (!latest) throw new HttpError(409, "the task has no version: POST /tasks/:id/versions first");
      await validate(req, res, latest, task);
    }),
  );

  router.get(
    "/tasks/:id/versions/:v/validation",
    requireWallet,
    wrap(async (req, res) => {
      const task = await ownTask(req);
      const version = await ownVersion(req, task);
      const v = await store.latestValidation(version.id);
      if (!v) throw new HttpError(404, "no validation for this version yet");
      res.json({ validation: validationJson(v), version: versionJson(version), taskStatus: task.status });
    }),
  );

  router.get(
    "/tasks/:id/validations/:validationId",
    requireWallet,
    wrap(async (req, res) => {
      const task = await ownTask(req);
      const v = await store.getValidation(String(req.params.validationId));
      if (!v || v.taskId !== task.id) throw new HttpError(404, "validation not found");
      res.json({ validation: validationJson(v), taskStatus: task.status });
    }),
  );

  return router;
}

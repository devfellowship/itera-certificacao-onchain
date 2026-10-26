/**
 * Local agents and custom models (plan 20261026-tma-local-runner-and-self-declared-results, §3; task L4).
 * Every route takes a session (requirePrincipal). Mounted BEFORE the GitHub router: GET and PATCH
 * /agents/:id answer here for a local agent and fall through to the GitHub router for any other id.
 *
 *   GET    /model-options        {providers, routes, models (known), custom (the caller's only)}
 *   POST   /me/models            {id, label, provider_key | provider_label, route_key}
 *                                201 | 400 known_model | 409 custom_model_exists | 409 custom_model_limit (50)
 *   DELETE /me/models/:id        204 | 404 | 409 model_in_use
 *   POST   /agents/local         {name, model_id, route_key, provider_key?, description?, harness?, visibility?, requires?}
 *                                201 | 400 unknown_provider | unknown_route | unknown_model | 409 agent_name_taken
 *   GET    /agents/:id           a local agent of the caller
 *   PATCH  /agents/:id           a local agent: name, description, model_id, provider_key, route_key, harness,
 *                                visibility, requires
 *
 * Before 0021 the writes answer 503 schema_not_ready; GET /model-options answers with `custom: []`.
 */
import { LABS, PROVIDER_KEYS, ROUTES, providerOf } from "@itera/contracts/model-catalog";
import { parseAgentRequires } from "@itera/contracts";
import { Router, type NextFunction, type Request, type Response } from "express";
import { requirePrincipal } from "../auth/middleware.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import {
  AGENT_DESCRIPTION_MAX,
  AGENT_NAME_MAX,
  CUSTOM_MODELS_MAX,
  HARNESS_MAX,
  LocalAgentsError,
  catalogIdOf,
  checkModelId,
  checkProviderKey,
  checkRouteKey,
  checkSafeText,
  isRoutePrefixedModel,
  type LocalAgent,
  type LocalAgentPatch,
  type LocalAgentsStore,
} from "./store.js";

export interface LocalAgentsRouterDeps {
  store: LocalAgentsStore;
  /** Custom models per owner (default 50). */
  maxCustomModels?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = Record<string, unknown>;
const has = (b: Body, k: string) => b[k] !== undefined;

export function localAgentJson(a: LocalAgent) {
  return { ...a, repoFullName: null, agentPath: null, installationId: null, source: null };
}

export function createLocalAgentsRouter(deps: LocalAgentsRouterDeps): Router {
  const router = Router();
  const store = deps.store;
  const max = deps.maxCustomModels ?? CUSTOM_MODELS_MAX;
  const owner = (req: Request) => req.principal!.id;

  const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch((e) => {
      if (e instanceof LocalAgentsError) res.status(e.status).json({ error: e.code, message: e.message });
      else if (e instanceof SchemaNotReadyError) res.status(503).json({ error: "schema_not_ready", message: e.message });
      else next(e);
    });
  };
  const ready = async () => {
    if (!(await store.schemaReady())) throw new SchemaNotReadyError("0021_self_declared_results.sql");
  };

  /** A known model (route prefix, or a public.models row) or a custom model of the caller. */
  async function checkUsableModel(who: string, raw: unknown): Promise<string> {
    const id = checkModelId(raw);
    if (isRoutePrefixedModel(id) || (await store.catalogHas(catalogIdOf(id)))) return id;
    if ((await store.listCustomModels(who)).some((m) => m.id === id)) return id;
    throw new LocalAgentsError(400, "unknown_model", `unknown model ${id}: not in GET /model-options (add it with POST /me/models)`);
  }

  function requiresOf(value: unknown): string[] {
    const r = parseAgentRequires(value);
    if (!r.ok) throw new LocalAgentsError(400, "invalid", r.errors.join("; "));
    return r.value;
  }

  function visibilityOf(value: unknown): "private" | "listed" {
    if (value !== "private" && value !== "listed") throw new LocalAgentsError(400, "invalid", "visibility must be private or listed");
    return value;
  }

  const optionalText = (b: Body, k: string, max: number) => (b[k] === null || b[k] === "" ? null : checkSafeText(b[k], k, max));

  router.get(
    "/model-options",
    requirePrincipal,
    wrap(async (req, res) => {
      const [known, custom] = await Promise.all([store.listKnownModels(), store.listCustomModels(owner(req))]);
      res.json({
        providers: LABS.filter((l) => PROVIDER_KEYS.includes(l.key)).map((l) => ({ key: l.key, name: l.name })),
        routes: ROUTES.map((r) => ({ key: r.key, name: r.name })),
        models: known.map((m) => ({ id: m.id, label: m.label, provider: providerOf({ id: m.id, label: m.label }), route: "openrouter", known: true })),
        custom: custom.map((m) => ({ id: m.id, label: m.label, provider: m.providerKey, providerLabel: m.providerLabel, route: m.routeKey, known: false })),
      });
    }),
  );

  router.post(
    "/me/models",
    requirePrincipal,
    wrap(async (req, res) => {
      await ready();
      const b = (req.body ?? {}) as Body;
      const id = checkModelId(b.id);
      if (isRoutePrefixedModel(id) || (await store.catalogHas(catalogIdOf(id)))) {
        throw new LocalAgentsError(400, "known_model", `${id} is a known model: use it as is`);
      }
      const label = checkSafeText(b.label, "label", 60, 1);
      const hasKey = b.provider_key !== undefined && b.provider_key !== null;
      const hasLabel = b.provider_label !== undefined && b.provider_label !== null;
      if (hasKey === hasLabel) throw new LocalAgentsError(400, "invalid", "send exactly one of provider_key (a lab key) and provider_label (a custom provider)");
      const providerKey = hasKey ? checkProviderKey(b.provider_key) : null;
      const providerLabel = hasLabel ? checkSafeText(b.provider_label, "provider_label", 40, 1) : null;
      const routeKey = checkRouteKey(b.route_key);
      const m = await store.createCustomModel(owner(req), { id, label, providerKey, providerLabel, routeKey }, max);
      res.status(201).json({ model: { id: m.id, label: m.label, provider: m.providerKey, providerLabel: m.providerLabel, route: m.routeKey, known: false } });
    }),
  );

  router.delete(
    "/me/models/*id",
    requirePrincipal,
    wrap(async (req, res) => {
      await ready();
      // A model id holds slashes: `/me/models/acme/mystery-7b` (or with %2F).
      const raw = (req.params as Record<string, unknown>).id;
      await store.deleteCustomModel(owner(req), Array.isArray(raw) ? raw.join("/") : String(raw));
      res.status(204).end();
    }),
  );

  router.post(
    "/agents/local",
    requirePrincipal,
    wrap(async (req, res) => {
      await ready();
      const b = (req.body ?? {}) as Body;
      const who = owner(req);
      const name = checkSafeText(b.name, "name", AGENT_NAME_MAX, 1);
      const model = await checkUsableModel(who, b.model_id);
      const routeKey = checkRouteKey(b.route_key);
      const providerKey = b.provider_key === undefined || b.provider_key === null ? null : checkProviderKey(b.provider_key);
      const agent = await store.createLocalAgent(who, {
        name,
        model,
        routeKey,
        providerKey,
        description: has(b, "description") ? optionalText(b, "description", AGENT_DESCRIPTION_MAX) : null,
        harness: has(b, "harness") ? optionalText(b, "harness", HARNESS_MAX) : null,
        visibility: has(b, "visibility") ? visibilityOf(b.visibility) : "private",
        requires: has(b, "requires") && b.requires !== null ? requiresOf(b.requires) : [],
      });
      res.status(201).json({ agent: localAgentJson(agent) });
    }),
  );

  /** A local agent of the caller; `null` → not a local agent (the GitHub router answers). */
  async function ownLocal(req: Request): Promise<LocalAgent | null> {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return null;
    const a = await store.getLocalAgent(id);
    if (!a) return null;
    if (a.ownerWallet !== owner(req)) throw new LocalAgentsError(404, "agent_not_found", "agent not found");
    return a;
  }

  router.get(
    "/agents/:id",
    requirePrincipal,
    wrap(async (req, res, next) => {
      const a = await ownLocal(req);
      if (!a) return next();
      res.json({ agent: localAgentJson(a) });
    }),
  );

  router.patch(
    "/agents/:id",
    requirePrincipal,
    wrap(async (req, res, next) => {
      const a = await ownLocal(req);
      if (!a) return next();
      const b = (req.body ?? {}) as Body;
      const p: LocalAgentPatch = {};
      if (has(b, "name")) p.name = checkSafeText(b.name, "name", AGENT_NAME_MAX, 1);
      if (has(b, "description")) p.description = optionalText(b, "description", AGENT_DESCRIPTION_MAX);
      if (has(b, "model_id")) p.model = await checkUsableModel(a.ownerWallet, b.model_id);
      if (has(b, "provider_key")) p.providerKey = b.provider_key === null ? null : checkProviderKey(b.provider_key);
      if (has(b, "route_key")) p.routeKey = checkRouteKey(b.route_key);
      if (has(b, "harness")) p.harness = optionalText(b, "harness", HARNESS_MAX);
      if (has(b, "visibility")) p.visibility = visibilityOf(b.visibility);
      if (has(b, "requires")) p.requires = requiresOf(b.requires);
      if (Object.keys(p).length === 0) {
        throw new LocalAgentsError(400, "nothing_to_update", "send name, description, model_id, provider_key, route_key, harness, visibility or requires");
      }
      res.json({ agent: localAgentJson(await store.updateLocalAgent(a.id, p)) });
    }),
  );

  return router;
}

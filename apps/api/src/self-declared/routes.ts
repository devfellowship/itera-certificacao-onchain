/**
 * Model routes on eval_routes (plan 20261112-tma-c8-routing-from-evals, task C8-T2; ADR-2, ADR-4, ADR-5).
 *
 *   POST  /routes/approve      a person approves ONE agent for ONE use case under a picked rule. The API reads the
 *                              caller's rows of the use case with the compare reader (GET /use-cases/:key/compare),
 *                              re-computes both verdicts with `compareUseCase` of `@itera/contracts/compare` (through
 *                              `compareView`; no second verdict implementation), and freezes the verdict on a new row
 *                              in state `approved`. Refuses n < 5 (n_too_small), a verdict that does not pass under the
 *                              picked rule (verdict_not_passing), an agent that is not in the caller's comparison
 *                              (unknown_agent). The body is closed: an unknown key, a free-text value or a value
 *                              outside the table's CHECK patterns → 400 invalid_body.
 *   PATCH /routes/:id/state    the apply path (`tma route mark`, T4) and the trigger job (T5) record a transition:
 *                                approved → live                  body {state, pr_url}: sets pr_url, live_at;
 *                                live → needs_check               body EXACTLY {state} (T5, ADR-7: a trigger MARKS a
 *                                                                 route, it never changes it): sets only state and
 *                                                                 updated_at; pr_url and live_at stay (the apply record);
 *                                live | needs_check → rolled_back body {state, pr_url}: sets rollback_pr_url,
 *                                                                 rolled_back_at (the CLI sends the rollback PR URL as
 *                                                                 `pr_url`; a needs_check route is still applied in the
 *                                                                 file, so it rolls back like a live one).
 *                              Only the principals of env TMA_ROUTE_APPLY_ACTORS (comma-separated ids) may call it;
 *                              unset or not listed → 403 (fail closed). Every other transition → 409
 *                              invalid_transition. A route in live OR needs_check holds its value in the file: a second
 *                              approved → live on the same (tenant, route_target) → 409 live_route_exists with the id
 *                              and the state of that row; the other row is NOT changed (the supersede rule is an open
 *                              design question). The DB index eval_routes_one_live_idx covers only `live`, so for a
 *                              needs_check row this API check is the only guard.
 *   GET   /routes              the routes of the result tenant, newest first, at most 200. Query: only `use_case`
 *                              and `state`, each at most once (else 400 invalid_query).
 *   GET   /routes/:id          one route of the result tenant, or 404. A malformed id → 400.
 *
 * Every row is answered in the `tma-route/2` shape (packages/contracts/route.js, schemas/route-v2.schema.json; Q3 = A):
 * the tma-route/1 keys plus live_at, rollback_pr_url and rolled_back_at (ISO string or null). 503 schema_not_ready
 * before 0026. The approve evidence comes from countedRunIdsOf (use-case-compare.ts), the same helper as the
 * `evidence_run_ids` of GET /use-cases/:key/compare (Q4 = A).
 * Tenant: TMA_RESULT_TENANT (resultTenantFromEnv), as the compare route. Routes are tenant-wide: every principal of
 * the tenant may read them; only the approver's own evidence can back an approval.
 *
 * Deviations from the brief, forced by 0026 (a row past `proposed` must carry them, eval_routes_cited_verdict_check):
 *   compare_profile_sha256  the sha256 of the canonical JSON of the compare response's `profile` (the v1 profile is
 *                           the library defaults; its `sha256` field is null), never null;
 *   policy_version          defaults to DEFAULT_ROUTE_POLICY_VERSION when the body leaves it out.
 */
import { createHash } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import {
  ROUTE_FORMAT_V2, ROUTE_MIN_N, ROUTE_RULES, ROUTE_STATES, routeVerdictPasses, type RouteRule, type RouteState, type RouteV2,
} from "@itera/contracts";
import { requirePrincipal } from "../auth/middleware.js";
import { hasEvalRoutesSchema } from "../domain/schema-features.js";
import { resultTenantFromEnv } from "./store.js";
import {
  AGENT_KEY_RE, agentKeyOf, compareView, countedRunIdsOf, ROUTE_MAX_EVIDENCE, USE_CASE_PAIR_RE, useCaseRunsOf, type CompareAgentView, type UseCaseCompareReader,
  type UseCaseCompareView,
} from "./use-case-compare.js";

export const EVAL_ROUTES_MIGRATION = "0026_eval_routes.sql";
/** The routing policy version stored when the approve body names none. */
export const DEFAULT_ROUTE_POLICY_VERSION = "c8-1";
export const ROUTES_LIST_LIMIT = 200;
/** eval_routes_evidence_max_check (one value, defined in use-case-compare.ts). */
export { ROUTE_MAX_EVIDENCE };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The patterns of the eval_routes CHECKs (0026), narrowed where tma-route/2 is narrower.
const ROUTE_TARGET_RE = /^(env:[A-Z][A-Z0-9_]{1,63}|claude-md:[a-z0-9][a-z0-9_-]{0,63})$/;
const VALUE_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const POLICY_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
const ACTOR_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}\/pull\/[0-9]{1,9}$/;
/** The harness values of tma-route/1 and tma-route/2. */
const ROUTE_HARNESSES = new Set(["claude-code", "codex", "opencode"]);

/** One row of eval_routes (column names). Timestamps are Date (pg) or an ISO string. */
export interface RouteRecord {
  id: string;
  tenant: string;
  use_case_key: string;
  route_target: string;
  target_value: string;
  rollback_value: string | null;
  agent_sha256: string;
  harness: string;
  harness_repo_sha: string | null;
  model_id: string;
  rules_sha256: string | null;
  skills_sha256: string | null;
  fallback_agent_sha256: string | null;
  fallback_harness: string | null;
  fallback_harness_repo_sha: string | null;
  fallback_model_id: string | null;
  fallback_rules_sha256: string | null;
  fallback_skills_sha256: string | null;
  picked_rule: RouteRule | null;
  verdict: string | null;
  n: number | null;
  evidence_run_ids: string[];
  compare_profile_sha256: string | null;
  policy_version: string | null;
  state: RouteState;
  pr_url: string | null;
  rollback_pr_url: string | null;
  approved_by_actor: string | null;
  created_at: Date | string;
  approved_at: Date | string | null;
  live_at: Date | string | null;
  rolled_back_at: Date | string | null;
  updated_at: Date | string;
}

/** The agent ref columns of one variant (eval_variants). */
export interface VariantRef {
  variantId: string;
  agentSha256: string;
  harness: string;
  harnessRepoSha: string | null;
  modelId: string;
  rulesSha256: string | null;
  skillsSha256: string | null;
}

/** The new approved row (the store sets id, created_at, approved_at = now(), updated_at). */
export type NewApprovedRoute = Omit<
  RouteRecord,
  "id" | "state" | "pr_url" | "rollback_pr_url" | "created_at" | "approved_at" | "live_at" | "rolled_back_at" | "updated_at"
>;

/** A route that holds its value in the file (live or needs_check). */
export interface AppliedRoute {
  id: string;
  state: "live" | "needs_check";
}

/** The states that PATCH /routes/:id/state may set. */
export type PatchTarget = "live" | "needs_check" | "rolled_back";

export interface RouteFilter {
  useCase?: string;
  state?: RouteState;
}

export interface RoutesStore {
  /** False before 0026 (the routes answer 503). */
  ready(): Promise<boolean>;
  /** The ref columns of these variants, only those owned by `owner` in `tenant`. */
  variantRefs(variantIds: string[], owner: string, tenant: string): Promise<VariantRef[]>;
  insertApproved(route: NewApprovedRoute): Promise<RouteRecord>;
  get(id: string, tenant: string): Promise<RouteRecord | null>;
  list(tenant: string, filter: RouteFilter, limit: number): Promise<RouteRecord[]>;
  /**
   * A route of `tenant` on `routeTarget` that is applied in the file (state live OR needs_check), other than
   * `exceptId`, or null. One query; the newest live_at first.
   */
  appliedOnTarget(tenant: string, routeTarget: string, exceptId: string): Promise<AppliedRoute | null>;
  /**
   * Move the route from `from` to `to`, only when it is still in `from`:
   *   live         sets pr_url = prUrl, live_at = now();
   *   needs_check  sets only the state (prUrl must be null; pr_url and live_at stay);
   *   rolled_back  sets rollback_pr_url = prUrl, rolled_back_at = now().
   * updated_at = now() in every case. Null when no row matched (the state moved meanwhile). A unique violation of the
   * one-live index is thrown with code 23505.
   */
  transition(id: string, tenant: string, from: RouteState, to: PatchTarget, prUrl: string | null): Promise<RouteRecord | null>;
}

// ---------------------------------------------------------------------------------------------
// The row view (tma-route/2)

const iso = (v: Date | string | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());

/** A row of eval_routes in the tma-route/2 shape. Columns that the contract does not name are left out. */
export function routeView(r: RouteRecord): RouteV2 {
  return {
    format: ROUTE_FORMAT_V2,
    id: r.id,
    tenant: r.tenant,
    use_case_key: r.use_case_key,
    route_target: r.route_target,
    target_value: r.target_value,
    rollback_value: r.rollback_value,
    model_id: r.model_id,
    agent_sha256: r.agent_sha256,
    harness: ROUTE_HARNESSES.has(r.harness) ? (r.harness as RouteV2["harness"]) : null,
    harness_repo_sha: r.harness_repo_sha,
    rules_sha256: r.rules_sha256,
    skills_sha256: r.skills_sha256 === null ? null : [r.skills_sha256],
    fallback_model_id: r.fallback_model_id,
    fallback_agent_sha256: r.fallback_agent_sha256,
    picked_rule: r.picked_rule as RouteRule,
    verdict: r.verdict as string,
    n: r.n as number,
    evidence_run_ids: [...r.evidence_run_ids],
    compare_profile_sha256: r.compare_profile_sha256 as string,
    policy_version: r.policy_version as string,
    state: r.state,
    pr_url: r.pr_url,
    approved_by_actor: r.approved_by_actor,
    approved_at: iso(r.approved_at),
    live_at: iso(r.live_at),
    rollback_pr_url: r.rollback_pr_url,
    rolled_back_at: iso(r.rolled_back_at),
    created_at: iso(r.created_at) as string,
    updated_at: iso(r.updated_at) as string,
  };
}

// ---------------------------------------------------------------------------------------------
// The approve rule (pure)

/** JSON with sorted keys, for a stable digest. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** sha256 of the compare profile (the canonical JSON of the response's `profile`, without its own `sha256`). */
export function compareProfileSha256(profile: UseCaseCompareView["profile"]): string {
  const { sha256: _ignored, ...rest } = profile;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

/** The verdict under `rule` in the eval_routes vocabulary; null when the library refused the rule. */
export function cellVerdict(cell: CompareAgentView, rule: RouteRule): string | null {
  if (rule === "absolute") {
    const map: Record<string, string> = { SAME: "same", CLOSE: "close", "NOT YET": "not_yet" };
    return map[cell.absolute.label] ?? null;
  }
  const map: Record<string, string> = { better: "better", tie: "same", worse: "worse" };
  return map[cell.relative.label] ?? null;
}

export interface ApproveBody {
  use_case: string;
  agent: string;
  current_agent: string | null;
  picked_rule: RouteRule;
  route_target: string;
  target_value: string;
  rollback_value: string | null;
  fallback_agent: string | null;
  policy_version: string;
}

const APPROVE_KEYS = new Set([
  "use_case", "agent", "current_agent", "picked_rule", "route_target", "target_value", "rollback_value", "fallback_agent", "policy_version",
]);
const APPROVE_REQUIRED = ["use_case", "agent", "current_agent", "picked_rule", "route_target", "target_value", "rollback_value"];

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The closed approve body. Every string has the pattern and the length limit of its eval_routes column. */
export function parseApproveBody(body: unknown): Parsed<ApproveBody> {
  if (!isPlainObject(body)) return { ok: false, message: "the body must be a JSON object" };
  const unknown = Object.keys(body).filter((k) => !APPROVE_KEYS.has(k));
  if (unknown.length) return { ok: false, message: `unknown key: ${unknown.sort().join(", ").slice(0, 80)}` };
  const missing = APPROVE_REQUIRED.filter((k) => !(k in body));
  if (missing.length) return { ok: false, message: `missing key: ${missing.join(", ")}` };
  const str = (k: string, re: RegExp, nullable: boolean): string | null | undefined => {
    const v = body[k];
    if (v === null && nullable) return null;
    if (typeof v !== "string" || !re.test(v)) return undefined;
    return v;
  };
  const checks: [string, RegExp, boolean][] = [
    ["use_case", USE_CASE_PAIR_RE, false],
    ["agent", AGENT_KEY_RE, false],
    ["current_agent", AGENT_KEY_RE, true],
    ["route_target", ROUTE_TARGET_RE, false],
    ["target_value", VALUE_RE, false],
    ["rollback_value", VALUE_RE, true],
  ];
  const out: Record<string, string | null> = {};
  for (const [k, re, nullable] of checks) {
    const v = str(k, re, nullable);
    if (v === undefined) return { ok: false, message: `${k} is not valid` };
    out[k] = v;
  }
  const rule = body.picked_rule;
  if (typeof rule !== "string" || !(ROUTE_RULES as readonly string[]).includes(rule)) {
    return { ok: false, message: `picked_rule must be one of ${ROUTE_RULES.join(", ")}` };
  }
  let fallback: string | null = null;
  if ("fallback_agent" in body) {
    const v = str("fallback_agent", AGENT_KEY_RE, true);
    if (v === undefined) return { ok: false, message: "fallback_agent is not valid" };
    fallback = v;
  }
  let policy = DEFAULT_ROUTE_POLICY_VERSION;
  if ("policy_version" in body) {
    const v = str("policy_version", POLICY_RE, false);
    if (typeof v !== "string") return { ok: false, message: "policy_version is not valid" };
    policy = v;
  }
  return {
    ok: true,
    value: {
      use_case: out.use_case!,
      agent: out.agent!,
      current_agent: out.current_agent ?? null,
      picked_rule: rule as RouteRule,
      route_target: out.route_target!,
      target_value: out.target_value!,
      rollback_value: out.rollback_value ?? null,
      fallback_agent: fallback,
      policy_version: policy,
    },
  };
}

/** The principal ids of TMA_ROUTE_APPLY_ACTORS. Empty when unset (nobody may mark a route). */
export function applyActorsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.TMA_ROUTE_APPLY_ACTORS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Postgres store

export class PgRoutesStore implements RoutesStore {
  constructor(private readonly pool: () => Pool) {}

  ready(): Promise<boolean> {
    return hasEvalRoutesSchema(this.pool());
  }

  async variantRefs(variantIds: string[], owner: string, tenant: string): Promise<VariantRef[]> {
    if (!variantIds.length) return [];
    const { rows } = await this.pool().query(
      `select id, agent_sha256, harness, harness_repo_sha, model_id, rules_sha256, skills_sha256
         from public.eval_variants
        where id = any($1::uuid[]) and owner_wallet = $2 and tenant = $3`,
      [variantIds, owner, tenant],
    );
    return rows.map((r: Record<string, unknown>) => ({
      variantId: String(r.id),
      agentSha256: String(r.agent_sha256),
      harness: String(r.harness),
      harnessRepoSha: (r.harness_repo_sha as string | null) ?? null,
      modelId: String(r.model_id),
      rulesSha256: (r.rules_sha256 as string | null) ?? null,
      skillsSha256: (r.skills_sha256 as string | null) ?? null,
    }));
  }

  async insertApproved(r: NewApprovedRoute): Promise<RouteRecord> {
    const { rows } = await this.pool().query(
      `insert into public.eval_routes (
         tenant, use_case_key, route_target, target_value, rollback_value,
         agent_sha256, harness, harness_repo_sha, model_id, rules_sha256, skills_sha256,
         fallback_agent_sha256, fallback_harness, fallback_harness_repo_sha, fallback_model_id, fallback_rules_sha256,
         fallback_skills_sha256, picked_rule, verdict, n, evidence_run_ids, compare_profile_sha256, policy_version,
         state, approved_by_actor, approved_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::uuid[], $22, $23,
               'approved', $24, now())
       returning *`,
      [
        r.tenant, r.use_case_key, r.route_target, r.target_value, r.rollback_value,
        r.agent_sha256, r.harness, r.harness_repo_sha, r.model_id, r.rules_sha256, r.skills_sha256,
        r.fallback_agent_sha256, r.fallback_harness, r.fallback_harness_repo_sha, r.fallback_model_id, r.fallback_rules_sha256,
        r.fallback_skills_sha256, r.picked_rule, r.verdict, r.n, r.evidence_run_ids, r.compare_profile_sha256, r.policy_version,
        r.approved_by_actor,
      ],
    );
    return rows[0] as RouteRecord;
  }

  async get(id: string, tenant: string): Promise<RouteRecord | null> {
    const { rows } = await this.pool().query(`select * from public.eval_routes where id = $1 and tenant = $2`, [id, tenant]);
    return (rows[0] as RouteRecord | undefined) ?? null;
  }

  async list(tenant: string, filter: RouteFilter, limit: number): Promise<RouteRecord[]> {
    const { rows } = await this.pool().query(
      `select * from public.eval_routes
        where tenant = $1 and ($2::text is null or use_case_key = $2) and ($3::text is null or state = $3)
        order by created_at desc, id desc
        limit $4`,
      [tenant, filter.useCase ?? null, filter.state ?? null, limit],
    );
    return rows as RouteRecord[];
  }

  async appliedOnTarget(tenant: string, routeTarget: string, exceptId: string): Promise<AppliedRoute | null> {
    const { rows } = await this.pool().query(
      `select id, state from public.eval_routes
        where tenant = $1 and route_target = $2 and state in ('live', 'needs_check') and id <> $3
        order by live_at desc nulls last, id limit 1`,
      [tenant, routeTarget, exceptId],
    );
    const r = rows[0] as { id: string; state: AppliedRoute["state"] } | undefined;
    return r ? { id: String(r.id), state: r.state } : null;
  }

  async transition(id: string, tenant: string, from: RouteState, to: PatchTarget, prUrl: string | null): Promise<RouteRecord | null> {
    if ((to === "needs_check") !== (prUrl === null)) throw new Error(`transition to ${to}: pr_url must be ${to === "needs_check" ? "null" : "set"}`);
    const set =
      to === "live" ? ", pr_url = $5, live_at = now()" : to === "rolled_back" ? ", rollback_pr_url = $5, rolled_back_at = now()" : "";
    const { rows } = await this.pool().query(
      `update public.eval_routes set state = $4${set}, updated_at = now()
        where id = $1 and tenant = $2 and state = $3
        returning *`,
      prUrl === null ? [id, tenant, from, to] : [id, tenant, from, to, prUrl],
    );
    return (rows[0] as RouteRecord | undefined) ?? null;
  }
}

// ---------------------------------------------------------------------------------------------
// Router

export interface RoutesRouterDeps {
  store: RoutesStore;
  /** The compare reader (the same rows as GET /use-cases/:key/compare). */
  reader: UseCaseCompareReader;
  /** TMA_RESULT_TENANT (default devfellowship). */
  tenant?: string;
  /** TMA_ROUTE_APPLY_ACTORS (default: read from the environment). */
  applyActors?: string[];
}

/** PATCH transitions: the target state → the states it may come from. Every other pair → 409 invalid_transition. */
const TRANSITIONS: Readonly<Record<PatchTarget, readonly RouteState[]>> = {
  live: ["approved"],
  needs_check: ["live"],
  // A needs_check route is still applied in the file: it rolls back like a live one.
  rolled_back: ["live", "needs_check"],
};
const isPatchTarget = (s: string): s is PatchTarget => Object.prototype.hasOwnProperty.call(TRANSITIONS, s);

const pgCode = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;

export function createRoutesRouter(deps: RoutesRouterDeps): Router {
  const router = Router();
  const tenant = deps.tenant ?? resultTenantFromEnv();
  const applyActors = new Set(deps.applyActors ?? applyActorsFromEnv());

  const notReady = (res: Response) =>
    res.status(503).json({ error: "schema_not_ready", message: `database schema is not migrated yet (needs db/migrations/${EVAL_ROUTES_MIGRATION})` });

  router.post("/routes/approve", requirePrincipal, async (req: Request, res: Response, next: NextFunction) => {
    const parsed = parseApproveBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: "invalid_body", message: parsed.message });
      return;
    }
    const b = parsed.value;
    const actor = req.principal!.id;
    if (!ACTOR_RE.test(actor)) {
      // approved_by_actor is a lower-case actor key (0026): a principal id outside it (a base58 wallet) cannot approve.
      res.status(403).json({ error: "approver_not_supported", message: "this login cannot approve a route (use a DFL login)" });
      return;
    }
    try {
      if (!(await deps.store.ready())) {
        notReady(res);
        return;
      }
      const rows = await deps.reader.rowsOf(b.use_case, actor, tenant);
      const keys = new Set(rows.runs.map(agentKeyOf));
      if (!keys.has(b.agent)) {
        res.status(400).json({ error: "unknown_agent", message: "agent is not an agent of your runs of this use case" });
        return;
      }
      if (b.current_agent !== null && !keys.has(b.current_agent)) {
        res.status(400).json({ error: "unknown_current_agent", message: "current_agent is not an agent of your runs of this use case" });
        return;
      }
      if (b.fallback_agent !== null && !keys.has(b.fallback_agent)) {
        res.status(400).json({ error: "unknown_fallback_agent", message: "fallback_agent is not an agent of your runs of this use case" });
        return;
      }
      // The verdict: the same reader and library as GET /use-cases/:key/compare.
      const view = compareView(b.use_case, rows, b.current_agent);
      const cell = view.agents.find((a) => a.agent_key === b.agent)!;
      if (cell.n < ROUTE_MIN_N) {
        res.status(400).json({ error: "n_too_small", message: `the cell has n=${cell.n}; a route needs n >= ${ROUTE_MIN_N} runs per cell`, n: cell.n });
        return;
      }
      const verdict = cellVerdict(cell, b.picked_rule);
      if (verdict === null || !routeVerdictPasses(b.picked_rule, verdict)) {
        const label = b.picked_rule === "absolute" ? cell.absolute.label : cell.relative.label;
        res.status(400).json({
          error: "verdict_not_passing",
          message: `the ${b.picked_rule} verdict is ${label}; a route needs a passing verdict under the picked rule`,
          verdict: label,
        });
        return;
      }
      // The evidence: the counted runs of the cell (infra fault and no-score runs are not counted), and under the
      // relative rule also the counted runs of the current agent it was compared with. countedRunIdsOf is the same
      // helper as the compare response's evidence_run_ids.
      const libRuns = useCaseRunsOf(rows);
      const sides = [...new Set([b.agent, ...(b.picked_rule === "relative" && b.current_agent ? [b.current_agent] : [])])];
      const evidenceIds = [...new Set(sides.flatMap((k) => countedRunIdsOf(libRuns, k, b.use_case)))];
      if (evidenceIds.length > ROUTE_MAX_EVIDENCE) {
        res.status(400).json({ error: "evidence_too_large", message: `the verdict cites ${evidenceIds.length} runs; the limit is ${ROUTE_MAX_EVIDENCE}` });
        return;
      }
      // The agent refs from the variant rows (owner + tenant scoped again: a row the caller does not own never backs a route).
      const variantOf = (key: string) => rows.runs.find((r) => agentKeyOf(r) === key)!.variantId;
      const wanted = [variantOf(b.agent), ...(b.fallback_agent ? [variantOf(b.fallback_agent)] : [])];
      const refs = await deps.store.variantRefs(wanted, actor, tenant);
      const refOf = (variantId: string) => refs.find((r) => r.variantId === variantId);
      const ref = refOf(wanted[0]!);
      const fb = b.fallback_agent ? refOf(wanted[1]!) : null;
      if (!ref || fb === undefined) {
        res.status(403).json({ error: "forbidden", message: "the evidence is not yours or not in this tenant" });
        return;
      }
      if (!ROUTE_HARNESSES.has(ref.harness)) {
        res.status(400).json({ error: "unsupported_harness", message: `a route names one of ${[...ROUTE_HARNESSES].join(", ")}` });
        return;
      }
      const row = await deps.store.insertApproved({
        tenant,
        use_case_key: b.use_case,
        route_target: b.route_target,
        target_value: b.target_value,
        rollback_value: b.rollback_value,
        agent_sha256: ref.agentSha256,
        harness: ref.harness,
        harness_repo_sha: ref.harnessRepoSha,
        model_id: ref.modelId,
        rules_sha256: ref.rulesSha256,
        skills_sha256: ref.skillsSha256,
        fallback_agent_sha256: fb?.agentSha256 ?? null,
        fallback_harness: fb?.harness ?? null,
        fallback_harness_repo_sha: fb?.harnessRepoSha ?? null,
        fallback_model_id: fb?.modelId ?? null,
        fallback_rules_sha256: fb?.rulesSha256 ?? null,
        fallback_skills_sha256: fb?.skillsSha256 ?? null,
        picked_rule: b.picked_rule,
        verdict,
        n: cell.n,
        evidence_run_ids: evidenceIds,
        compare_profile_sha256: compareProfileSha256(view.profile),
        policy_version: b.policy_version,
        approved_by_actor: actor,
      });
      res.status(201).json(routeView(row));
    } catch (e) {
      next(e);
    }
  });

  router.patch("/routes/:id/state", requirePrincipal, async (req: Request, res: Response, next: NextFunction) => {
    if (!applyActors.has(req.principal!.id)) {
      res.status(403).json({ error: "not_an_apply_actor", message: "only the apply path (TMA_ROUTE_APPLY_ACTORS) may change a route state" });
      return;
    }
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "invalid_id", message: "the route id must be a uuid" });
      return;
    }
    const body: unknown = req.body;
    if (!isPlainObject(body) || !("state" in body)) {
      res.status(400).json({ error: "invalid_body", message: "the body is {state, pr_url}, or exactly {state} for needs_check" });
      return;
    }
    if (typeof body.state !== "string" || !(ROUTE_STATES as readonly string[]).includes(body.state)) {
      res.status(400).json({ error: "invalid_body", message: `state must be one of ${ROUTE_STATES.join(", ")}` });
      return;
    }
    const keys = Object.keys(body);
    let prUrl: string | null = null;
    if (body.state === "needs_check") {
      // A trigger marks the route; it carries no PR (ADR-7). Closed body: any other key → 400.
      if (keys.length !== 1) {
        res.status(400).json({ error: "invalid_body", message: "the body for needs_check is exactly {state}" });
        return;
      }
    } else {
      if (keys.length !== 2 || !("pr_url" in body)) {
        res.status(400).json({ error: "invalid_body", message: "the body is exactly {state, pr_url}" });
        return;
      }
      if (typeof body.pr_url !== "string" || !PR_URL_RE.test(body.pr_url)) {
        res.status(400).json({ error: "invalid_body", message: "pr_url must be https://github.com/<owner>/<repo>/pull/<n>" });
        return;
      }
      prUrl = body.pr_url;
    }
    const to = body.state as RouteState;
    try {
      if (!(await deps.store.ready())) {
        notReady(res);
        return;
      }
      const route = await deps.store.get(id, tenant);
      if (!route) {
        res.status(404).json({ error: "not_found", message: "no route with this id in this tenant" });
        return;
      }
      if (!isPatchTarget(to) || !TRANSITIONS[to].includes(route.state)) {
        res.status(409).json({ error: "invalid_transition", message: `a route in state ${route.state} cannot move to ${to}`, state: route.state });
        return;
      }
      const from = route.state;
      // A live OR needs_check route on the same target still holds its value in the file: refuse a second apply.
      const conflict = async (): Promise<boolean> => {
        if (to !== "live") return false;
        const applied = await deps.store.appliedOnTarget(tenant, route.route_target, id);
        if (applied === null) return false;
        res.status(409).json({
          error: "live_route_exists",
          message: `route ${applied.id} (state ${applied.state}) is already applied on ${route.route_target}`,
          live_route_id: applied.id,
          live_route_state: applied.state,
        });
        return true;
      };
      if (await conflict()) return;
      let moved: RouteRecord | null;
      try {
        moved = await deps.store.transition(id, tenant, from, to, prUrl);
      } catch (e) {
        // A concurrent mark won the one-live index (eval_routes_one_live_idx).
        if (pgCode(e) === "23505" && (await conflict())) return;
        throw e;
      }
      if (!moved) {
        const now = await deps.store.get(id, tenant);
        res.status(409).json({ error: "invalid_transition", message: `the route state changed meanwhile`, state: now?.state ?? null });
        return;
      }
      res.json(routeView(moved));
    } catch (e) {
      next(e);
    }
  });

  router.get("/routes", requirePrincipal, async (req: Request, res: Response, next: NextFunction) => {
    const keys = Object.keys(req.query);
    const extra = keys.filter((k) => k !== "use_case" && k !== "state");
    if (extra.length) {
      res.status(400).json({ error: "invalid_query", message: `unknown query parameter: ${extra.sort().join(", ").slice(0, 80)}` });
      return;
    }
    const filter: RouteFilter = {};
    const uc = req.query.use_case;
    if (uc !== undefined) {
      if (typeof uc !== "string" || !USE_CASE_PAIR_RE.test(uc)) {
        res.status(400).json({ error: "invalid_query", message: "use_case must be one L1 pair type/subtype" });
        return;
      }
      filter.useCase = uc;
    }
    const st = req.query.state;
    if (st !== undefined) {
      if (typeof st !== "string" || !(ROUTE_STATES as readonly string[]).includes(st)) {
        res.status(400).json({ error: "invalid_query", message: `state must be one of ${ROUTE_STATES.join(", ")}` });
        return;
      }
      filter.state = st as RouteState;
    }
    try {
      if (!(await deps.store.ready())) {
        notReady(res);
        return;
      }
      const rows = await deps.store.list(tenant, filter, ROUTES_LIST_LIMIT);
      res.json({ routes: rows.map(routeView) });
    } catch (e) {
      next(e);
    }
  });

  router.get("/routes/:id", requirePrincipal, async (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "invalid_id", message: "the route id must be a uuid" });
      return;
    }
    try {
      if (!(await deps.store.ready())) {
        notReady(res);
        return;
      }
      const row = await deps.store.get(id, tenant);
      if (!row) {
        res.status(404).json({ error: "not_found", message: "no route with this id in this tenant" });
        return;
      }
      res.json(routeView(row));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

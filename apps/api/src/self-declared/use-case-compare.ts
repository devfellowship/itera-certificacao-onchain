/**
 * GET /use-cases/:key/compare — the comparison of the agents of ONE use case, derived on read (plan
 * 20261112-tma-c7-model-comparison-per-use-case, task C7-T3; ADR-2, ADR-4, ADR-5, ADR-7). No table of its own
 * (ADR-5): the route reads the runs, cases, variants and grader results of the caller and gives them to
 * `compareUseCase` of `@itera/contracts/compare`. Every rule (run score, both verdicts, Pareto) lives in that
 * library (ADR-7); this file only maps rows and names fields.
 *
 *   :key           an L1 pair `type/subtype` (URL-encoded `/`, the pattern of eval_cases.use_case_key with the
 *                  subtype required). Anything else → 400 invalid_use_case.
 *   query          only `current_agent` (an agent key of this response, or the uuid of one of its variants). Any
 *                  other parameter, or a repeated one → 400 invalid_query (a free-text field is refused). An
 *                  unknown agent → 400 unknown_current_agent.
 *   auth, scope    a session (requirePrincipal), as GET /eval-cases. Only the caller's own rows in the configured
 *                  result tenant (TMA_RESULT_TENANT) count: the case, the run and the variant must each be in that
 *                  tenant and owned by the caller. A row of another principal or tenant never enters a number.
 *                  A use case with no row of the caller answers 200 with `agents: []` (the same as an unknown one).
 *   agent key      `<model_id>#<agent_sha256>`: the base agent version (agent_sha256, which digests the harness,
 *                  the model, rules, skills, MCP and tools) plus its model id. The variants of one base agent
 *                  (variant_sha256) are one agent here; `variant_ids` lists them.
 *   graders        the LATEST grading row per (run, grader version) (a re-grade adds a row), with the stored
 *                  `weight`, `hard_gate`, `decisive` and the version's `kind`. A stored weight of 0 is passed as
 *                  "no weight" (the library ignores the row as `no_weight`).
 *   cost           runs.model_cost_usd with runs.model_cost_source: `metered` → metered, `derived` or `mixed` →
 *                  derived, `unpriced` / `none` / no value → no cost.
 *   profile        v1: the stored per-result weight and hard gate (the weight the run used, ADR-3) and the library
 *                  defaults (min runs per cell 5, margin 5 points, bars 95/85): `profile.source = "defaults"`.
 *   performance    two queries (runs ⋈ cases ⋈ variants; grader_results ⋈ grader_versions), no N+1.
 *   not ready      503 schema_not_ready before 0023.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import {
  compareUseCase, RELATIVE_ALPHA, type GraderRow, type UseCaseAgentCell, type UseCaseComparison, type UseCaseProfile, type UseCaseRun,
} from "@itera/contracts/compare";
import { requirePrincipal } from "../auth/middleware.js";
import { hasEvalResultsSchema } from "../domain/schema-features.js";
import { EVAL_RESULTS_MIGRATION, resultTenantFromEnv } from "./store.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An L1 pair `type/subtype` (eval_cases.use_case_key with the subtype required). */
export const USE_CASE_PAIR_RE = /^[a-z0-9][a-z0-9-]{0,30}\/[a-z0-9][a-z0-9-]{0,30}$/;
/** `<model_id>#<agent_sha256>` (model_id: the eval_variants.model_id pattern). */
export const AGENT_KEY_RE =
  /^[a-z0-9][a-z0-9.-]{0,31}(\/[a-z0-9][a-z0-9.-]{0,31})?\/[A-Za-z0-9][A-Za-z0-9._:-]{0,63}#[0-9a-f]{64}$/;
const ALLOWED_QUERY = new Set(["current_agent"]);

/** One run of the use case (one row of runs ⋈ eval_cases ⋈ eval_variants). */
export interface CompareRunRow {
  runId: string;
  caseKey: string;
  variantId: string;
  agentSha256: string;
  modelId: string;
  harness: string;
  infraOk: boolean | null;
  costUsd: number | null;
  /** runs.model_cost_source: metered | derived | mixed | unpriced | none | null. */
  costSource: string | null;
  wallMs: number | null;
}

/** The latest grading row of one grader version on one run. */
export interface CompareGraderRow {
  runId: string;
  graderId: string;
  semver: string;
  kind: string;
  pass: boolean;
  weight: number;
  hardGate: boolean;
  decisive: boolean;
}

export interface UseCaseRows {
  runs: CompareRunRow[];
  graders: CompareGraderRow[];
}

export interface UseCaseCompareReader {
  /** False before 0023 (the route answers 503). */
  ready(): Promise<boolean>;
  /** The runs of every case with this use case key, owned by `owner` in `tenant`, and their latest grader rows. */
  rowsOf(useCaseKey: string, owner: string, tenant: string): Promise<UseCaseRows>;
}

export const agentKeyOf = (r: { agentSha256: string; modelId: string }): string => `${r.modelId}#${r.agentSha256}`;

function costOf(r: CompareRunRow): { costUsd: number | null; costSource: "metered" | "derived" | null } {
  if (r.costUsd === null || !Number.isFinite(r.costUsd)) return { costUsd: null, costSource: null };
  if (r.costSource === "metered") return { costUsd: r.costUsd, costSource: "metered" };
  if (r.costSource === "derived" || r.costSource === "mixed") return { costUsd: r.costUsd, costSource: "derived" };
  if (r.costSource === "unpriced" || r.costSource === "none") return { costUsd: null, costSource: null };
  // A cost with no source: a number, but never `metered` (the library labels the cell `derived`).
  return { costUsd: r.costUsd, costSource: null };
}

/** The rows of a use case as library runs. Exported for the unit test. */
export function useCaseRunsOf(rows: UseCaseRows): UseCaseRun[] {
  const byRun = new Map<string, GraderRow[]>();
  for (const g of rows.graders) {
    const list = byRun.get(g.runId) ?? [];
    list.push({
      graderId: `${g.graderId}@${g.semver}`,
      kind: g.kind,
      pass: g.pass,
      weight: g.weight > 0 ? g.weight : null,
      hardGate: g.hardGate,
      decisive: g.decisive,
    });
    byRun.set(g.runId, list);
  }
  return rows.runs.map((r) => ({
    runId: r.runId,
    agentKey: agentKeyOf(r),
    caseKey: r.caseKey,
    infraOk: r.infraOk !== false,
    ...costOf(r),
    wallMs: r.wallMs,
    graders: byRun.get(r.runId) ?? [],
  }));
}

/**
 * Output rounding only (every rule ran on the full values): scores, means, gaps and quantiles to 2 decimals, a USD
 * cost to 6 decimals (runs.model_cost_usd is numeric(12,6)), a p value to 4 significant digits.
 */
function r2(x: number): number;
function r2(x: number | null): number | null;
function r2(x: number | null): number | null {
  return x === null ? null : Math.round(x * 100) / 100;
}
const r6 = (x: number | null): number | null => (x === null ? null : Math.round(x * 1e6) / 1e6);
const p4 = (x: number): number => Number(x.toPrecision(4));

/**
 * The verdicts without the fields that repeat a value of the agent row or of the profile (size budget: 33 use cases
 * x 10 agents in 200 KB): absolute drops n, infra_excluded, hard_gate_failures (top level) and min_score
 * (= distribution.min); relative drops n_variant (= n), mean_variant (= mean_score: a failed hard gate already scores
 * 0), n_base and mean_base (= n and mean_score of the current agent's row) and margin, alpha and test (profile);
 * pareto drops eligible (= ineligible_reason === null).
 */
function absoluteView(a: UseCaseAgentCell["absolute"]) {
  return {
    label: a.label, reason: a.reason, runs_at_least_same: a.runsAtLeastSame, runs_at_least_close: a.runsAtLeastClose,
  };
}
function relativeView(v: UseCaseAgentCell["relative"]) {
  return {
    label: v.label,
    reason: v.reason,
    gap: r2(v.gap),
    mann_whitney: v.mannWhitney ? { u: v.mannWhitney.u, p: p4(v.mannWhitney.p), method: v.mannWhitney.method } : null,
  };
}
const distributionView = (d: UseCaseAgentCell["distribution"]) =>
  d === null ? null : { min: r2(d.min), p10: r2(d.p10), p50: r2(d.p50), p90: r2(d.p90), max: r2(d.max) };

export interface CompareAgentView {
  agent_key: string;
  variant_ids: string[];
  model_id: string;
  harness: string;
  n: number;
  infra_error_count: number;
  no_score_runs: number;
  hard_gate_failures: number;
  mean_score: number | null;
  distribution: UseCaseAgentCell["distribution"];
  cost_per_task: number | null;
  cost_label: "metered" | "derived" | null;
  median_wall_ms: number | null;
  absolute: ReturnType<typeof absoluteView>;
  relative: ReturnType<typeof relativeView>;
  pareto: { ineligible_reason: UseCaseAgentCell["pareto"]["ineligibleReason"]; on_front: boolean | null; dominated: boolean | null };
}

export interface UseCaseCompareView {
  use_case: string;
  profile: {
    source: "defaults";
    sha256: null;
    weights: "stored_per_result";
    min_runs_per_cell: number;
    relative_margin_points: number;
    relative_alpha: number;
    relative_test: "mann-whitney-u";
    absolute_bars: { same: number; close: number };
  };
  rule_text: { absolute: string; relative: string };
  current_agent: string | null;
  agents: CompareAgentView[];
}

/** The response body from the rows (pure). `currentAgentKey` must be null or an agent of `rows`. */
export function compareView(useCase: string, rows: UseCaseRows, currentAgentKey: string | null): UseCaseCompareView {
  // v1 profile: no grader list; every counted row carries its stored weight and hard gate (ADR-3).
  const profile: UseCaseProfile = { useCase, graders: [] };
  const result: UseCaseComparison = compareUseCase(useCaseRunsOf(rows), profile, { currentAgentKey });
  const meta = new Map<string, { variantIds: Set<string>; modelId: string; harness: string }>();
  for (const r of rows.runs) {
    const k = agentKeyOf(r);
    const m = meta.get(k) ?? { variantIds: new Set<string>(), modelId: r.modelId, harness: r.harness };
    m.variantIds.add(r.variantId);
    meta.set(k, m);
  }
  return {
    use_case: result.useCase,
    profile: {
      source: "defaults",
      sha256: null,
      weights: "stored_per_result",
      min_runs_per_cell: result.profile.minRunsPerCell,
      relative_margin_points: result.profile.relativeMarginPoints,
      relative_alpha: RELATIVE_ALPHA,
      relative_test: "mann-whitney-u",
      absolute_bars: { ...result.profile.absoluteBars },
    },
    rule_text: { ...result.ruleText },
    current_agent: currentAgentKey,
    agents: result.agents.map((a) => {
      const m = meta.get(a.agentKey)!;
      return {
        agent_key: a.agentKey,
        variant_ids: [...m.variantIds].sort(),
        model_id: m.modelId,
        harness: m.harness,
        n: a.n,
        infra_error_count: a.infraExcluded,
        no_score_runs: a.noScoreRuns,
        hard_gate_failures: a.hardGateFailures,
        mean_score: r2(a.meanScore),
        distribution: distributionView(a.distribution),
        cost_per_task: r6(a.costPerTask),
        cost_label: a.costLabel,
        median_wall_ms: a.medianWallMs,
        absolute: absoluteView(a.absolute),
        relative: relativeView(a.relative),
        pareto: { ineligible_reason: a.pareto.ineligibleReason, on_front: a.pareto.onFront, dominated: a.pareto.dominated },
      };
    }),
  };
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export class PgUseCaseCompareReader implements UseCaseCompareReader {
  constructor(private readonly pool: () => Pool) {}

  ready(): Promise<boolean> {
    return hasEvalResultsSchema(this.pool());
  }

  async rowsOf(useCaseKey: string, owner: string, tenant: string): Promise<UseCaseRows> {
    const pool = this.pool();
    const runs = await pool.query(
      `select r.id as run_id, c.case_key, v.id as variant_id, v.agent_sha256, v.model_id, v.harness, r.infra_ok,
              r.model_cost_usd, r.model_cost_source, r.wall_ms
         from public.runs r
         join public.eval_cases c on c.id = r.case_id
         join public.eval_variants v on v.id = r.variant_id
        where c.use_case_key = $1
          and c.tenant = $3 and c.owner_wallet = $2
          and v.tenant = $3 and v.owner_wallet = $2
          and r.owner_wallet = $2
        order by r.started_at, r.id`,
      [useCaseKey, owner, tenant],
    );
    const runIds = runs.rows.map((r: { run_id: string }) => r.run_id);
    const graders = runIds.length
      ? await pool.query(
          // The latest row of each grader version on each run (a re-grade adds a row); the grading must be in the
          // same tenant.
          `select distinct on (gr.run_id, gr.grader_version_id)
                  gr.run_id, gv.grader_id, gv.semver, gv.kind, gr.pass, gr.weight, gr.hard_gate, gr.decisive
             from public.grader_results gr
             join public.grader_versions gv on gv.id = gr.grader_version_id and gv.tenant = gr.tenant
            where gr.run_id = any($1::uuid[]) and gr.tenant = $2
            order by gr.run_id, gr.grader_version_id, gr.graded_at desc, gr.id desc`,
          [runIds, tenant],
        )
      : { rows: [] };
    return {
      runs: runs.rows.map((r: Record<string, unknown>) => ({
        runId: String(r.run_id),
        caseKey: String(r.case_key),
        variantId: String(r.variant_id),
        agentSha256: String(r.agent_sha256),
        modelId: String(r.model_id),
        harness: String(r.harness),
        infraOk: (r.infra_ok as boolean | null) ?? null,
        costUsd: num(r.model_cost_usd),
        costSource: (r.model_cost_source as string | null) ?? null,
        wallMs: num(r.wall_ms),
      })),
      graders: graders.rows.map((g: Record<string, unknown>) => ({
        runId: String(g.run_id),
        graderId: String(g.grader_id),
        semver: String(g.semver),
        kind: String(g.kind),
        pass: Boolean(g.pass),
        weight: Number(g.weight),
        hardGate: Boolean(g.hard_gate),
        decisive: Boolean(g.decisive),
      })),
    };
  }
}

export interface UseCaseCompareRouterDeps {
  reader: UseCaseCompareReader;
  /** TMA_RESULT_TENANT (default devfellowship). */
  tenant?: string;
}

export function createUseCaseCompareRouter(deps: UseCaseCompareRouterDeps): Router {
  const router = Router();
  const tenant = deps.tenant ?? resultTenantFromEnv();

  router.get("/use-cases/:key/compare", requirePrincipal, async (req: Request, res: Response, next: NextFunction) => {
    const key = String(req.params.key);
    if (!USE_CASE_PAIR_RE.test(key)) {
      res.status(400).json({ error: "invalid_use_case", message: "the use case must be an L1 pair type/subtype (URL-encode the /)" });
      return;
    }
    const extra = Object.keys(req.query).filter((k) => !ALLOWED_QUERY.has(k));
    if (extra.length) {
      res.status(400).json({ error: "invalid_query", message: `unknown query parameter: ${extra.sort().join(", ").slice(0, 80)}` });
      return;
    }
    const raw = req.query.current_agent;
    if (raw !== undefined && (typeof raw !== "string" || !(UUID_RE.test(raw) || AGENT_KEY_RE.test(raw)))) {
      res.status(400).json({ error: "invalid_query", message: "current_agent must be one agent key or one variant uuid" });
      return;
    }
    try {
      if (!(await deps.reader.ready())) {
        res.status(503).json({ error: "schema_not_ready", message: `database schema is not migrated yet (needs db/migrations/${EVAL_RESULTS_MIGRATION})` });
        return;
      }
      const rows = await deps.reader.rowsOf(key, req.principal!.id, tenant);
      let current: string | null = null;
      if (typeof raw === "string") {
        const hit = UUID_RE.test(raw)
          ? rows.runs.find((r) => r.variantId.toLowerCase() === raw.toLowerCase())
          : rows.runs.find((r) => agentKeyOf(r) === raw);
        if (!hit) {
          res.status(400).json({ error: "unknown_current_agent", message: "current_agent is not an agent of this use case" });
          return;
        }
        current = agentKeyOf(hit);
      }
      res.json(compareView(key, rows, current));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

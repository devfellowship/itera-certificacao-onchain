/**
 * Read side of studio S9, the trajectory wall and path map (plan 20261112-tma-c5-studio-area-web2, task C5-T9; plan
 * 20261112-tma-c9-trajectory-analytics ADR-6, Q-T20 = A: TMA runs only, no fleet run). Needs
 * db/migrations/0024_eval_summary_steps_grader_meta.sql (run_actions.step_kind). Read only.
 *
 *   GET /trajectories   the finished runs that the caller may see, newest first, each as one compact row: id,
 *                       evaluationId, agentId, status, resultOrigin, `kinds` (the trajectory-shapes/1 kind string, one
 *                       letter per step), `truncated`, `steps` (the step count) and `firstFailure` (0-based index of the
 *                       first step with ok = false, or null). Plus `pathMap`: the pruned prefix tree of those runs with
 *                       n, pass and passRate per node and the parent -> child edges.
 *                       Filters: ?agent=<agent uuid>, ?task=<task id or slug>, ?origin=hosted|self_declared,
 *                       ?limit=<1..1000> (default 300; a larger value is cut to 1000).
 *
 * Scope: a hosted run of an issued public evaluation (a public result: it shows on the public agent and task pages),
 * plus every run whose owner_wallet is the caller (the caller's own uploaded runs). Another principal's private run
 * never appears.
 *
 * The rules (step-kind map, kind string, first failure, path-map prune, shape) are NOT here: they come from
 * packages/contracts/trajectory-shapes.js, which reads trajectory-shapes/spec.json. The path map is computed here,
 * server-side, for two reasons: that module reads the spec with node:fs, so it cannot go into the web bundle without a
 * second copy of the rules; and the client gets only the kept nodes instead of every step of every run.
 * While spec.named_shapes is false no `shape` key is sent (consumer_rule: no shape label on a screen).
 *
 * One SQL query: the runs are picked first (filters, order, limit), then a lateral aggregate reads the steps of each
 * picked run through run_actions (run_id, seq) (the unique index of 0003).
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import {
  TRAJECTORY_SHAPES_SPEC,
  firstFailure,
  kindString,
  pathMap,
  pathOf,
  shapeOf,
  type ShapeStep,
} from "@itera/contracts";
import { requirePrincipal } from "../auth/middleware.js";
import { hasEvalMetaSchema } from "../domain/schema-features.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_RE = /^[A-Za-z0-9._:@/-]{1,200}$/;
const META_MIGRATION = "0024_eval_summary_steps_grader_meta.sql";

export const TRAJECTORIES_DEFAULT_LIMIT = 300;
export const TRAJECTORIES_MAX_LIMIT = 1000;
export const FINISHED_STATUSES = ["pass", "fail", "timeout", "invalid", "infra_error"] as const;
export type RunStatus = (typeof FINISHED_STATUSES)[number];
export type ResultOrigin = "hosted" | "self_declared";

/** One run as the reader returns it: the steps in seq order (step_kind may be null on an old row). */
export interface TrajectoryRunRecord {
  id: string;
  evaluationId: string | null;
  agentId: string | null;
  status: RunStatus;
  resultOrigin: ResultOrigin;
  stepKinds: Array<string | null>;
  oks: Array<boolean | null>;
}

export interface TrajectoriesFilter {
  agentId?: string;
  task?: string;
  origin?: ResultOrigin;
}

export interface TrajectoriesReader {
  /** False before 0024: the route answers 503. */
  ready(): Promise<boolean>;
  /** The runs in scope for `owner`, newest first, at most `limit`. */
  list(owner: string, filter: TrajectoriesFilter, limit: number): Promise<TrajectoryRunRecord[]>;
}

/** One row of the wall. */
export interface TrajectoryRunView {
  id: string;
  evaluationId: string | null;
  agentId: string | null;
  status: RunStatus;
  resultOrigin: ResultOrigin;
  /** The kind string (alphabet R S W T M X), cut at spec.kind_string.max_chars. */
  kinds: string;
  truncated: boolean;
  steps: number;
  /** 0-based index of the first failed step (also past the cut), or null. */
  firstFailure: number | null;
  /** Only while spec.named_shapes is true. */
  shape?: string;
}

export interface PathMapNodeView {
  path: string;
  n: number;
  pass: number;
  /** pass / n, two decimals. */
  passRate: number;
}

export interface TrajectoriesResponse {
  schema: string;
  namedShapes: boolean;
  fallback: string;
  runs: TrajectoryRunView[];
  pathMap: { totalRuns: number; nodes: PathMapNodeView[]; edges: Array<{ from: string; to: string }> };
  limit: number;
  truncated: boolean;
}

/**
 * The step of one stored row for the spec. A null step_kind (a row that the 0024 back-fill missed) is `other`, the
 * closed kind for "not classified" (letter X). A null ok is not a failure: only ok = false is.
 */
function shapeSteps(r: TrajectoryRunRecord): ShapeStep[] {
  return r.stepKinds.map((k, i) => ({ kind_source: "step_kind", value: k ?? "other", ok: r.oks[i] !== false }));
}

export function runView(r: TrajectoryRunRecord, namedShapes: boolean = TRAJECTORY_SHAPES_SPEC.named_shapes): TrajectoryRunView {
  const steps = shapeSteps(r);
  const ks = kindString(steps);
  const ff = firstFailure(steps);
  const view: TrajectoryRunView = {
    id: r.id,
    evaluationId: r.evaluationId,
    agentId: r.agentId,
    status: r.status,
    resultOrigin: r.resultOrigin,
    kinds: ks.kind_string,
    truncated: ks.truncated,
    steps: steps.length,
    firstFailure: ff ? ff.first_fail_seq : null,
  };
  if (namedShapes) view.shape = shapeOf(ks.kind_string);
  return view;
}

/** The spec's pruned path map of the runs, with the pass count of each kept node and the tree edges. */
export function pathMapView(runs: readonly TrajectoryRunView[]): TrajectoriesResponse["pathMap"] {
  const { nodes } = pathMap(runs.map((r) => r.kinds));
  const kept = new Set(nodes.map((n) => n.path));
  const passPaths = runs.filter((r) => r.status === "pass").map((r) => pathOf(r.kinds));
  return {
    totalRuns: runs.length,
    nodes: nodes.map(({ path, n }) => {
      const pass = passPaths.filter((p) => p.startsWith(path)).length;
      return { path, n, pass, passRate: Math.round((pass / n) * 100) / 100 };
    }),
    // Pruning keeps a prefix whenever it keeps a longer path (n only grows toward the root), so the parent of a kept
    // node of depth >= 2 is kept too; a depth-1 node is a root.
    edges: nodes.filter((n) => n.path.length > 1 && kept.has(n.path.slice(0, -1))).map((n) => ({ from: n.path.slice(0, -1), to: n.path })),
  };
}

export function trajectoriesResponse(records: readonly TrajectoryRunRecord[], limit: number, namedShapes: boolean = TRAJECTORY_SHAPES_SPEC.named_shapes): TrajectoriesResponse {
  const picked = records.slice(0, limit);
  const runs = picked.map((r) => runView(r, namedShapes));
  return {
    schema: TRAJECTORY_SHAPES_SPEC.schema,
    namedShapes,
    fallback: TRAJECTORY_SHAPES_SPEC.fallback,
    runs,
    pathMap: pathMapView(runs),
    limit,
    truncated: records.length > limit,
  };
}

/** The one SQL query of PgTrajectoriesReader. Exported for the unit test of its shape. */
export const TRAJECTORIES_SQL = `with picked as (
  select r.id, r.evaluation_id, e.agent_id, r.status, r.result_origin, r.started_at
    from public.runs r
    left join public.evaluations e on e.id = r.evaluation_id
   where r.status = any($5::text[])
     and ((r.result_origin = 'hosted' and e.status = 'issued' and e.is_public) or r.owner_wallet = $1)
     and ($2::uuid is null or e.agent_id = $2::uuid)
     and ($3::text is null or r.task_id = $3 or r.task_id in (select t.id::text from public.tasks t where t.slug = $3))
     and ($4::text is null or r.result_origin = $4)
   order by r.started_at desc, r.id
   limit $6
)
select p.id, p.evaluation_id, p.agent_id, p.status, p.result_origin, s.kinds, s.oks
  from picked p
  cross join lateral (
    select coalesce(array_agg(a.step_kind order by a.seq), '{}'::text[]) as kinds,
           coalesce(array_agg(a.ok order by a.seq), '{}'::boolean[]) as oks
      from public.run_actions a
     where a.run_id = p.id
  ) s
 order by p.started_at desc, p.id`;

export class PgTrajectoriesReader implements TrajectoriesReader {
  constructor(private readonly pool: () => Pool) {}

  ready(): Promise<boolean> {
    return hasEvalMetaSchema(this.pool());
  }

  async list(owner: string, filter: TrajectoriesFilter, limit: number): Promise<TrajectoryRunRecord[]> {
    const { rows } = await this.pool().query(TRAJECTORIES_SQL, [
      owner,
      filter.agentId ?? null,
      filter.task ?? null,
      filter.origin ?? null,
      [...FINISHED_STATUSES],
      limit,
    ]);
    return rows.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      evaluationId: r.evaluation_id == null ? null : String(r.evaluation_id),
      agentId: r.agent_id == null ? null : String(r.agent_id),
      status: r.status as RunStatus,
      resultOrigin: r.result_origin === "hosted" ? "hosted" : "self_declared",
      stepKinds: (r.kinds as Array<string | null>) ?? [],
      oks: (r.oks as Array<boolean | null>) ?? [],
    }));
  }
}

export interface TrajectoriesRouterOptions {
  /** Test seam: the spec flag (TRAJECTORY_SHAPES_SPEC.named_shapes by default). */
  namedShapes?: boolean;
}

type Parsed = { ok: true; filter: TrajectoriesFilter; limit: number } | { ok: false; message: string };

export function parseTrajectoriesQuery(q: Request["query"]): Parsed {
  const one = (k: string): string | undefined => (typeof q[k] === "string" && q[k] !== "" ? (q[k] as string) : undefined);
  const filter: TrajectoriesFilter = {};
  const agent = one("agent");
  if (agent !== undefined) {
    if (!UUID_RE.test(agent)) return { ok: false, message: "agent must be an agent uuid" };
    filter.agentId = agent;
  }
  const task = one("task");
  if (task !== undefined) {
    if (!TASK_RE.test(task)) return { ok: false, message: "task must be a task id or slug" };
    filter.task = task;
  }
  const origin = one("origin");
  if (origin !== undefined) {
    if (origin !== "hosted" && origin !== "self_declared") return { ok: false, message: "origin must be hosted or self_declared" };
    filter.origin = origin;
  }
  let limit = TRAJECTORIES_DEFAULT_LIMIT;
  const l = one("limit");
  if (l !== undefined) {
    if (!/^\d{1,7}$/.test(l) || Number(l) < 1) return { ok: false, message: `limit must be an integer from 1 to ${TRAJECTORIES_MAX_LIMIT}` };
    limit = Math.min(Number(l), TRAJECTORIES_MAX_LIMIT);
  }
  return { ok: true, filter, limit };
}

export function createTrajectoriesRouter(reader: TrajectoriesReader, options: TrajectoriesRouterOptions = {}): Router {
  const router = Router();
  router.get("/trajectories", requirePrincipal, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = parseTrajectoriesQuery(req.query);
      if (!parsed.ok) return void res.status(400).json({ error: "invalid_query", message: parsed.message });
      if (!(await reader.ready())) {
        return void res.status(503).json({ error: "schema_not_ready", message: `database schema is not migrated yet (needs db/migrations/${META_MIGRATION})` });
      }
      // One more row than the limit tells the client that the list is cut.
      const records = await reader.list(req.principal!.id, parsed.filter, parsed.limit + 1);
      res.json(trajectoriesResponse(records, parsed.limit, options.namedShapes ?? TRAJECTORY_SHAPES_SPEC.named_shapes));
    } catch (e) {
      next(e);
    }
  });
  return router;
}

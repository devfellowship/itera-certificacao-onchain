/**
 * Human labels for judge calibration (plan 20261112-tma-c6-judge-calibration, task T3, ADR-3, ADR-6; parent ADR-24).
 * The studio S13 review screen writes ONE thing: a grader_results row of kind `human` on a run. Needs 0024
 * (grader_results.labeler, reason_code); before it every route answers 503 schema_not_ready.
 *
 *   POST /grader-results/human     body EXACTLY {run_id, judge_id, pass, reason_code?}. Stores one grader_results row:
 *                                  grader version = the human label grader `label-<judge_id>@1.0.0` of the tenant
 *                                  (kind human, code_sha256 = humanLabelDigest, the kit's humanGraderDigest rule,
 *                                  created on first use; its own id, because a run's graders may not repeat an id and
 *                                  the judge result of the same run carries `<judge_id>`), pass, score 100 | 0, weight 0, hard_gate false, decisive false,
 *                                  infra_ok true, labeler = the caller (labelerOf), reason_code. 201 with the row.
 *   GET  /grader-results/human     ?run_id=<uuid>: the human labels of one run, newest first.
 *   GET  /review-queue/steps       ?run_id=<uuid>: the redacted steps of one run (tool, target, status, duration, start in ms), the
 *                                  detail behind the step boxes of S13. Same tenant checks as the labels.
 *   GET  /review-queue             ?judge=<id>[&limit=1..200]: the trace_review runs of the tenant that no person has
 *                                  labeled yet for that judge (a label under judge A keeps the run in the queue of judge B;
 *                                  a `workflow:` label does not close it), each with the task summary, the folded step kinds, the judge verdict, the workflow
 *                                  label and the caller's own label. Order: judge and workflow label disagree first
 *                                  (failure-driven sampling, book p132), then runs the caller has not labeled, newest
 *                                  first.
 *
 * Tenancy: a run belongs to the tenant of its eval case. A run of another tenant → 403 run_other_tenant; a run with no
 * case → 409 run_has_no_case; an unknown or malformed run id → 404. A siws login → 403 not_a_dfl_login.
 * The judge id must be one of LABEL_JUDGE_IDS (the judges of dfl-evals judges/; one PR adds a new one). No free text is
 * stored: the body holds ids, a boolean and a closed reason code.
 */
import { createHash } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import { requirePrincipal } from "../auth/middleware.js";
import type { Principal } from "../auth/adapters/types.js";
import { hasEvalMetaSchema } from "../domain/schema-features.js";
import { resultTenantFromEnv } from "./store.js";

export const HUMAN_LABELS_MIGRATION = "0024_eval_summary_steps_grader_meta.sql";
/** The judges of devfellowship/dfl-evals judges/ (C6-T1). A label for another id is refused. */
export const LABEL_JUDGE_IDS: readonly string[] = ["async-wait-lifecycle", "external-block-handling"];
/** The human label grader of a judge mode: `label-<judge id>@1.0.0`, one row per mode, independent of the judge version.
 * A separate id, because tma-local-result/3 refuses two graders with one id on a run (the judge result uses the judge id). */
export const LABEL_GRADER_SEMVER = "1.0.0";
export const labelGraderId = (judgeId: string): string => `label-${judgeId}`;
export const REASON_CODES = ["wrong_sha", "no_check", "partial", "other"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export const QUEUE_DEFAULT_LIMIT = 50;
export const QUEUE_MAX_LIMIT = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_KEYS = new Set(["run_id", "judge_id", "pass", "reason_code"]);

/** The kit's humanGraderDigest (services/runner/src/cli/eval/trace-review.ts): the same id@version is one row. */
export function humanLabelDigest(id: string, version: string): string {
  return createHash("sha256").update(`tma-human-label/1\n${id}@${version}`).digest("hex");
}

/** person:<uuid> for a proven human actor, agent:<uuid> for an agent login, user:<uuid> otherwise (fail closed: only
 * `person:` labels count as human labels in a calibration split). */
export function labelerOf(p: Principal): string {
  const uuid = p.id.replace(/^dfl:/, "").toLowerCase();
  return `${p.actorType === "human" ? "person" : p.actorType === "agent" ? "agent" : "user"}:${uuid}`;
}

export interface HumanLabel {
  id: string;
  runId: string;
  judgeId: string;
  pass: boolean;
  reasonCode: ReasonCode | null;
  labeler: string | null;
  gradedAt: string;
}

export interface Verdict {
  pass: boolean;
  labeler: string | null;
  gradedAt: string;
}

export interface ReviewRun {
  runId: string;
  caseKey: string;
  useCaseKey: string;
  originPinSha256: string | null;
  taskSummary: { before: string | null; expected: string | null } | null;
  modelId: string | null;
  status: string;
  startedAt: string;
  /** The folded trajectory: one step kind per step (null on an old row) and its ok flag. */
  steps: Array<{ seq: number; kind: string | null; ok: boolean | null }>;
  judge: Verdict | null;
  workflow: Verdict | null;
  mine: Verdict | null;
  disagree: boolean;
}

/** null = no such run; tenant null = a run with no eval case. */
export type RunTenant = { tenant: string | null } | null;

/** One step of a run, as the uploader redacted it (tma-trajectory): the tool, a redacted target (a path, a command's
 * program and sub-command, a host), the outcome, the duration and the start in ms from the start of the run.
 * No arguments, no tool output and no prompt text: they never left the host (parent Q-T9 = A). */
export interface StepDetail {
  seq: number;
  tool: string;
  target: string | null;
  kind: string | null;
  status: string | null;
  errorClass: string | null;
  durationMs: number | null;
  startedMs: number | null;
  turnOrigin: string | null;
}
export const STEPS_MAX = 2000;

export interface HumanLabelStore {
  ready(): Promise<boolean>;
  runTenant(runId: string): Promise<RunTenant>;
  insert(row: { tenant: string; runId: string; judgeId: string; pass: boolean; reasonCode: ReasonCode | null; labeler: string }): Promise<HumanLabel>;
  labels(runId: string, tenant: string): Promise<HumanLabel[]>;
  queue(tenant: string, judgeId: string, labeler: string, limit: number): Promise<ReviewRun[]>;
  steps(runId: string, tenant: string): Promise<StepDetail[]>;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const orNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function verdict(v: unknown): Verdict | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return { pass: Boolean(o.pass), labeler: orNull(o.labeler), gradedAt: iso(o.at) };
}

/** Disagreements first, then runs without the caller's label, then newest first. */
export function queueOrder(runs: ReviewRun[]): ReviewRun[] {
  return [...runs].sort((a, b) => Number(b.disagree) - Number(a.disagree) || Number(a.mine !== null) - Number(b.mine !== null) || b.startedAt.localeCompare(a.startedAt));
}

export class PgHumanLabelStore implements HumanLabelStore {
  constructor(private readonly pool: () => Pool) {}

  ready(): Promise<boolean> {
    return hasEvalMetaSchema(this.pool());
  }

  async runTenant(runId: string): Promise<RunTenant> {
    const { rows } = await this.pool().query(
      `select c.tenant from public.runs r left join public.eval_cases c on c.id = r.case_id where r.id = $1`,
      [runId],
    );
    return rows[0] ? { tenant: orNull(rows[0].tenant) } : null;
  }

  async insert(row: { tenant: string; runId: string; judgeId: string; pass: boolean; reasonCode: ReasonCode | null; labeler: string }): Promise<HumanLabel> {
    const client = await this.pool().connect();
    try {
      await client.query("begin");
      const gid = labelGraderId(row.judgeId);
      const digest = humanLabelDigest(gid, LABEL_GRADER_SEMVER);
      await client.query(
        `insert into public.grader_versions (tenant, grader_id, semver, kind, code_sha256) values ($1, $2, $3, 'human', $4)
         on conflict (tenant, grader_id, semver, code_sha256) do nothing`,
        [row.tenant, gid, LABEL_GRADER_SEMVER, digest],
      );
      const gv = await client.query(
        `select id from public.grader_versions where tenant = $1 and grader_id = $2 and semver = $3 and code_sha256 = $4`,
        [row.tenant, gid, LABEL_GRADER_SEMVER, digest],
      );
      const { rows } = await client.query(
        `insert into public.grader_results (tenant, run_id, grader_version_id, pass, score, weight, hard_gate, decisive, infra_ok, labeler, reason_code)
         values ($1, $2, $3, $4, $5, 0, false, false, true, $6, $7) returning id, graded_at`,
        [row.tenant, row.runId, gv.rows[0].id, row.pass, row.pass ? 100 : 0, row.labeler, row.reasonCode],
      );
      await client.query("commit");
      return { id: String(rows[0].id), runId: row.runId, judgeId: row.judgeId, pass: row.pass, reasonCode: row.reasonCode, labeler: row.labeler, gradedAt: iso(rows[0].graded_at) };
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async labels(runId: string, tenant: string): Promise<HumanLabel[]> {
    const { rows } = await this.pool().query(
      `select gr.id, gr.run_id, g.grader_id, gr.pass, gr.reason_code, gr.labeler, gr.graded_at
         from public.grader_results gr join public.grader_versions g on g.id = gr.grader_version_id and g.tenant = gr.tenant
        where gr.run_id = $1 and gr.tenant = $2 and g.kind = 'human' and g.grader_id like 'label-%'
        order by gr.graded_at desc, gr.id`,
      [runId, tenant],
    );
    return rows.map((r: Record<string, unknown>) => ({
      id: String(r.id), runId: String(r.run_id), judgeId: String(r.grader_id).replace(/^label-/, ""), pass: Boolean(r.pass),
      reasonCode: (r.reason_code ?? null) as ReasonCode | null, labeler: orNull(r.labeler), gradedAt: iso(r.graded_at),
    }));
  }

  async queue(tenant: string, judgeId: string, labeler: string, limit: number): Promise<ReviewRun[]> {
    const latest = (gidParam: string, where: string) => `(select json_build_object('pass', gr.pass, 'labeler', gr.labeler, 'at', gr.graded_at)
        from public.grader_results gr join public.grader_versions g on g.id = gr.grader_version_id and g.tenant = gr.tenant
       where gr.run_id = t.id and gr.tenant = $1 and g.grader_id = ${gidParam} and ${where}
       order by gr.graded_at desc, gr.id limit 1)`;
    const { rows } = await this.pool().query(
      `with t as (
         select r.id, r.status, r.started_at, c.case_key, c.use_case_key, c.origin_pin_sha256, c.task_summary, v.model_id
           from public.runs r join public.eval_cases c on c.id = r.case_id
           left join public.eval_variants v on v.id = r.variant_id
          where c.tenant = $1 and c.mode = 'trace_review'
            -- The queue of a judge holds the runs that no person has labeled yet for THIS judge. A workflow label is a
            -- weak signal and does not close the review. Both rubrics apply to every run, so the other judge keeps the run.
            and not exists (
              select 1 from public.grader_results hl join public.grader_versions hg on hg.id = hl.grader_version_id and hg.tenant = hl.tenant
               where hl.run_id = r.id and hl.tenant = $1 and hg.grader_id = $4 and hg.kind = 'human' and coalesce(hl.labeler, '') not like 'workflow:%')
          order by r.started_at desc, r.id limit 1000)
       select t.*,
              ${latest("$2", "g.kind = 'judge'")} as judge,
              ${latest("$4", "g.kind = 'human' and gr.labeler like 'workflow:%'")} as workflow,
              ${latest("$4", "g.kind = 'human' and gr.labeler = $3")} as mine,
              (select coalesce(json_agg(json_build_object('seq', a.seq, 'kind', a.step_kind, 'ok', a.ok) order by a.seq), '[]'::json)
                 from public.run_actions a where a.run_id = t.id) as steps
         from t`,
      [tenant, judgeId, labeler, labelGraderId(judgeId)],
    );
    const runs: ReviewRun[] = rows.map((r: Record<string, unknown>) => {
      const judge = verdict(r.judge);
      const workflow = verdict(r.workflow);
      const ts = r.task_summary && typeof r.task_summary === "object" ? (r.task_summary as Record<string, unknown>) : null;
      return {
        runId: String(r.id), caseKey: String(r.case_key), useCaseKey: String(r.use_case_key), originPinSha256: orNull(r.origin_pin_sha256),
        taskSummary: ts ? { before: orNull(ts.before), expected: orNull(ts.expected) } : null,
        modelId: orNull(r.model_id), status: String(r.status), startedAt: iso(r.started_at),
        steps: Array.isArray(r.steps) ? (r.steps as ReviewRun["steps"]) : [],
        judge, workflow, mine: verdict(r.mine),
        disagree: judge !== null && workflow !== null && judge.pass !== workflow.pass,
      };
    });
    return queueOrder(runs).slice(0, limit);
  }

  async steps(runId: string, tenant: string): Promise<StepDetail[]> {
    const { rows } = await this.pool().query(
      `select a.seq, a.tool, a.target, a.step_kind, a.status, a.error_class, a.duration_ms, a.started_ms, a.turn_origin
         from public.run_actions a join public.runs r on r.id = a.run_id join public.eval_cases c on c.id = r.case_id
        where a.run_id = $1 and c.tenant = $2 and c.mode = 'trace_review'
        order by a.seq limit ${STEPS_MAX}`,
      [runId, tenant],
    );
    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    return rows.map((r: Record<string, unknown>) => ({
      seq: Number(r.seq), tool: String(r.tool), target: orNull(r.target), kind: orNull(r.step_kind), status: orNull(r.status),
      errorClass: orNull(r.error_class), durationMs: num(r.duration_ms), startedMs: num(r.started_ms), turnOrigin: orNull(r.turn_origin),
    }));
  }
}

export interface HumanLabelsRouterDeps {
  store: HumanLabelStore;
  /** TMA_RESULT_TENANT by default. */
  tenant?: string;
}

class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function createHumanLabelsRouter(deps: HumanLabelsRouterDeps): Router {
  const router = Router();
  const tenant = () => deps.tenant ?? resultTenantFromEnv();

  const guard = async (req: Request): Promise<void> => {
    if (req.principal?.kind !== "dfl") throw new Refusal(403, "not_a_dfl_login", "labels take a Login with DFL session");
    if (!(await deps.store.ready())) throw new Refusal(503, "schema_not_ready", `database schema is not migrated yet (needs db/migrations/${HUMAN_LABELS_MIGRATION})`);
  };
  const runOfTenant = async (runId: unknown): Promise<string> => {
    if (typeof runId !== "string" || !UUID_RE.test(runId)) throw new Refusal(404, "run_not_found", "run not found");
    const rt = await deps.store.runTenant(runId.toLowerCase());
    if (!rt) throw new Refusal(404, "run_not_found", "run not found");
    if (rt.tenant === null) throw new Refusal(409, "run_has_no_case", "the run has no eval case, so it cannot carry a label");
    if (rt.tenant !== tenant()) throw new Refusal(403, "run_other_tenant", "the run belongs to another tenant");
    return runId.toLowerCase();
  };
  const fail = (res: Response, next: NextFunction) => (e: unknown) => {
    if (e instanceof Refusal) res.status(e.status).json({ error: e.code, message: e.message });
    else next(e);
  };

  router.post("/grader-results/human", requirePrincipal, (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      await guard(req);
      const b = req.body as Record<string, unknown> | undefined;
      if (!b || typeof b !== "object" || Array.isArray(b)) throw new Refusal(400, "invalid_body", "the body is a JSON object");
      const extra = Object.keys(b).filter((k) => !BODY_KEYS.has(k));
      if (extra.length > 0) throw new Refusal(400, "invalid_body", `unknown key: ${extra[0]!.slice(0, 40)} (a label holds no free text)`);
      if (typeof b.judge_id !== "string" || !LABEL_JUDGE_IDS.includes(b.judge_id)) throw new Refusal(400, "unknown_judge", `judge_id is one of ${LABEL_JUDGE_IDS.join(", ")}`);
      if (typeof b.pass !== "boolean") throw new Refusal(400, "invalid_body", "pass is true or false");
      const rc = b.reason_code ?? null;
      if (rc !== null && !REASON_CODES.includes(rc as ReasonCode)) throw new Refusal(400, "invalid_body", `reason_code is one of ${REASON_CODES.join(", ")}, or null`);
      const runId = await runOfTenant(b.run_id);
      const label = await deps.store.insert({ tenant: tenant(), runId, judgeId: b.judge_id, pass: b.pass, reasonCode: rc as ReasonCode | null, labeler: labelerOf(req.principal!) });
      res.status(201).json(label);
    })().catch(fail(res, next));
  });

  router.get("/grader-results/human", requirePrincipal, (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      await guard(req);
      const runId = await runOfTenant(req.query.run_id);
      res.json({ labels: await deps.store.labels(runId, tenant()) });
    })().catch(fail(res, next));
  });

  router.get("/review-queue", requirePrincipal, (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      await guard(req);
      const judge = req.query.judge;
      if (typeof judge !== "string" || !LABEL_JUDGE_IDS.includes(judge)) throw new Refusal(400, "unknown_judge", `judge is one of ${LABEL_JUDGE_IDS.join(", ")}`);
      const n = req.query.limit === undefined ? QUEUE_DEFAULT_LIMIT : Number(req.query.limit);
      if (!Number.isInteger(n) || n < 1) throw new Refusal(400, "invalid_query", `limit is an integer from 1 to ${QUEUE_MAX_LIMIT}`);
      const runs = await deps.store.queue(tenant(), judge, labelerOf(req.principal!), Math.min(n, QUEUE_MAX_LIMIT));
      res.json({ judge, judges: LABEL_JUDGE_IDS, runs });
    })().catch(fail(res, next));
  });

  router.get("/review-queue/steps", requirePrincipal, (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      await guard(req);
      const runId = await runOfTenant(req.query.run_id);
      res.json({ run_id: runId, steps: await deps.store.steps(runId, tenant()) });
    })().catch(fail(res, next));
  });

  return router;
}

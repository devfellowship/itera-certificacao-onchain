/**
 * Human labels for judge calibration (plan 20261112-tma-c6-judge-calibration, task T3, ADR-3, ADR-6; parent ADR-24).
 * The studio S13 review screen writes ONE thing: a grader_results row of kind `human` on a run. Needs 0024
 * (grader_results.labeler, reason_code); before it every route answers 503 schema_not_ready.
 *
 *   POST /grader-results/human     body EXACTLY {run_id, judge_id, pass, reason_code?, workflow_signal?}. Stores one grader_results row:
 *                                  grader version = the human label grader `label-<judge_id>@1.0.0` of the tenant
 *                                  (kind human, code_sha256 = humanLabelDigest, the kit's humanGraderDigest rule,
 *                                  created on first use; its own id, because a run's graders may not repeat an id and
 *                                  the judge result of the same run carries `<judge_id>`), pass, score 100 | 0, weight 0, hard_gate false, decisive false,
 *                                  infra_ok true, labeler = the caller (labelerOf), reason_code. 201 with the row.
 *                                  With workflow_signal (task C6-T2, Q-C6-T2 = A): a WORKFLOW label, labeler =
 *                                  `workflow:<signal>`. Only an agent login may write one, only a pass (T2 writes weak
 *                                  pass labels only), only a signal of WORKFLOW_SIGNALS, and reason_code is required.
 *                                  Idempotent: the same run, judge and signal again answers 200 with the stored row and
 *                                  `unchanged: true`. Every label read carries `strength` (labelStrength).
 *   GET  /grader-results/human     ?run_id=<uuid>: the human labels of one run, newest first.
 *   GET  /review-queue/runs        ?case_key=<key>: the trace_review runs of one case of the tenant ({run_id, started_at}), so a
 *                                  label writer on the host finds the run of a batch row (tma eval workflow-labels).
 *   GET  /review-queue/steps       ?run_id=<uuid>: the redacted steps of one run (tool, target, status, duration, start in ms), the
 *                                  detail behind the step boxes of S13. Same tenant checks as the labels.
 *   GET  /review-queue/progress    ?judge=<id>: the person labels of the tenant for that judge, counted per split and per verdict
 *                                  ({test: {pass, fail}, dev, train, unknown}, the T4 floor of 30), so S13 shows "x of 30 pass, x of 30
 *                                  fail" in the test split. Per run only the latest person label counts (calibration-labels chooseLabel);
 *                                  a workflow, agent or user label is not counted. Counts only: no run id, no labeler.
 *   GET  /review-queue             ?judge=<id>[&limit=1..200]: the trace_review runs of the tenant that no person has
 *                                  labeled yet for that judge (a label under judge A keeps the run in the queue of judge B;
 *                                  a `workflow:` label does not close it), each with the task summary, the folded step kinds, the judge verdict, the workflow
 *                                  label and the caller's own label, and its `split` for that judge (train, dev or test, or null
 *                                  when the task is unknown). Order (Tainan, Q 0a6c8599 = B, 2026-11-17): test-split runs
 *                                  first, then dev, then train, then the rest; inside a split, judge and workflow label
 *                                  disagree first (failure-driven sampling, book p132), then runs the caller has not
 *                                  labeled, newest first.
 *
 * Tenancy: a run belongs to the tenant of its eval case. A run of another tenant → 403 run_other_tenant; a run with no
 * case → 409 run_has_no_case; an unknown or malformed run id → 404. A siws login → 403 not_a_dfl_login.
 * The judge id must be one of LABEL_JUDGE_IDS (the judges of dfl-evals judges/; one PR adds a new one). No free text is
 * stored: the body holds ids, a boolean and a closed reason code.
 */
import { createHash } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { hostedStepKindOf } from "@itera/contracts";
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
/** The workflow signals a workflow label may name, each with its strength (plan ADR-12: a label carries its source and
 * strength). Q-C6-T2 = A: workflow signals do not separate the two judge modes, so T2 writes weak PASS labels only.
 *   clean-merge  the declared run's delivering PR merged with green CI, and trace-select knows every red signal of the
 *                run as false: no revert, no red CI, no task re-dispatch, no CI re-run, no Tainan correction in the run. */
export const WORKFLOW_SIGNALS: Readonly<Record<string, "weak" | "strong">> = { "clean-merge": "weak" };
export type LabelStrength = "weak" | "strong";
/** A person's label is strong; a workflow label has the strength of its signal; an agent or user label has none. */
export function labelStrength(labeler: string | null): LabelStrength | null {
  if (!labeler) return null;
  if (labeler.startsWith("person:")) return "strong";
  if (labeler.startsWith("workflow:")) return WORKFLOW_SIGNALS[labeler.slice("workflow:".length)] ?? null;
  return null;
}
const CASE_KEY_RE = /^[a-z0-9][a-z0-9_-]{2,62}$/;
/** The calibration split of a task for one judge: the same rule as devfellowship/dfl-evals ci/calibration_split.py
 * (sha256 of "<seed>:<judge id>:<task id>", first 8 bytes over 2^64, against the cumulative ratios 20/40/40). The seed is the
 * one of the C6 splits (plan 20261112-tma-c6-judge-calibration). A task goes to one part, so the queue and the later
 * calibration split agree on which runs are test runs. */
export const SPLIT_SEED = "20261112";
export const SPLIT_RATIOS = [20, 40, 40] as const;
export type SplitName = "train" | "dev" | "test";
export function splitOf(judgeId: string, taskId: string, seed: string = SPLIT_SEED): SplitName {
  const d = createHash("sha256").update(`${seed}:${judgeId}:${taskId}`, "utf8").digest();
  const x = Number(d.readBigUInt64BE(0)) / 2 ** 64;
  const total = SPLIT_RATIOS.reduce((a, b) => a + b, 0);
  const parts: SplitName[] = ["train", "dev", "test"];
  let acc = 0;
  for (let i = 0; i < 3; i++) {
    acc += SPLIT_RATIOS[i]! / total;
    if (x < acc) return parts[i]!;
  }
  return "test";
}
/** The task id of a recorded task slug (`dfl-task-<id>` or `tma-task-<id>`, review-batch recordedTaskRef), or null. */
export function taskIdOfSlug(slug: string | null): string | null {
  const m = slug ? /^(?:dfl|tma)-task-([0-9a-z][0-9a-z-]{2,119})$/.exec(slug) : null;
  return m ? m[1]! : null;
}
const SPLIT_RANK: Record<string, number> = { test: 0, dev: 1, train: 2 };
export const QUEUE_DEFAULT_LIMIT = 50;
/** The T4 floor of a test split: 30 pass and 30 fail person labels per judge (plan C6, T4; dfl-evals --check-floor 30). */
export const TEST_FLOOR = 30;
export type SplitCounts = Record<SplitName | "unknown", { pass: number; fail: number }>;
/** Count the latest person label of each run per split of its task for one judge. */
export function progressCounts(judgeId: string, rows: Array<{ taskSlug: string | null; pass: boolean }>): SplitCounts {
  const out: SplitCounts = { test: { pass: 0, fail: 0 }, dev: { pass: 0, fail: 0 }, train: { pass: 0, fail: 0 }, unknown: { pass: 0, fail: 0 } };
  for (const r of rows) {
    const taskId = taskIdOfSlug(r.taskSlug);
    const c = out[taskId ? splitOf(judgeId, taskId) : "unknown"];
    if (r.pass) c.pass++;
    else c.fail++;
  }
  return out;
}
export const QUEUE_MAX_LIMIT = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_KEYS = new Set(["run_id", "judge_id", "pass", "reason_code", "workflow_signal"]);

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
  /** The split of the run's task for the queue's judge; null when the task id is unknown. */
  split: SplitName | null;
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

/** The step kind that S13 shows. The kind the uploader stored (tma-trajectory/2) wins. A tma-trajectory/1 upload (every
 * recorded Claude Code session so far) stores none, so the kind is derived from the tool and the redacted target, the way
 * the hosted back-fill does (contracts/step-kind.js). Claude Code names its sub-agent tool `Agent`. */
export function displayKind(stored: string | null, tool: string, target: string | null): string {
  if (stored) return stored;
  const name = tool.toLowerCase();
  if (name === "agent") return "agent";
  if (name === "notebookedit") return "write";
  return hostedStepKindOf(tool, target);
}

export interface HumanLabelStore {
  ready(): Promise<boolean>;
  runTenant(runId: string): Promise<RunTenant>;
  insert(row: { tenant: string; runId: string; judgeId: string; pass: boolean; reasonCode: ReasonCode | null; labeler: string }): Promise<HumanLabel>;
  labels(runId: string, tenant: string): Promise<HumanLabel[]>;
  /** The trace_review runs of one case of the tenant, oldest first. */
  caseRuns(tenant: string, caseKey: string): Promise<Array<{ runId: string; startedAt: string }>>;
  queue(tenant: string, judgeId: string, labeler: string, limit: number): Promise<ReviewRun[]>;
  /** Per trace_review run of the tenant with a person label for the judge: its task slug and the verdict of the latest person label. */
  personLabels(tenant: string, judgeId: string): Promise<Array<{ taskSlug: string | null; pass: boolean }>>;
  steps(runId: string, tenant: string): Promise<StepDetail[]>;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const orNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function verdict(v: unknown): Verdict | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return { pass: Boolean(o.pass), labeler: orNull(o.labeler), gradedAt: iso(o.at) };
}

/** Test split first, then dev, train, unknown; inside a split: disagreements, runs without the caller's label, newest. */
export function queueOrder(runs: ReviewRun[]): ReviewRun[] {
  const rank = (r: ReviewRun) => (r.split ? SPLIT_RANK[r.split]! : 3);
  return [...runs].sort((a, b) => rank(a) - rank(b) || Number(b.disagree) - Number(a.disagree) || Number(a.mine !== null) - Number(b.mine !== null) || b.startedAt.localeCompare(a.startedAt));
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

  async caseRuns(tenant: string, caseKey: string): Promise<Array<{ runId: string; startedAt: string }>> {
    const { rows } = await this.pool().query(
      `select r.id, r.started_at from public.runs r join public.eval_cases c on c.id = r.case_id
        where c.tenant = $1 and c.case_key = $2 and c.mode = 'trace_review'
        order by r.started_at, r.id limit 50`,
      [tenant, caseKey],
    );
    return rows.map((r: Record<string, unknown>) => ({ runId: String(r.id), startedAt: iso(r.started_at) }));
  }

  async queue(tenant: string, judgeId: string, labeler: string, limit: number): Promise<ReviewRun[]> {
    const latest = (gidParam: string, where: string) => `(select json_build_object('pass', gr.pass, 'labeler', gr.labeler, 'at', gr.graded_at)
        from public.grader_results gr join public.grader_versions g on g.id = gr.grader_version_id and g.tenant = gr.tenant
       where gr.run_id = t.id and gr.tenant = $1 and g.grader_id = ${gidParam} and ${where}
       order by gr.graded_at desc, gr.id limit 1)`;
    const { rows } = await this.pool().query(
      `with t as (
         select r.id, r.status, r.started_at, c.case_key, c.use_case_key, c.origin_pin_sha256, c.task_summary, v.model_id, tk.slug as task_slug
           from public.runs r join public.eval_cases c on c.id = r.case_id
           left join public.eval_variants v on v.id = r.variant_id
           left join public.tasks tk on tk.id = c.task_id
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
              (select coalesce(json_agg(json_build_object('seq', a.seq, 'kind', a.step_kind, 'tool', a.tool, 'target', a.target, 'ok', a.ok) order by a.seq), '[]'::json)
                 from public.run_actions a where a.run_id = t.id) as steps
         from t`,
      [tenant, judgeId, labeler, labelGraderId(judgeId)],
    );
    const runs: ReviewRun[] = rows.map((r: Record<string, unknown>) => {
      const judge = verdict(r.judge);
      const workflow = verdict(r.workflow);
      const taskId = taskIdOfSlug(orNull(r.task_slug));
      const ts = r.task_summary && typeof r.task_summary === "object" ? (r.task_summary as Record<string, unknown>) : null;
      return {
        runId: String(r.id), caseKey: String(r.case_key), useCaseKey: String(r.use_case_key), originPinSha256: orNull(r.origin_pin_sha256),
        taskSummary: ts ? { before: orNull(ts.before), expected: orNull(ts.expected) } : null,
        modelId: orNull(r.model_id), status: String(r.status), startedAt: iso(r.started_at),
        steps: Array.isArray(r.steps)
          ? (r.steps as Array<{ seq: number; kind: string | null; tool: string; target: string | null; ok: boolean | null }>).map((x) => ({ seq: x.seq, kind: displayKind(x.kind, x.tool, x.target), ok: x.ok }))
          : [],
        judge, workflow, mine: verdict(r.mine),
        disagree: judge !== null && workflow !== null && judge.pass !== workflow.pass,
        split: taskId ? splitOf(judgeId, taskId) : null,
      };
    });
    return queueOrder(runs).slice(0, limit);
  }

  async personLabels(tenant: string, judgeId: string): Promise<Array<{ taskSlug: string | null; pass: boolean }>> {
    const { rows } = await this.pool().query(
      `select tk.slug as task_slug,
              (select gr.pass from public.grader_results gr join public.grader_versions g on g.id = gr.grader_version_id and g.tenant = gr.tenant
                where gr.run_id = r.id and gr.tenant = $1 and g.grader_id = $2 and g.kind = 'human' and gr.labeler like 'person:%'
                order by gr.graded_at desc, gr.id desc limit 1) as pass
         from public.runs r join public.eval_cases c on c.id = r.case_id
         left join public.tasks tk on tk.id = c.task_id
        where c.tenant = $1 and c.mode = 'trace_review'`,
      [tenant, labelGraderId(judgeId)],
    );
    return rows.filter((r: Record<string, unknown>) => r.pass !== null && r.pass !== undefined).map((r: Record<string, unknown>) => ({ taskSlug: orNull(r.task_slug), pass: Boolean(r.pass) }));
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
      seq: Number(r.seq), tool: String(r.tool), target: orNull(r.target), kind: displayKind(orNull(r.step_kind), String(r.tool), orNull(r.target)), status: orNull(r.status),
      errorClass: orNull(r.error_class), durationMs: num(r.duration_ms), startedMs: num(r.started_ms), turnOrigin: orNull(r.turn_origin),
    }));
  }
}

export interface HumanLabelsRouterDeps {
  store: HumanLabelStore;
  /** TMA_RESULT_TENANT by default. */
  tenant?: string;
}

const withStrength = (l: HumanLabel): HumanLabel & { strength: LabelStrength | null } => ({ ...l, strength: labelStrength(l.labeler) });

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
      let labeler = labelerOf(req.principal!);
      const signal = b.workflow_signal ?? null;
      if (signal !== null) {
        // A workflow label (C6-T2): a deterministic signal of a declared run, written by an agent, never by a person.
        if (typeof signal !== "string" || !Object.hasOwn(WORKFLOW_SIGNALS, signal)) throw new Refusal(400, "unknown_signal", `workflow_signal is one of ${Object.keys(WORKFLOW_SIGNALS).join(", ")}`);
        if (req.principal!.actorType !== "agent") throw new Refusal(403, "workflow_label_needs_agent", "a workflow label is written by an agent login; a person writes a person label");
        if (b.pass !== true) throw new Refusal(400, "workflow_label_pass_only", "a workflow label is a weak pass label (Q-C6-T2 = A)");
        if (rc === null) throw new Refusal(400, "invalid_body", "a workflow label needs a reason_code");
        labeler = `workflow:${signal}`;
      }
      const runId = await runOfTenant(b.run_id);
      if (signal !== null) {
        const same = (await deps.store.labels(runId, tenant())).find((l) => l.judgeId === b.judge_id && l.labeler === labeler);
        if (same) {
          res.status(200).json({ ...withStrength(same), unchanged: true });
          return;
        }
      }
      const label = await deps.store.insert({ tenant: tenant(), runId, judgeId: b.judge_id, pass: b.pass, reasonCode: rc as ReasonCode | null, labeler });
      res.status(201).json(withStrength(label));
    })().catch(fail(res, next));
  });

  router.get("/grader-results/human", requirePrincipal, (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      await guard(req);
      const runId = await runOfTenant(req.query.run_id);
      res.json({ labels: (await deps.store.labels(runId, tenant())).map(withStrength) });
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

  router.get("/review-queue/progress", requirePrincipal, (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      await guard(req);
      const judge = req.query.judge;
      if (typeof judge !== "string" || !LABEL_JUDGE_IDS.includes(judge)) throw new Refusal(400, "unknown_judge", `judge is one of ${LABEL_JUDGE_IDS.join(", ")}`);
      res.json({ judge, floor: TEST_FLOOR, splits: progressCounts(judge, await deps.store.personLabels(tenant(), judge)) });
    })().catch(fail(res, next));
  });

  router.get("/review-queue/runs", requirePrincipal, (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      await guard(req);
      const key = req.query.case_key;
      if (typeof key !== "string" || !CASE_KEY_RE.test(key)) throw new Refusal(400, "invalid_query", "case_key is 3 to 63 of a-z 0-9 _ -");
      const runs = await deps.store.caseRuns(tenant(), key);
      res.json({ case_key: key, runs: runs.map((r) => ({ run_id: r.runId, started_at: r.startedAt })) });
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

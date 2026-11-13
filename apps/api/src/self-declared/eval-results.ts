/**
 * Read side of the eval result store (plan 20261112-tma-c4-result-store-trajectory-upload, T3, T8; needs
 * db/migrations/0023_eval_results.sql). A test case and an agent variant are independent; a run crosses them
 * (parent plan ADR-26). `variant.isBaseline` is computed against the case in context (the case's
 * baseline_variant_id), and `predictionSha256` belongs to the crossing, not to the variant. Three parts:
 *
 *   GET /evaluations/:id   adds `case`, `variant`, `predictionSha256`, `graders` (one summary per grader version) and, on each
 *                          `tasks[]` row, `graders` (every grading row, re-grades included, oldest first) and
 *                          `trajectorySummary` (step count, first failed step, error classes).
 *   GET /runs/:id          adds `case`, `variant`, `predictionSha256`, `graders` and `trajectorySummary` for that run.
 *   GET /eval-cases/:id    owner only: the case and the agent variants that ran on it (and its baseline), each
 *                          with n, pass, pass rate, mean score, the prediction and the baseline flag. Another principal's case answers the same 404 as an
 *                          unknown one. C5-T3 adds `taskSlug` (for the /tasks/:slug link) and `graders` (the distinct id@semver
 *                          that graded a run of this case).
 *   GET /eval-cases        owner only (C5-T3, studio S1/S4): the caller's cases, newest first, each with taskSlug,
 *                          variantCount (the variants that ran on it, plus its baseline) and runCount. Capped at
 *                          EVAL_CASES_LIMIT (200): `{ cases, limit, truncated }`.
 *   GET /eval-runs         owner only (C5-T3, studio S4/S5): the caller's uploaded eval runs (runs with a case and a
 *                          variant), newest first, each with its case key, its variant (base agent + change), its
 *                          evaluation and the TMA agent of that evaluation. Filters: ?agent=<agent uuid> and
 *                          ?case=<case uuid> (another principal's id matches nothing: an empty list). Capped at
 *                          EVAL_RUNS_LIMIT (500): `{ runs, limit, truncated }`. There is no experiment table: the
 *                          studio derives an experiment from these rows (case x variant).
 *
 * The first two decorate the JSON body that their own routers send (as the 0021 run guard does with
 * `resultOrigin`): those routers keep their files, their owner checks and their 404s. A body with an `error`
 * key is never decorated.
 *
 * Deploy safety: before 0023 is applied on production, the probe answers false, the two decorators add
 * nothing (the bodies stay as they were), and GET /eval-cases/:id answers 503 schema_not_ready.
 *
 * 0024 (plan T9, T11): the case gets `taskSummary`, each grader row gets the version fields (`proof`, `calibration`,
 * `note`, `author`) and the label fields (`reasonCode`, `labeler`), and each grader summary gets the version fields.
 * Before 0024 is applied those keys are null.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import { requirePrincipal } from "../auth/middleware.js";
import { hasEvalMetaSchema, hasEvalResultsSchema } from "../domain/schema-features.js";
import { EVAL_RESULTS_MIGRATION, trajectorySummaryOf, type TrajectorySummary } from "./store.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EvalCaseView {
  id: string;
  caseKey: string;
  manifestSha256: string;
  /** Provenance of the origin trace (tma-pin/1 digest); never an agent binding. */
  originPinSha256: string | null;
  mode: "replay" | "trace_review";
  useCaseKey: string;
  taskId: string | null;
  baselineVariantId: string | null;
  /** 0024 (Q-T16 = A): the state before the task and the expected output, short human text; null when not given. */
  taskSummary: { before: string | null; expected: string | null } | null;
  createdAt: string;
}

/** 0024: the fields of a grader VERSION (null when not reported, and before 0024). */
export interface GraderVersionMetaView {
  /** The mutation proof: planted bugs caught, of planted. */
  proof: { caught: number; total: number } | null;
  /** A judge only: label counts and the 2x2 table of the test split. */
  calibration: { nLabels: number; nTest: number; tp: number; fn: number; tn: number; fp: number; realignedAt: string | null } | null;
  note: string | null;
  /** The actor key of the author. */
  author: string | null;
}

/** The base agent version of an agent variant (field names of tma-pin/1, camelCase). */
export interface AgentVersionView {
  harness: string;
  harnessVersion: string | null;
  harnessRepoSha: string | null;
  modelId: string;
  rulesSha256: string | null;
  skillsSha256: string | null;
  mcpManifestSha256: string | null;
  toolsSha256: string | null;
}

export interface EvalVariantView {
  id: string;
  agentSha256: string;
  agent: AgentVersionView;
  variantSha256: string;
  label: string;
  changeKind: string;
  /** This variant is the baseline of the case in context. */
  isBaseline: boolean;
}

export interface GraderRowView extends GraderVersionMetaView {
  id: string;
  semver: string;
  kind: string;
  codeSha256: string;
  pass: boolean;
  score: number | null;
  weight: number;
  hardGate: boolean;
  decisive: boolean;
  infraOk: boolean | null;
  /** 0024: the closed reason of a label (wrong_sha | no_check | partial | other), or null. */
  reasonCode: string | null;
  /** 0024: the actor key of the author of the label, or null. */
  labeler: string | null;
  gradedAt: string;
}

/** One grader version over the runs of an evaluation: its LATEST row per run. */
export interface GraderSummaryView extends GraderVersionMetaView {
  id: string;
  semver: string;
  kind: string;
  codeSha256: string;
  n: number;
  pass: number;
  meanScore: number | null;
  hardGate: boolean;
  decisive: boolean;
}

export interface RunEvalResults {
  graders: GraderRowView[];
  trajectorySummary: TrajectorySummary | null;
}

export interface EvalCaseVariantStats extends EvalVariantView {
  /** The prediction of this variant against the baseline, on this case (null for the baseline). */
  predictionSha256: string | null;
  /** Every run row of the variant. */
  n: number;
  pass: number;
  fail: number;
  infraErrors: number;
  /** pass / (pass + fail); null when no run was graded. */
  passRate: number | null;
  meanScore: number | null;
  evaluationIds: string[];
}

/** A grader version that graded at least one run of a case (id@semver). */
export interface CaseGraderView {
  id: string;
  semver: string;
  kind: string;
}

export interface EvalCaseDetail extends EvalCaseView {
  /** C5-T3: the slug of the case's task (for the /tasks/:slug link), or null. */
  taskSlug: string | null;
  /** C5-T3: the distinct grader versions that graded a run of this case, by id then semver. */
  graders: CaseGraderView[];
  variants: EvalCaseVariantStats[];
}

/** One row of GET /eval-cases (C5-T3). */
export interface EvalCaseListItem extends EvalCaseView {
  taskSlug: string | null;
  /** The variants that ran on the case, plus its baseline (the same set as the detail's variants). */
  variantCount: number;
  runCount: number;
  lastRunAt: string | null;
}

/** One row of GET /eval-runs (C5-T3): an uploaded run, the crossing of a case and a variant. */
export interface EvalRunRow {
  id: string;
  evaluationId: string | null;
  /** The TMA agent of the run's evaluation (the agent of `tma eval upload --agent`). */
  agentId: string | null;
  agentName: string | null;
  seq: number | null;
  status: string;
  score: number | null;
  infraOk: boolean | null;
  startedAt: string;
  caseId: string;
  caseKey: string;
  useCaseKey: string;
  variant: EvalVariantView;
  predictionSha256: string | null;
}

export interface EvalRunsFilter {
  agentId?: string | null;
  caseId?: string | null;
}

export const EVAL_CASES_LIMIT = 200;
export const EVAL_RUNS_LIMIT = 500;

export interface CaseVariantOfRun {
  case: EvalCaseView;
  variant: EvalVariantView;
  predictionSha256: string | null;
}

export interface EvalResultsReader {
  /** False before 0023: the decorators add nothing and GET /eval-cases/:id answers 503. */
  ready(): Promise<boolean>;
  /** The case and variant of an evaluation (null for a v1 or hosted evaluation). */
  caseOfEvaluation(evaluationId: string): Promise<CaseVariantOfRun | null>;
  /** The case and variant of a run (null for a v1 or hosted run). */
  caseOfRun(runId: string): Promise<CaseVariantOfRun | null>;
  /** The run ids of an evaluation. */
  runIdsOf(evaluationId: string): Promise<string[]>;
  /** Grader rows and trajectory summary per run id (every id of the input is a key). */
  resultsOfRuns(runIds: string[]): Promise<Map<string, RunEvalResults>>;
  /** The case of `owner`, or null (unknown, or another principal's). */
  caseDetail(caseId: string, owner: string): Promise<EvalCaseDetail | null>;
  /** C5-T3: the cases of `owner`, newest first, at most `limit` rows. */
  listCases(owner: string, limit: number): Promise<EvalCaseListItem[]>;
  /** C5-T3: the uploaded eval runs of `owner`, newest first, at most `limit` rows. */
  listRuns(owner: string, filter: EvalRunsFilter, limit: number): Promise<EvalRunRow[]>;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function caseView(r: Record<string, unknown>): EvalCaseView {
  return {
    id: String(r.case_id),
    caseKey: String(r.case_key),
    manifestSha256: String(r.manifest_sha256),
    originPinSha256: (r.origin_pin_sha256 as string | null) ?? null,
    mode: r.mode as EvalCaseView["mode"],
    useCaseKey: String(r.use_case_key),
    taskId: (r.task_id as string | null) ?? null,
    baselineVariantId: (r.baseline_variant_id as string | null) ?? null,
    taskSummary: summaryView(r.task_summary),
    createdAt: iso(r.case_created_at),
  };
}

function summaryView(v: unknown): EvalCaseView["taskSummary"] {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return { before: typeof o.before === "string" ? o.before : null, expected: typeof o.expected === "string" ? o.expected : null };
}

/** The grader-version fields of a joined grader_versions row (aliases gv_proof_caught, ...). */
function graderMetaView(r: Record<string, unknown>): GraderVersionMetaView {
  const c = r.gv_calibration && typeof r.gv_calibration === "object" ? (r.gv_calibration as Record<string, unknown>) : null;
  return {
    proof: r.gv_proof_total == null ? null : { caught: Number(r.gv_proof_caught), total: Number(r.gv_proof_total) },
    calibration: c
      ? {
          nLabels: Number(c.n_labels), nTest: Number(c.n_test), tp: Number(c.tp), fn: Number(c.fn), tn: Number(c.tn), fp: Number(c.fp),
          realignedAt: typeof c.realigned_at === "string" ? c.realigned_at : null,
        }
      : null,
    note: (r.gv_note as string | null) ?? null,
    author: (r.gv_author as string | null) ?? null,
  };
}

const orNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** `baselineVariantId`: the baseline of the case in context (isBaseline = this variant is it). */
function variantView(r: Record<string, unknown>, baselineVariantId: string | null): EvalVariantView {
  return {
    id: String(r.variant_id),
    agentSha256: String(r.agent_sha256),
    agent: {
      harness: String(r.harness),
      harnessVersion: orNull(r.harness_version),
      harnessRepoSha: orNull(r.harness_repo_sha),
      modelId: String(r.variant_model_id),
      rulesSha256: orNull(r.rules_sha256),
      skillsSha256: orNull(r.skills_sha256),
      mcpManifestSha256: orNull(r.mcp_manifest_sha256),
      toolsSha256: orNull(r.tools_sha256),
    },
    variantSha256: String(r.variant_sha256),
    label: String(r.label),
    changeKind: String(r.change_kind),
    isBaseline: baselineVariantId !== null && baselineVariantId === String(r.variant_id),
  };
}

const CASE_COLUMNS_0023 = `
  c.id as case_id, c.case_key, c.manifest_sha256, c.origin_pin_sha256, c.mode, c.use_case_key, c.task_id, c.baseline_variant_id,
  c.created_at as case_created_at`;
/** The case columns, with the 0024 task summary when that migration is applied. */
const caseColumns = (meta: boolean) => (meta ? `${CASE_COLUMNS_0023}, c.task_summary` : CASE_COLUMNS_0023);
const VARIANT_COLUMNS = `
  v.id as variant_id, v.agent_sha256, v.harness, v.harness_version, v.harness_repo_sha, v.model_id as variant_model_id, v.rules_sha256,
  v.skills_sha256, v.mcp_manifest_sha256, v.tools_sha256, v.variant_sha256, v.label, v.change_kind`;

export class PgEvalResultsReader implements EvalResultsReader {
  constructor(private readonly pool: () => Pool) {}

  ready(): Promise<boolean> {
    return hasEvalResultsSchema(this.pool());
  }

  private async caseWhere(where: string, id: string) {
    const meta = await hasEvalMetaSchema(this.pool());
    const { rows } = await this.pool().query(
      `select ${caseColumns(meta)}, ${VARIANT_COLUMNS}, r.prediction_sha256
         from public.runs r
         join public.eval_cases c on c.id = r.case_id
         join public.eval_variants v on v.id = r.variant_id
        where ${where} limit 1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    const kase = caseView(row);
    return { case: kase, variant: variantView(row, kase.baselineVariantId), predictionSha256: orNull(row.prediction_sha256) };
  }

  caseOfEvaluation(evaluationId: string) {
    return this.caseWhere("r.evaluation_id = $1", evaluationId);
  }

  caseOfRun(runId: string) {
    return this.caseWhere("r.id = $1", runId);
  }

  async runIdsOf(evaluationId: string): Promise<string[]> {
    const { rows } = await this.pool().query(`select id from public.runs where evaluation_id = $1 order by seq`, [evaluationId]);
    return rows.map((r: { id: string }) => r.id);
  }

  async resultsOfRuns(runIds: string[]): Promise<Map<string, RunEvalResults>> {
    const out = new Map<string, RunEvalResults>(runIds.map((id) => [id, { graders: [], trajectorySummary: null }]));
    if (!runIds.length) return out;
    const pool = this.pool();
    const meta = await hasEvalMetaSchema(pool);
    const metaCols = meta
      ? `, gr.reason_code, gr.labeler, gv.proof_caught as gv_proof_caught, gv.proof_total as gv_proof_total,
         gv.calibration as gv_calibration, gv.note as gv_note, gv.author as gv_author`
      : "";
    const [graders, steps] = await Promise.all([
      pool.query(
        `select gr.run_id, gv.grader_id, gv.semver, gv.kind, gv.code_sha256, gr.pass, gr.score, gr.weight, gr.hard_gate, gr.decisive,
                gr.infra_ok, gr.graded_at${metaCols}
           from public.grader_results gr join public.grader_versions gv on gv.id = gr.grader_version_id
          where gr.run_id = any($1::uuid[])
          order by gr.run_id, gr.graded_at, gr.id`,
        [runIds],
      ),
      // Only the structured rows (tma-trajectory/1 uploads, and hosted rows once the runner writes `status`).
      pool.query(
        `select run_id, seq, status, error_class from public.run_actions
          where run_id = any($1::uuid[]) and status is not null order by run_id, seq`,
        [runIds],
      ),
    ]);
    for (const g of graders.rows) {
      out.get(g.run_id)?.graders.push({
        id: g.grader_id, semver: g.semver, kind: g.kind, codeSha256: g.code_sha256, pass: g.pass, score: num(g.score),
        weight: Number(g.weight), hardGate: g.hard_gate, decisive: g.decisive, infraOk: g.infra_ok,
        reasonCode: g.reason_code ?? null, labeler: g.labeler ?? null, ...graderMetaView(g), gradedAt: iso(g.graded_at),
      });
    }
    const byRun = new Map<string, Array<{ seq: number; status: "ok" | "error" | "denied" | "timeout"; error_class: null }>>();
    for (const s of steps.rows) {
      const list = byRun.get(s.run_id) ?? [];
      list.push({ seq: s.seq, status: s.status, error_class: s.error_class });
      byRun.set(s.run_id, list);
    }
    for (const [id, list] of byRun) {
      const r = out.get(id);
      if (r) r.trajectorySummary = trajectorySummaryOf(list);
    }
    return out;
  }

  async caseDetail(caseId: string, owner: string): Promise<EvalCaseDetail | null> {
    const pool = this.pool();
    const meta = await hasEvalMetaSchema(pool);
    const c = (await pool.query(
      `select ${caseColumns(meta)}, t.slug as task_slug
         from public.eval_cases c left join public.tasks t on t.id = c.task_id
        where c.id = $1 and c.owner_wallet = $2`,
      [caseId, owner],
    )).rows[0];
    if (!c) return null;
    const kase = caseView(c);
    // The agent variants that ran on this case, and its baseline (even with no run yet). Their stats count only
    // the runs of THIS case: the same variant on another case is another crossing.
    const { rows } = await pool.query(
      `select ${VARIANT_COLUMNS},
              count(r.id)::int as n,
              count(r.id) filter (where r.status = 'pass')::int as pass,
              count(r.id) filter (where r.status = 'fail')::int as fail,
              count(r.id) filter (where r.status = 'infra_error')::int as infra_errors,
              avg(coalesce((r.evidence_manifest -> 'item' ->> 'score')::numeric, r.score_total))
                filter (where r.status in ('pass', 'fail')) as mean_score,
              max(r.prediction_sha256) as prediction_sha256,
              coalesce(array_agg(distinct r.evaluation_id) filter (where r.evaluation_id is not null), '{}') as evaluation_ids
         from public.eval_variants v
         left join public.runs r on r.variant_id = v.id and r.case_id = $1 and r.owner_wallet = $2
        where v.id = $3::uuid or v.id in (select variant_id from public.runs where case_id = $1 and owner_wallet = $2)
        group by v.id
        order by (v.id = $3::uuid) desc nulls last, v.created_at, v.id`,
      [caseId, owner, kase.baselineVariantId],
    );
    const variants: EvalCaseVariantStats[] = rows.map((r: Record<string, unknown>) => {
      const pass = Number(r.pass);
      const fail = Number(r.fail);
      const mean = num(r.mean_score);
      return {
        ...variantView(r, kase.baselineVariantId),
        predictionSha256: orNull(r.prediction_sha256),
        n: Number(r.n),
        pass,
        fail,
        infraErrors: Number(r.infra_errors),
        passRate: pass + fail > 0 ? Math.round((pass / (pass + fail)) * 1000) / 1000 : null,
        meanScore: mean === null ? null : Math.round(mean * 10) / 10,
        evaluationIds: (r.evaluation_ids as string[]).slice().sort(),
      };
    });
    const graders = (await pool.query(
      `select distinct gv.grader_id, gv.semver, gv.kind
         from public.grader_results gr
         join public.grader_versions gv on gv.id = gr.grader_version_id
         join public.runs r on r.id = gr.run_id
        where r.case_id = $1 and r.owner_wallet = $2
        order by gv.grader_id, gv.semver, gv.kind`,
      [caseId, owner],
    )).rows.map((g: Record<string, unknown>) => ({ id: String(g.grader_id), semver: String(g.semver), kind: String(g.kind) }));
    return { ...kase, taskSlug: orNull(c.task_slug), graders, variants };
  }

  async listCases(owner: string, limit: number): Promise<EvalCaseListItem[]> {
    const pool = this.pool();
    const meta = await hasEvalMetaSchema(pool);
    const { rows } = await pool.query(
      `select ${caseColumns(meta)}, t.slug as task_slug, s.run_count, s.last_run_at,
              (select count(*) from (
                 select r2.variant_id from public.runs r2 where r2.case_id = c.id and r2.owner_wallet = $1 and r2.variant_id is not null
                 union
                 select c.baseline_variant_id where c.baseline_variant_id is not null
               ) x)::int as variant_count
         from public.eval_cases c
         left join public.tasks t on t.id = c.task_id
         left join lateral (
           select count(*)::int as run_count, max(r.started_at) as last_run_at
             from public.runs r where r.case_id = c.id and r.owner_wallet = $1
         ) s on true
        where c.owner_wallet = $1
        order by c.created_at desc, c.id
        limit $2`,
      [owner, limit],
    );
    return rows.map((r: Record<string, unknown>) => ({
      ...caseView(r),
      taskSlug: orNull(r.task_slug),
      variantCount: Number(r.variant_count ?? 0),
      runCount: Number(r.run_count ?? 0),
      lastRunAt: r.last_run_at == null ? null : iso(r.last_run_at),
    }));
  }

  async listRuns(owner: string, filter: EvalRunsFilter, limit: number): Promise<EvalRunRow[]> {
    const { rows } = await this.pool().query(
      `select r.id as run_id, r.evaluation_id, e.agent_id, a.name as agent_name, r.seq, r.status,
              coalesce((r.evidence_manifest -> 'item' ->> 'score')::numeric, r.score_total) as score,
              r.infra_ok, r.started_at, r.prediction_sha256,
              c.id as case_id, c.case_key, c.use_case_key, c.baseline_variant_id, ${VARIANT_COLUMNS}
         from public.runs r
         join public.eval_cases c on c.id = r.case_id and c.owner_wallet = $1
         join public.eval_variants v on v.id = r.variant_id
         left join public.evaluations e on e.id = r.evaluation_id
         left join public.agents a on a.id = e.agent_id
        where r.owner_wallet = $1
          and ($2::uuid is null or e.agent_id = $2::uuid)
          and ($3::uuid is null or r.case_id = $3::uuid)
        order by r.started_at desc, r.seq nulls last, r.id
        limit $4`,
      [owner, filter.agentId ?? null, filter.caseId ?? null, limit],
    );
    return rows.map((r: Record<string, unknown>) => ({
      id: String(r.run_id),
      evaluationId: orNull(r.evaluation_id),
      agentId: orNull(r.agent_id),
      agentName: orNull(r.agent_name),
      seq: num(r.seq),
      status: String(r.status),
      score: num(r.score),
      infraOk: (r.infra_ok as boolean | null) ?? null,
      startedAt: iso(r.started_at),
      caseId: String(r.case_id),
      caseKey: String(r.case_key),
      useCaseKey: String(r.use_case_key),
      variant: variantView(r, orNull(r.baseline_variant_id)),
      predictionSha256: orNull(r.prediction_sha256),
    }));
  }
}

/** The latest row of each grader version per run, summed over the runs. */
export function graderSummaries(perRun: Iterable<RunEvalResults>): GraderSummaryView[] {
  const acc = new Map<string, GraderSummaryView & { scores: number[] }>();
  for (const r of perRun) {
    const latest = new Map<string, GraderRowView>();
    for (const g of r.graders) latest.set(`${g.id}@${g.semver}#${g.codeSha256}`, g);
    for (const [key, g] of latest) {
      const a = acc.get(key) ?? {
        id: g.id, semver: g.semver, kind: g.kind, codeSha256: g.codeSha256, n: 0, pass: 0, meanScore: null, hardGate: g.hardGate, decisive: g.decisive,
        proof: g.proof, calibration: g.calibration, note: g.note, author: g.author, scores: [],
      };
      a.n += 1;
      if (g.pass) a.pass += 1;
      if (g.score !== null) a.scores.push(g.score);
      acc.set(key, a);
    }
  }
  return [...acc.values()]
    .map(({ scores, ...g }) => ({ ...g, meanScore: scores.length ? Math.round((scores.reduce((x, y) => x + y, 0) / scores.length) * 10) / 10 : null }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.semver.localeCompare(b.semver));
}

/** Wrap res.json so a successful object body gets `extra(body)` merged in. */
function decorate(res: Response, extra: (body: Record<string, unknown>) => Record<string, unknown>) {
  const json = res.json.bind(res);
  res.json = (body: unknown) =>
    json(body && typeof body === "object" && !Array.isArray(body) && !("error" in body) && res.statusCode < 400
      ? { ...(body as Record<string, unknown>), ...extra(body as Record<string, unknown>) }
      : body);
}

export function createEvalResultsRouter(reader: EvalResultsReader): Router {
  const router = Router();

  router.get("/evaluations/:id", async (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return next();
    try {
      if (!(await reader.ready())) return next();
      const [cv, runIds] = await Promise.all([reader.caseOfEvaluation(id), reader.runIdsOf(id)]);
      const results = await reader.resultsOfRuns(runIds);
      decorate(res, (body) => ({
        case: cv?.case ?? null,
        variant: cv?.variant ?? null,
        predictionSha256: cv?.predictionSha256 ?? null,
        graders: graderSummaries(results.values()),
        ...(Array.isArray(body.tasks)
          ? {
              tasks: (body.tasks as Array<Record<string, unknown>>).map((t) => {
                const r = typeof t.runId === "string" ? results.get(t.runId) : undefined;
                return { ...t, graders: r?.graders ?? [], trajectorySummary: r?.trajectorySummary ?? null };
              }),
            }
          : {}),
      }));
      next();
    } catch (e) {
      next(e);
    }
  });

  router.get("/runs/:id", async (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return next();
    try {
      if (!(await reader.ready())) return next();
      const [cv, results] = await Promise.all([reader.caseOfRun(id), reader.resultsOfRuns([id])]);
      const r = results.get(id);
      decorate(res, () => ({
        case: cv?.case ?? null,
        variant: cv?.variant ?? null,
        predictionSha256: cv?.predictionSha256 ?? null,
        graders: r?.graders ?? [],
        trajectorySummary: r?.trajectorySummary ?? null,
      }));
      next();
    } catch (e) {
      next(e);
    }
  });

  const notReady = (res: Response) =>
    res.status(503).json({ error: "schema_not_ready", message: `database schema is not migrated yet (needs db/migrations/${EVAL_RESULTS_MIGRATION})` });

  // C5-T3 (studio S1/S4): the caller's cases. Read only.
  router.get("/eval-cases", requirePrincipal, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await reader.ready())) return void notReady(res);
      const rows = await reader.listCases(req.principal!.id, EVAL_CASES_LIMIT + 1);
      res.json({ cases: rows.slice(0, EVAL_CASES_LIMIT), limit: EVAL_CASES_LIMIT, truncated: rows.length > EVAL_CASES_LIMIT });
    } catch (e) {
      next(e);
    }
  });

  // C5-T3 (studio S4/S5): the caller's uploaded eval runs, filtered by TMA agent and/or case. Read only.
  router.get("/eval-runs", requirePrincipal, async (req: Request, res: Response, next: NextFunction) => {
    const one = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
    const agentId = one(req.query.agent);
    const caseId = one(req.query.case);
    if ((agentId && !UUID_RE.test(agentId)) || (caseId && !UUID_RE.test(caseId))) {
      res.status(400).json({ error: "invalid_query", message: "agent and case must be uuids" });
      return;
    }
    try {
      if (!(await reader.ready())) return void notReady(res);
      const rows = await reader.listRuns(req.principal!.id, { agentId, caseId }, EVAL_RUNS_LIMIT + 1);
      res.json({ runs: rows.slice(0, EVAL_RUNS_LIMIT), limit: EVAL_RUNS_LIMIT, truncated: rows.length > EVAL_RUNS_LIMIT });
    } catch (e) {
      next(e);
    }
  });

  router.get("/eval-cases/:id", requirePrincipal, async (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    try {
      if (!(await reader.ready())) return void notReady(res);
      const detail = UUID_RE.test(id) ? await reader.caseDetail(id, req.principal!.id) : null;
      if (!detail) {
        res.status(404).json({ error: "eval case not found" });
        return;
      }
      res.json(detail);
    } catch (e) {
      next(e);
    }
  });

  return router;
}

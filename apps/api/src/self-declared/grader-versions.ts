/**
 * Read side of the grader library (plan 20261112-tma-c5-studio-area-web2, task C5-T5; studio screens S10 and S10a;
 * needs db/migrations/0023_eval_results.sql, and 0024 for the proof and calibration fields). Read only.
 *
 *   GET /grader-versions       the grader versions of the result-plane tenant, newest first, each with `usedByCount`
 *                              (the grader_results rows that point at it).
 *   GET /grader-versions/:id   one version: judge fields, calibration, proof, and the latest runs that it graded
 *                              (ids only; the web page links to them).
 *
 * Tenancy: a grader version belongs to a tenant, not to a principal (the upload path writes the tenant of
 * TMA_RESULT_TENANT, see resultTenantFromEnv). A principal reads the versions of that tenant; a version of another
 * tenant answers the same 404 as an unknown id. Before 0023 both routes answer 503 schema_not_ready.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import { requirePrincipal } from "../auth/middleware.js";
import { hasEvalMetaSchema, hasEvalResultsSchema } from "../domain/schema-features.js";
import type { GraderVersionMetaView } from "./eval-results.js";
import { EVAL_RESULTS_MIGRATION, resultTenantFromEnv } from "./store.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GraderVersionListItem {
  id: string;
  graderId: string;
  semver: string;
  kind: "code" | "judge" | "human";
  codeSha256: string;
  judgeModelId: string | null;
  createdAt: string;
  usedByCount: number;
}

export interface GraderVersionRecentRun {
  runId: string;
  caseId: string | null;
  evaluationId: string | null;
  pass: boolean;
  gradedAt: string;
}

export interface GraderVersionDetail extends GraderVersionListItem, GraderVersionMetaView {
  rubricSha256: string | null;
  paramsSha256: string | null;
  testSplitSha256: string | null;
  /** Judge only: true positive rate and true negative rate on the test split. */
  tpr: number | null;
  tnr: number | null;
  recentRuns: GraderVersionRecentRun[];
}

export interface GraderVersionsReader {
  /** False before 0023: both routes answer 503. */
  ready(): Promise<boolean>;
  list(tenant: string): Promise<GraderVersionListItem[]>;
  /** The version, or null (unknown id, or another tenant's). */
  detail(id: string, tenant: string): Promise<GraderVersionDetail | null>;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const orNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function listItem(r: Record<string, unknown>): GraderVersionListItem {
  return {
    id: String(r.id),
    graderId: String(r.grader_id),
    semver: String(r.semver),
    kind: r.kind as GraderVersionListItem["kind"],
    codeSha256: String(r.code_sha256),
    judgeModelId: orNull(r.judge_model_id),
    createdAt: iso(r.created_at),
    usedByCount: Number(r.used_by ?? 0),
  };
}

export class PgGraderVersionsReader implements GraderVersionsReader {
  constructor(private readonly pool: () => Pool) {}

  ready(): Promise<boolean> {
    return hasEvalResultsSchema(this.pool());
  }

  async list(tenant: string): Promise<GraderVersionListItem[]> {
    const { rows } = await this.pool().query(
      `select g.id, g.grader_id, g.semver, g.kind, g.code_sha256, g.judge_model_id, g.created_at,
              (select count(*)::int from public.grader_results gr where gr.grader_version_id = g.id and gr.tenant = g.tenant) as used_by
         from public.grader_versions g
        where g.tenant = $1
        order by g.grader_id, g.created_at desc, g.id`,
      [tenant],
    );
    return rows.map(listItem);
  }

  async detail(id: string, tenant: string): Promise<GraderVersionDetail | null> {
    const pool = this.pool();
    const meta = await hasEvalMetaSchema(pool);
    const metaCols = meta ? `, g.proof_caught, g.proof_total, g.calibration, g.note, g.author` : "";
    const g = (
      await pool.query(
        `select g.id, g.grader_id, g.semver, g.kind, g.code_sha256, g.judge_model_id, g.created_at, g.rubric_sha256, g.params_sha256,
                g.tpr, g.tnr, g.test_split_sha256${metaCols},
                (select count(*)::int from public.grader_results gr where gr.grader_version_id = g.id and gr.tenant = g.tenant) as used_by
           from public.grader_versions g where g.id = $1 and g.tenant = $2`,
        [id, tenant],
      )
    ).rows[0];
    if (!g) return null;
    const recent = await pool.query(
      `select gr.run_id, r.case_id, r.evaluation_id, gr.pass, gr.graded_at
         from public.grader_results gr join public.runs r on r.id = gr.run_id
        where gr.grader_version_id = $1 and gr.tenant = $2
        order by gr.graded_at desc, gr.id limit 5`,
      [id, tenant],
    );
    const c = g.calibration && typeof g.calibration === "object" ? (g.calibration as Record<string, unknown>) : null;
    return {
      ...listItem(g),
      rubricSha256: orNull(g.rubric_sha256),
      paramsSha256: orNull(g.params_sha256),
      testSplitSha256: orNull(g.test_split_sha256),
      tpr: numOrNull(g.tpr),
      tnr: numOrNull(g.tnr),
      proof: g.proof_total == null ? null : { caught: Number(g.proof_caught), total: Number(g.proof_total) },
      calibration: c
        ? {
            nLabels: Number(c.n_labels), nTest: Number(c.n_test), tp: Number(c.tp), fn: Number(c.fn), tn: Number(c.tn), fp: Number(c.fp),
            realignedAt: typeof c.realigned_at === "string" ? c.realigned_at : null,
          }
        : null,
      note: orNull(g.note),
      author: orNull(g.author),
      recentRuns: recent.rows.map((x: Record<string, unknown>) => ({
        runId: String(x.run_id), caseId: orNull(x.case_id), evaluationId: orNull(x.evaluation_id), pass: Boolean(x.pass), gradedAt: iso(x.graded_at),
      })),
    };
  }
}

export interface GraderVersionsRouterOptions {
  /** TMA_RESULT_TENANT by default. */
  tenant?: string;
}

export function createGraderVersionsRouter(reader: GraderVersionsReader, options: GraderVersionsRouterOptions = {}): Router {
  const router = Router();
  const notReady = (res: Response) =>
    res.status(503).json({ error: "schema_not_ready", message: `database schema is not migrated yet (needs db/migrations/${EVAL_RESULTS_MIGRATION})` });

  router.get("/grader-versions", requirePrincipal, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await reader.ready())) return void notReady(res);
      res.json({ graderVersions: await reader.list(options.tenant ?? resultTenantFromEnv()) });
    } catch (e) {
      next(e);
    }
  });

  router.get("/grader-versions/:id", requirePrincipal, async (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    try {
      if (!(await reader.ready())) return void notReady(res);
      const detail = UUID_RE.test(id) ? await reader.detail(id, options.tenant ?? resultTenantFromEnv()) : null;
      if (!detail) return void res.status(404).json({ error: "grader version not found" });
      res.json(detail);
    } catch (e) {
      next(e);
    }
  });

  return router;
}

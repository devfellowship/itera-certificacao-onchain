/**
 * Postgres store of POST /self-declared-results (task L3). ONE transaction per import; see store.ts.
 * Needs db/migrations/0021_self_declared_results.sql. Without it, the first statement that names a
 * 0021 column or table fails (42703 / 42P01), the transaction rolls back, and the router answers
 * 503 schema_not_ready: nothing is written on a database that is not migrated.
 */
import type { LocalResult, LocalResultV2 } from "@itera/contracts";
import { agentVersionSha256 } from "@itera/contracts";
import type { Pool, PoolClient } from "pg";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { hasEvalResultsSchema } from "../domain/schema-features.js";
import {
  EVAL_RESULTS_MIGRATION,
  SELF_DECLARED_MIGRATION,
  SelfDeclaredError,
  runEvidenceV2,
  runIdV2,
  runKeyV2,
  runStatusV2,
  selfDeclaredIdV2,
  type ImportOptionsV2,
  type ImportOutcomeV2,
  evidenceOf,
  executorKey,
  modelLookup,
  outcomeOf,
  provenanceOf,
  resultDigest,
  runNumbers,
  selfDeclaredId,
  taskRef,
  type ImportAction,
  type ImportOptions,
  type ImportOutcome,
  type SelfDeclaredStore,
} from "./store.js";

function pgCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

/** Sentinel: the dry run reached its end and rolls back. */
class DryRunDone<T = ImportOutcome> extends Error {
  constructor(public readonly outcome: T) {
    super("dry run");
  }
}

type RunV2 = LocalResultV2["runs"][number];

/** The evaluation numbers of a v2 evaluation, from ALL its runs (the stored ones and this upload's). */
function evaluationNumbersV2(runs: Array<{ status: string; score: number }>) {
  const graded = runs.filter((x) => x.status === "pass" || x.status === "fail");
  const pass = graded.filter((x) => x.status === "pass").length;
  const score = graded.length ? Math.round((graded.reduce((a, x) => a + x.score, 0) / graded.length) * 10) / 10 : 0;
  return { pass, fail: graded.length - pass, score, outcome: (graded.length > 0 && pass === graded.length ? "pass" : "fail") as "pass" | "fail" };
}

interface TaskRow {
  id: string;
  slug: string;
  name: string;
  visibility: string;
}

export class PgSelfDeclaredStore implements SelfDeclaredStore {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async importResult(principal: string, r: LocalResult, options: ImportOptions): Promise<ImportOutcome> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const outcome = await this.write(c, principal, r, options);
      if (options.dryRun) throw new DryRunDone(outcome);
      await c.query("commit");
      return outcome;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      if (e instanceof DryRunDone) return e.outcome;
      const code = pgCode(e);
      if (code === "42703" || code === "42P01") throw new SchemaNotReadyError(SELF_DECLARED_MIGRATION, e);
      throw e;
    } finally {
      c.release();
    }
  }

  private async write(c: PoolClient, principal: string, r: LocalResult, options: ImportOptions): Promise<ImportOutcome> {
    const id = selfDeclaredId(principal, r);
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [`self-declared:${id}`]);

    // 2. The agent is an agent of the caller (any connector).
    const agent = (await c.query(`select id, owner_wallet, pinned_commit from public.agents where id = $1`, [r.agent_id])).rows[0];
    if (!agent || agent.owner_wallet !== principal) throw new SelfDeclaredError(404, "agent_not_found", "agent not found");

    // 3. The model is known, or a custom model of the caller (provider and route: the contract checked the enums).
    await this.checkModel(c, principal, r.executor.model_id);

    // 4. The task.
    const { task, taskVersionId, packId, packVersion } = await this.resolveTask(c, principal, r);

    const version = (await c.query(
      `select id, commit_sha from public.agent_versions where agent_id = $1
        order by (commit_sha = $2) desc, created_at desc limit 1`,
      [agent.id, agent.pinned_commit ?? ""],
    )).rows[0];
    if (!version) throw new SelfDeclaredError(409, "agent_has_no_version", "the agent has no version yet");

    const digest = resultDigest(r);
    const prev = (await c.query(
      `select r.owner_wallet, r.evaluation_id, r.result_origin, r.evidence_manifest ->> 'import_digest' as digest, e.owner_wallet as eval_owner
         from public.runs r left join public.evaluations e on e.id = r.evaluation_id where r.id = $1 for update of r`,
      [id],
    )).rows[0];
    if (!prev && (await c.query(`select 1 from public.evaluations where id = $1`, [id])).rowCount) {
      throw new SelfDeclaredError(409, "conflicting_rows", "an evaluation with this id exists without its run");
    }
    if (prev && (prev.owner_wallet !== principal || prev.eval_owner !== principal || prev.evaluation_id !== id || prev.result_origin !== "self_declared")) {
      throw new SelfDeclaredError(409, "conflicting_rows", "a run with this id exists with another owner or origin");
    }
    const action: ImportAction = !prev ? "inserted" : prev.digest === digest ? "unchanged" : "updated";
    const outcome = outcomeOf(r);
    const result: ImportOutcome = { evaluationId: id, runId: id, action, outcome, taskId: task.id, taskVersionId, dryRun: options.dryRun };
    if (action === "unchanged") return result;

    // 5. Daily cap on NEW self-declared evaluations (an update adds no row).
    if (action === "inserted") {
      const n = (await c.query(
        `select count(*)::int as n from public.evaluations
          where owner_wallet = $1 and result_origin = 'self_declared' and created_at > now() - interval '24 hours'`,
        [principal],
      )).rows[0].n as number;
      if (n >= options.perDay) {
        throw new SelfDeclaredError(429, "self_declared_quota", `at most ${options.perDay} self-declared results per 24 h`);
      }
    }

    const release = (await c.query(
      `insert into public.release_declarations (agent_id, release_ref) values ($1, 'self-declared')
       on conflict (agent_id, release_ref) do update set release_ref = excluded.release_ref returning id`,
      [agent.id],
    )).rows[0];

    const n = runNumbers(r);
    const taskEntry = {
      taskId: task.id, taskVersionId, slug: task.slug, name: task.name, packId, packVersion,
      isPublic: task.visibility === "public", source: "self-declared",
    };
    const modelRoute = r.executor.route === "openrouter" || r.executor.route === "opencode-go" ? r.executor.route : null;
    const evalValues = [
      id, `sd-${id}`, `D${id.replaceAll("-", "")}`, principal, agent.id, version.id, r.executor.model_id, JSON.stringify([taskEntry]),
      n.score, Number(outcome === "pass"), Number(outcome === "fail"), n.testsPassed, n.testsTotal, r.ran_from, r.ran_to,
    ];
    const runValues = [
      id, release.id, packId, packVersion, `self-declared-${id}`, outcome, r.ran_from, r.ran_to,
      JSON.stringify(evidenceOf(r, digest)), n.scoreTotal, version.id, principal, task.id, taskVersionId,
      r.executor.model_id, r.executor.model_effective ?? r.executor.model_id, r.executor.provider, n.costUsd, n.tokensIn, n.tokensOut,
      n.costSource, n.wallMs, JSON.stringify(provenanceOf(r)), modelRoute,
    ];
    if (action === "inserted") {
      // The evaluation first: runs.evaluation_id references it.
      await c.query(
        `insert into public.evaluations (id, slug, short_id, owner_wallet, agent_id, agent_version_id, model_id, tasks, status, task_count,
           payment_kind, result_origin, score, pass_count, fail_count, invalid_count, tests_passed, tests_total, is_public,
           started_at, completed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'graded', 1, 'none', 'self_declared', $9, $10, $11, 0, $12, $13, false, $14, $15)`,
        evalValues,
      );
      await c.query(
        `insert into public.runs (id, release_declaration_id, task_pack_id, task_pack_version, nonce, status, started_at, completed_at,
           evidence_manifest, score_total, agent_version_id, owner_wallet, task_id, task_version_id, evaluation_id, seq,
           model_requested, model_effective, model_provider, model_cost_usd, model_tokens_in, model_tokens_out, model_cost_source,
           wall_ms, provenance, model_route, result_origin)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $1, 1, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, 'self_declared')`,
        runValues,
      );
    } else {
      await c.query(
        `update public.evaluations set agent_version_id = $6, model_id = $7, tasks = $8, score = $9, pass_count = $10, fail_count = $11,
           tests_passed = $12, tests_total = $13, started_at = $14, completed_at = $15
         where id = $1 and slug = $2 and short_id = $3 and owner_wallet = $4 and agent_id = $5 and result_origin = 'self_declared'`,
        evalValues,
      );
      await c.query(
        `update public.runs set release_declaration_id = $2, task_pack_id = $3, task_pack_version = $4, status = $6, started_at = $7,
           completed_at = $8, evidence_manifest = $9, score_total = $10, agent_version_id = $11, task_version_id = $14,
           model_requested = $15, model_effective = $16, model_provider = $17, model_cost_usd = $18, model_tokens_in = $19,
           model_tokens_out = $20, model_cost_source = $21, wall_ms = $22, provenance = $23, model_route = $24
         where id = $1 and nonce = $5 and owner_wallet = $12 and task_id = $13 and result_origin = 'self_declared'`,
        runValues,
      );
    }
    return result;
  }

  async importResultV2(principal: string, r: LocalResultV2, options: ImportOptionsV2): Promise<ImportOutcomeV2> {
    const c = await this.pool.connect();
    try {
      // Deploy safety: until 0023 is applied, nothing is written (503 schema_not_ready).
      if (!(await hasEvalResultsSchema(c))) throw new SchemaNotReadyError(EVAL_RESULTS_MIGRATION);
      await c.query("begin");
      const outcome = await this.writeV2(c, principal, r, options);
      if (options.dryRun) throw new DryRunDone(outcome);
      await c.query("commit");
      return outcome;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      if (e instanceof DryRunDone) return e.outcome as ImportOutcomeV2;
      const code = pgCode(e);
      if (code === "42703" || code === "42P01") throw new SchemaNotReadyError(EVAL_RESULTS_MIGRATION, e);
      throw e;
    } finally {
      c.release();
    }
  }

  private async writeV2(c: PoolClient, principal: string, r: LocalResultV2, options: ImportOptionsV2): Promise<ImportOutcomeV2> {
    const tenant = options.tenant;
    const id = selfDeclaredIdV2(principal, r);
    // One lock per case (the baseline rule), taken before the evaluation lock: one order, no deadlock.
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [`eval-case:${tenant}:${principal}:${r.case.case_key}:${r.case.manifest_sha256}`]);
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [`self-declared:${id}`]);
    // The v1 helpers read only task, agent_id and executor, which v2 has unchanged.
    const v1 = r as unknown as LocalResult;

    const agent = (await c.query(`select id, owner_wallet, pinned_commit from public.agents where id = $1`, [r.agent_id])).rows[0];
    if (!agent || agent.owner_wallet !== principal) throw new SelfDeclaredError(404, "agent_not_found", "agent not found");
    await this.checkModel(c, principal, r.executor.model_id);
    const { task, taskVersionId, packId, packVersion } = await this.resolveTask(c, principal, v1);
    const version = (await c.query(
      `select id, commit_sha from public.agent_versions where agent_id = $1
        order by (commit_sha = $2) desc, created_at desc limit 1`,
      [agent.id, agent.pinned_commit ?? ""],
    )).rows[0];
    if (!version) throw new SelfDeclaredError(409, "agent_has_no_version", "the agent has no version yet");

    // The test case: an upsert. The same manifest digest with another origin pin, mode or use case is a conflict.
    const k = r.case;
    const caseRow = (await c.query(
      `insert into public.eval_cases (tenant, owner_wallet, case_key, manifest_sha256, origin_pin_sha256, mode, use_case_key, task_id, task_version_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict on constraint eval_cases_key do update set case_key = excluded.case_key
       returning id, origin_pin_sha256, mode, use_case_key, baseline_variant_id`,
      [tenant, principal, k.case_key, k.manifest_sha256, k.origin_pin_sha256, k.mode, k.use_case_key, task.id, taskVersionId],
    )).rows[0];
    if (caseRow.origin_pin_sha256 !== k.origin_pin_sha256 || caseRow.mode !== k.mode || caseRow.use_case_key !== k.use_case_key) {
      throw new SelfDeclaredError(409, "case_conflict", `case ${k.case_key} with this manifest exists with another origin pin, mode or use case`);
    }
    const caseId = caseRow.id as string;

    // The agent variant: an upsert, independent of the case (parent plan ADR-26). Its identity is the base agent
    // digest plus the diff digest; the same identity with another change kind is a conflict.
    const v = r.variant;
    const a = v.agent;
    const agentSha = agentVersionSha256(a);
    const variant = (await c.query(
      `insert into public.eval_variants (tenant, owner_wallet, agent_sha256, harness, harness_version, harness_repo_sha, model_id,
         rules_sha256, skills_sha256, mcp_manifest_sha256, tools_sha256, variant_sha256, label, change_kind)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict on constraint eval_variants_key do update set variant_sha256 = excluded.variant_sha256
       returning id, change_kind`,
      [tenant, principal, agentSha, a.harness, a.harness_version, a.harness_repo_sha, a.model_id, a.rules_sha256, a.skills_sha256,
        a.mcp_manifest_sha256, a.tools_sha256, v.variant_sha256, v.label, v.change_kind],
    )).rows[0];
    if (variant.change_kind !== v.change_kind) {
      throw new SelfDeclaredError(409, "variant_conflict", "this agent variant exists with another change kind");
    }
    const variantId = variant.id as string;

    // The baseline of the case: one column, the first baseline wins (plan Q-T4 = A, parent ADR-19). The case
    // lock above serializes two uploads of the same case.
    const cmp = r.comparison;
    if (cmp.is_baseline) {
      if (caseRow.baseline_variant_id === null) {
        await c.query(`update public.eval_cases set baseline_variant_id = $1 where id = $2 and baseline_variant_id is null`, [variantId, caseId]);
      } else if (caseRow.baseline_variant_id !== variantId) {
        throw new SelfDeclaredError(409, "baseline_exists", "this case already has a baseline");
      }
    } else if (caseRow.baseline_variant_id === variantId) {
      throw new SelfDeclaredError(409, "variant_conflict", "this agent variant is the baseline of the case: upload it with comparison.is_baseline true");
    }

    // The evaluation and its stored runs.
    const prevEval = (await c.query(
      `select owner_wallet, result_origin from public.evaluations where id = $1 for update`,
      [id],
    )).rows[0];
    if (prevEval && (prevEval.owner_wallet !== principal || prevEval.result_origin !== "self_declared")) {
      throw new SelfDeclaredError(409, "conflicting_rows", "an evaluation with this id exists with another owner or origin");
    }
    const wanted = r.runs.map((run) => ({ run, id: runIdV2(id, run), digest: resultDigest(run) }));
    const stored = (await c.query(
      `select id, seq, status, evaluation_id, owner_wallet, result_origin, case_id, variant_id, prediction_sha256,
              evidence_manifest ->> 'import_digest' as digest,
              coalesce((evidence_manifest -> 'item' ->> 'score')::numeric, score_total) as score
         from public.runs where evaluation_id = $1 or id = any($2::uuid[]) for update`,
      [id, wanted.map((w) => w.id)],
    )).rows as Array<{ id: string; seq: number; status: string; evaluation_id: string | null; owner_wallet: string; result_origin: string; case_id: string | null; variant_id: string | null; prediction_sha256: string | null; digest: string | null; score: string | number | null }>;
    for (const s of stored) {
      if (s.evaluation_id !== id || s.owner_wallet !== principal || s.result_origin !== "self_declared" || s.case_id !== caseId || s.variant_id !== variantId) {
        throw new SelfDeclaredError(409, "conflicting_rows", "a run with this id exists with another owner, origin or evaluation");
      }
      // The prediction is written before the runs; a later upload of the same crossing cannot change it.
      if (s.prediction_sha256 !== cmp.prediction_sha256) {
        throw new SelfDeclaredError(409, "prediction_conflict", "the runs of this case and agent variant exist with another prediction");
      }
    }
    if (!prevEval && stored.length) throw new SelfDeclaredError(409, "conflicting_rows", "runs with this evaluation id exist without their evaluation");
    const byId = new Map(stored.map((s) => [s.id, s]));
    const plan = wanted.map((w) => {
      const s = byId.get(w.id);
      return { ...w, op: !s ? ("insert" as const) : s.digest === w.digest ? ("same" as const) : ("update" as const), seq: s?.seq ?? 0 };
    });
    const counts = {
      inserted: plan.filter((p) => p.op === "insert").length,
      updated: plan.filter((p) => p.op === "update").length,
      unchanged: plan.filter((p) => p.op === "same").length,
    };
    const action: ImportAction = !prevEval ? "inserted" : counts.inserted + counts.updated === 0 ? "unchanged" : "updated";

    // Seq: a stored run keeps its seq; a new run takes the next one (seq = repeat for one item uploaded in order).
    let nextSeq = stored.reduce((m, s) => Math.max(m, s.seq), 0);
    for (const p of plan) if (p.op === "insert") p.seq = ++nextSeq;
    const merged = new Map<string, { status: string; score: number; seq: number }>(
      stored.map((s) => [s.id, { status: s.status, score: Number(s.score ?? 0), seq: s.seq }]),
    );
    for (const p of plan) merged.set(p.id, { status: runStatusV2(r, p.run), score: p.run.score, seq: p.seq });
    const all = [...merged.entries()].sort((a, b) => a[1].seq - b[1].seq);
    const numbers = evaluationNumbersV2(all.map(([, x]) => x));
    const result: ImportOutcomeV2 = {
      evaluationId: id, caseId, variantId, runIds: all.map(([rid]) => rid), action, outcome: numbers.outcome, runs: counts,
      taskId: task.id, taskVersionId, dryRun: options.dryRun,
    };
    if (action === "unchanged") return result;

    if (action === "inserted") {
      const n = (await c.query(
        `select count(*)::int as n from public.evaluations
          where owner_wallet = $1 and result_origin = 'self_declared' and created_at > now() - interval '24 hours'`,
        [principal],
      )).rows[0].n as number;
      if (n >= options.perDay) throw new SelfDeclaredError(429, "self_declared_quota", `at most ${options.perDay} self-declared results per 24 h`);
    }

    const release = (await c.query(
      `insert into public.release_declarations (agent_id, release_ref) values ($1, 'self-declared')
       on conflict (agent_id, release_ref) do update set release_ref = excluded.release_ref returning id`,
      [agent.id],
    )).rows[0];
    const taskEntry = {
      taskId: task.id, taskVersionId, slug: task.slug, name: task.name, packId, packVersion,
      isPublic: task.visibility === "public", source: "self-declared",
    };
    const evalValues = [
      id, `sd-${id}`, `D${id.replaceAll("-", "")}`, principal, agent.id, version.id, r.executor.model_id, JSON.stringify([taskEntry]),
      numbers.score, numbers.pass, numbers.fail, numbers.pass, all.length, r.ran_from, r.ran_to, all.length,
    ];
    if (action === "inserted") {
      await c.query(
        `insert into public.evaluations (id, slug, short_id, owner_wallet, agent_id, agent_version_id, model_id, tasks, status, task_count,
           payment_kind, result_origin, score, pass_count, fail_count, invalid_count, tests_passed, tests_total, is_public,
           started_at, completed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'graded', $16, 'none', 'self_declared', $9, $10, $11, 0, $12, $13, false, $14, $15)`,
        evalValues,
      );
    } else {
      await c.query(
        `update public.evaluations set agent_version_id = $6, model_id = $7, tasks = $8, score = $9, pass_count = $10, fail_count = $11,
           tests_passed = $12, tests_total = $13, started_at = least(started_at, $14::timestamptz),
           completed_at = greatest(completed_at, $15::timestamptz), task_count = $16
         where id = $1 and slug = $2 and short_id = $3 and owner_wallet = $4 and agent_id = $5 and result_origin = 'self_declared'`,
        evalValues,
      );
    }

    const modelRoute = r.executor.route === "openrouter" || r.executor.route === "opencode-go" ? r.executor.route : null;
    const costSource = r.executor.cost_source === "reported" ? "derived" : r.executor.cost_source;
    const graderCache = new Map<string, string>();
    for (const p of plan) {
      if (p.op === "same") continue;
      const run = p.run;
      const values = [
        p.id, release.id, packId, packVersion, `self-declared-${p.id}`, runStatusV2(r, run), r.ran_from, r.ran_to,
        JSON.stringify(runEvidenceV2(r, run, p.digest)), Math.round(run.score), version.id, principal, task.id, taskVersionId,
        r.executor.model_id, r.executor.model_effective ?? r.executor.model_id, r.executor.provider, run.cost_usd, run.tokens_in == null ? null : Math.round(run.tokens_in),
        run.tokens_out == null ? null : Math.round(run.tokens_out), costSource, run.wall_s == null ? null : Math.round(run.wall_s * 1000),
        JSON.stringify(this.provenanceV2(r, run)), modelRoute, id, p.seq, caseId, variantId, run.infra_ok, cmp.prediction_sha256,
      ];
      if (p.op === "insert") {
        await c.query(
          `insert into public.runs (id, release_declaration_id, task_pack_id, task_pack_version, nonce, status, started_at, completed_at,
             evidence_manifest, score_total, agent_version_id, owner_wallet, task_id, task_version_id, model_requested, model_effective,
             model_provider, model_cost_usd, model_tokens_in, model_tokens_out, model_cost_source, wall_ms, provenance, model_route,
             evaluation_id, seq, case_id, variant_id, infra_ok, prediction_sha256, result_origin)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
             $25, $26, $27, $28, $29, $30, 'self_declared')`,
          values,
        );
      } else {
        await c.query(
          `update public.runs set release_declaration_id = $2, task_pack_id = $3, task_pack_version = $4, status = $6, started_at = $7,
             completed_at = $8, evidence_manifest = $9, score_total = $10, agent_version_id = $11, task_version_id = $14,
             model_requested = $15, model_effective = $16, model_provider = $17, model_cost_usd = $18, model_tokens_in = $19,
             model_tokens_out = $20, model_cost_source = $21, wall_ms = $22, provenance = $23, model_route = $24, infra_ok = $29
           where id = $1 and nonce = $5 and owner_wallet = $12 and task_id = $13 and evaluation_id = $25 and seq = $26
             and case_id = $27 and variant_id = $28 and prediction_sha256 is not distinct from $30 and result_origin = 'self_declared'`,
          values,
        );
        // The trajectory of a changed run is replaced; its grader rows are kept and new ones added (a re-grade).
        await c.query(`delete from public.run_actions where run_id = $1`, [p.id]);
      }
      for (const g of run.graders) {
        const gv = await this.graderVersion(c, tenant, g, graderCache);
        await c.query(
          `insert into public.grader_results (tenant, run_id, grader_version_id, pass, score, weight, hard_gate, decisive, infra_ok)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [tenant, p.id, gv, g.pass, g.score, g.weight, g.hard_gate, g.decisive, run.infra_ok],
        );
      }
      if (run.trajectory && run.trajectory.steps.length) await this.insertTrajectory(c, p.id, run.trajectory.steps);
    }
    return result;
  }

  private provenanceV2(r: LocalResultV2, run: RunV2) {
    return {
      ...provenanceOf(r as unknown as LocalResult),
      runs: 1,
      run_key: runKeyV2(run),
      repeat: run.repeat,
      case_key: r.case.case_key,
      agent_sha256: agentVersionSha256(r.variant.agent),
      variant_sha256: r.variant.variant_sha256,
      format: r.format,
    };
  }

  /** grader_versions is a registry: (tenant, id, semver, code digest) → one row, created on first use. */
  private async graderVersion(c: PoolClient, tenant: string, g: RunV2["graders"][number], cache: Map<string, string>): Promise<string> {
    const key = `${g.id}@${g.semver}#${g.code_sha256}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const row = (await c.query(
      `insert into public.grader_versions (tenant, grader_id, semver, kind, code_sha256) values ($1, $2, $3, $4, $5)
       on conflict on constraint grader_versions_key do update set kind = public.grader_versions.kind
       returning id, kind`,
      [tenant, g.id, g.semver, g.kind, g.code_sha256],
    )).rows[0];
    if (row.kind !== g.kind) throw new SelfDeclaredError(409, "grader_conflict", `grader ${key} exists with kind ${row.kind}`);
    cache.set(key, row.id);
    return row.id as string;
  }

  /** One run_actions row per step, in one statement. target = target_redacted (plan ADR-2). */
  private async insertTrajectory(c: PoolClient, runId: string, steps: NonNullable<RunV2["trajectory"]>["steps"]): Promise<void> {
    const col = <K extends keyof (typeof steps)[number]>(k: K) => steps.map((s) => s[k]);
    await c.query(
      `insert into public.run_actions (run_id, seq, tool, target, ok, parent_seq, turn, tool_family, status, error_class, duration_ms,
         tokens_in, tokens_out, target_kind, args_sha256, result_sha256, retry_of)
       select $1, * from unnest($2::int[], $3::text[], $4::text[], $5::boolean[], $6::int[], $7::int[], $8::text[], $9::text[], $10::text[],
         $11::int[], $12::bigint[], $13::bigint[], $14::text[], $15::text[], $16::text[], $17::int[])`,
      [
        runId, col("seq"), col("tool"), col("target_redacted"), steps.map((s) => s.status === "ok"), col("parent_seq"), col("turn"),
        col("tool_family"), col("status"), col("error_class"), col("duration_ms"), col("tokens_in"), col("tokens_out"), col("target_kind"),
        col("args_sha256"), col("result_sha256"), col("retry_of"),
      ],
    );
  }

  private async checkModel(c: PoolClient, principal: string, modelId: string): Promise<void> {
    const custom = await c.query(`select 1 from public.user_models where owner_wallet = $1 and id = $2`, [principal, modelId]);
    if (custom.rowCount) return;
    const lookup = modelLookup(modelId);
    if ("known" in lookup) return;
    // Any synced OpenRouter model counts: `enabled` is the allow-list of the models that TMA pays for,
    // and a local run spends the user's own key.
    const known = await c.query(`select 1 from public.models where id = $1`, [lookup.catalogId]);
    if (!known.rowCount) throw new SelfDeclaredError(400, "unknown_model", `unknown model ${modelId}: not in the catalog and not a custom model of yours`);
  }

  private async resolveTask(c: PoolClient, principal: string, r: LocalResult): Promise<{ task: TaskRow; taskVersionId: string; packId: string; packVersion: string }> {
    if ("catalog" in r.task) {
      const { slug, version } = r.task.catalog;
      const task = (await c.query(
        `select id, slug, name, visibility, owner_wallet from public.tasks where slug = $1 and deleted_at is null`,
        [slug],
      )).rows[0];
      if (!task || (task.visibility !== "public" && task.owner_wallet !== principal)) throw new SelfDeclaredError(404, "task_not_found", `task ${slug} not found`);
      const tv = (await c.query(`select id, version, pack_id, pack_version from public.task_versions where task_id = $1 and version = $2`, [task.id, version])).rows[0];
      if (!tv) throw new SelfDeclaredError(404, "task_version_not_found", `task ${slug} has no version ${version}`);
      const pack = tv.pack_id && tv.pack_version ? { packId: tv.pack_id as string, packVersion: tv.pack_version as string } : await this.syntheticPack(c, tv.id);
      return { task, taskVersionId: tv.id, ...pack };
    }
    const l = r.task.local;
    let task = (await c.query(
      `select id, slug, name, visibility, owner_wallet, kind from public.tasks where slug = $1 for update`,
      [l.slug],
    )).rows[0];
    if (task) {
      const local = await c.query(`select 1 from public.task_versions where task_id = $1 and source <> 'local' limit 1`, [task.id]);
      if (task.owner_wallet !== principal || task.kind !== "user" || local.rowCount) {
        throw new SelfDeclaredError(409, "task_slug_taken", `task slug ${l.slug} is taken`);
      }
    } else {
      task = (await c.query(
        `insert into public.tasks (slug, kind, owner_wallet, name, description, visibility, status)
         values ($1, 'user', $2, $3, $4, 'private', 'ready') returning id, slug, name, visibility`,
        [l.slug, principal, l.name, l.description ?? ""],
      )).rows[0];
    }
    // One task version per set of digests: the same folder maps to the same version.
    let tv = (await c.query(
      `select id from public.task_versions where task_id = $1 and source = 'local' and contract_digest = $2 and fixture_digest = $3 and hidden_digest = $4`,
      [task.id, l.contract_sha256, l.environment_sha256, l.hidden_tests_sha256],
    )).rows[0];
    if (!tv) {
      tv = (await c.query(
        `insert into public.task_versions (task_id, version, source, contract_digest, fixture_digest, hidden_digest, runnable, validation, created_by)
         values ($1, (select coalesce(max(version), 0) + 1 from public.task_versions where task_id = $1), 'local', $2, $3, $4, false, $5, $6)
         returning id`,
        [task.id, l.contract_sha256, l.environment_sha256, l.hidden_tests_sha256, JSON.stringify({ source: "self-declared", ref: taskRef(r), executor: executorKey(r) }), principal],
      )).rows[0];
    }
    return { task, taskVersionId: tv.id, ...(await this.syntheticPack(c, tv.id)) };
  }

  /** runs.task_pack_id is NOT NULL with a foreign key: a task version without a pack gets a marker pack. */
  private async syntheticPack(c: PoolClient, taskVersionId: string): Promise<{ packId: string; packVersion: string }> {
    const packId = `self-declared-${taskVersionId}`;
    await c.query(
      `insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'self-declared') on conflict (id, version) do nothing`,
      [packId],
    );
    return { packId, packVersion: "1" };
  }
}

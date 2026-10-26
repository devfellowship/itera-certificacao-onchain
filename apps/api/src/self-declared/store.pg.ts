/**
 * Postgres store of POST /self-declared-results (task L3). ONE transaction per import; see store.ts.
 * Needs db/migrations/0021_self_declared_results.sql. Without it, the first statement that names a
 * 0021 column or table fails (42703 / 42P01), the transaction rolls back, and the router answers
 * 503 schema_not_ready: nothing is written on a database that is not migrated.
 */
import type { LocalResult } from "@itera/contracts";
import type { Pool, PoolClient } from "pg";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import {
  SELF_DECLARED_MIGRATION,
  SelfDeclaredError,
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
class DryRunDone extends Error {
  constructor(public readonly outcome: ImportOutcome) {
    super("dry run");
  }
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

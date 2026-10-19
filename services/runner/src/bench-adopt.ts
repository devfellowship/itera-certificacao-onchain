/** Adopt an explicit historical campaign scope without queueing or regrading any run.
 * Run inside the worker with its existing application DB role:
 *   tsx src/bench-adopt.ts --manifest /path/to/non-secret-scope.json [--apply]
 * The default executes every guard/write in a transaction, then rolls it back.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Pool } from 'pg';

interface PackInput {
  id: string; name: string; description: string;
  versions: Array<{ version: string; contract: Record<string, unknown> }>;
}
export interface AdoptionScope {
  email: string; owner: string; expectedRuns: number; agentIds: string[]; campaigns: string[]; packs: PackInput[];
}
interface HistoricalRun {
  id: string; status: string; score_total: number | null; owner_wallet: string | null;
  agent_id: string; agent_owner: string | null; task_pack_id: string; campaign_id: string | null;
  evaluation_id: string | null; task_id: string | null; task_version_id: string | null;
}
export function historicalOutcome(r: Pick<HistoricalRun, 'status' | 'score_total'>) {
  if (!['pass', 'fail', 'invalid', 'timeout', 'infra_error', 'cancelled'].includes(r.status)) throw Error('only terminal runs can be adopted');
  return {
    status: r.status === 'infra_error' ? 'review' : r.status === 'cancelled' ? 'failed' : 'graded',
    score: r.status === 'pass' || r.status === 'fail' ? r.score_total : null,
    pass: Number(r.status === 'pass'), fail: Number(r.status === 'fail'), invalid: Number(['invalid', 'timeout'].includes(r.status)),
  };
}
export function validateAdoptionScope(scope: Pick<AdoptionScope, 'owner' | 'expectedRuns' | 'agentIds' | 'campaigns'> & { packs: Array<{ id: string }> }, runs: HistoricalRun[]) {
  if (!Number.isInteger(scope.expectedRuns) || scope.expectedRuns < 1 || runs.length !== scope.expectedRuns) throw Error('historical run count differs from expected count');
  for (const r of runs) {
    historicalOutcome(r);
    if ((r.owner_wallet && r.owner_wallet !== scope.owner) || (r.agent_owner && r.agent_owner !== scope.owner)) throw Error(`conflicting owner for run ${r.id}`);
    if (!scope.agentIds.includes(r.agent_id)) throw Error(`unexpected agent for run ${r.id}`);
    if (!scope.packs.some((p) => p.id === r.task_pack_id)) throw Error(`unexpected pack for run ${r.id}`);
    if (!r.campaign_id || !scope.campaigns.includes(r.campaign_id)) throw Error(`unexpected campaign for run ${r.id}`);
    if (!r.evaluation_id && (r.task_id || r.task_version_id)) throw Error(`conflicting catalog link for run ${r.id}`);
  }
}

export async function adoptBenchRuns(pool: Pool, scope: AdoptionScope, apply = false) {
  if (!scope.email || !scope.owner || !scope.agentIds.length || !scope.campaigns.length || !scope.packs.length) throw Error('an explicit identity and non-empty scope are required');
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`select pg_advisory_xact_lock(hashtext($1))`, [`bench-adopt:${scope.owner}`]);
    const user = (await c.query(`select principal_id from public.users where lower(email) = lower($1) and principal_id = $2`, [scope.email, scope.owner])).rows;
    if (user.length !== 1) throw Error('the email does not identify the expected principal');
    // Select by packs, then validate campaigns/agents too: unexpected new rows fail the closed scope.
    const { rows: runs } = await c.query<HistoricalRun & Record<string, any>>(
      `select r.*, rd.agent_id::text, a.owner_wallet as agent_owner
         from public.runs r join public.release_declarations rd on rd.id = r.release_declaration_id
         join public.agents a on a.id = rd.agent_id
        where r.task_pack_id = any($1::text[]) order by r.id for update of r, a`, [scope.packs.map((p) => p.id)]);
    validateAdoptionScope(scope, runs);
    if (new Set(runs.map((r) => r.agent_id)).size !== scope.agentIds.length) throw Error('agent scope does not match the historical runs');
    const summary = { apply, tasks: scope.packs.length, versions: 0, agents: scope.agentIds.length, runs: runs.length, insertedEvaluations: 0, alreadyLinked: 0 };
    const versions = new Map<string, { taskId: string; versionId: string; name: string; slug: string }>();
    for (const p of scope.packs) {
      const registry = (await c.query(`select * from public.task_packs where id = $1 order by version`, [p.id])).rows;
      if (registry.length !== p.versions.length || registry.some((r) => !p.versions.some((v) => v.version === r.version))) throw Error(`pack version scope differs for ${p.id}`);
      let task = (await c.query(`select * from public.tasks where slug = $1 for update`, [p.id])).rows[0];
      if (task && (task.owner_wallet !== scope.owner || task.kind !== 'itera' || task.visibility !== 'private' || task.deleted_at)) throw Error(`conflicting task ${p.id}`);
      if (!task) task = (await c.query(
        `insert into public.tasks (slug,kind,owner_wallet,name,description,visibility,status,created_at)
         values ($1,'itera',$2,$3,$4,'private','ready',$5) returning *`, [p.id, scope.owner, p.name, p.description, registry[0].created_at])).rows[0];
      for (const r of registry) {
        const v = p.versions.find((v) => v.version === r.version)!;
        if (!/^[1-9][0-9]*$/.test(v.version) || String((v.contract.task as any)?.version) !== v.version) throw Error(`invalid contract version ${p.id}@${v.version}`);
        let tv = (await c.query(`select * from public.task_versions where task_id = $1 and version = $2`, [task.id, Number(v.version)])).rows[0];
        if (tv && (tv.source !== 'curated' || tv.pack_id !== p.id || tv.pack_version !== v.version || tv.fixture_digest !== r.fixture_digest || tv.hidden_digest !== r.criteria_digest)) throw Error(`conflicting task version ${p.id}@${v.version}`);
        if (!tv) tv = (await c.query(
          `insert into public.task_versions (task_id,version,source,contract,labels,pack_id,pack_version,fixture_digest,hidden_digest,runnable,created_by,created_at)
           values ($1,$2,'curated',$3,'{open-tests}',$4,$5,$6,$7,true,$8,$9) returning id`,
          [task.id, Number(v.version), JSON.stringify(v.contract), p.id, v.version, r.fixture_digest, r.criteria_digest, scope.owner, r.created_at])).rows[0];
        versions.set(`${p.id}@${v.version}`, { taskId: task.id, versionId: tv.id, name: task.name, slug: task.slug });
        summary.versions++;
      }
    }
    for (const id of scope.agentIds) {
      // Ownership only. Keep connector, repo pin, versions, model, name and visibility unchanged.
      await c.query(`update public.agents set owner_wallet = $2 where id = $1 and (owner_wallet is null or owner_wallet = $2)`, [id, scope.owner]);
    }
    for (const r of runs) {
      const tv = versions.get(`${r.task_pack_id}@${r.task_pack_version}`);
      if (!tv || !r.agent_version_id) throw Error(`missing historical task/agent version for ${r.id}`);
      const av = (await c.query(`select agent_id from public.agent_versions where id = $1`, [r.agent_version_id])).rows[0];
      if (av?.agent_id !== r.agent_id) throw Error(`agent version mismatch for ${r.id}`);
      if (r.evaluation_id) {
        const ev = (await c.query(`select * from public.evaluations where id = $1`, [r.evaluation_id])).rows[0];
        if (!ev || ev.owner_wallet !== scope.owner || ev.agent_id !== r.agent_id || ev.agent_version_id !== r.agent_version_id || ev.tasks?.[0]?.historicalRunId !== r.id || r.task_id !== tv.taskId || r.task_version_id !== tv.versionId || r.seq !== 1) throw Error(`conflicting existing evaluation link for ${r.id}`);
        summary.alreadyLinked++;
        continue;
      }
      const task = { taskId: tv.taskId, taskVersionId: tv.versionId, slug: tv.slug, name: tv.name, packId: r.task_pack_id, packVersion: r.task_pack_version, isPublic: false, historicalRunId: r.id };
      const o = historicalOutcome(r);
      const hidden = r.evidence_manifest?.tests?.hidden;
      // Reuse the original run UUID as the historical evaluation UUID: deterministic, no duplicates.
      await c.query(
        `insert into public.evaluations (id,slug,short_id,owner_wallet,agent_id,agent_version_id,model_id,tasks,status,task_count,payment_kind,
          score,pass_count,fail_count,invalid_count,tests_passed,tests_total,is_public,created_at,started_at,completed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'free_byok',$10,$11,$12,$13,$14,$15,false,$16,$17,$18)`,
        [r.id, `historical-${r.id}`, `H${r.id.replaceAll('-', '')}`, scope.owner, r.agent_id, r.agent_version_id,
          r.model_requested ?? (await c.query(`select model from agents where id=$1`, [r.agent_id])).rows[0]?.model,
          JSON.stringify([task]), o.status, o.score, o.pass, o.fail, o.invalid, hidden?.passed ?? 0, hidden?.total ?? 0,
          r.started_at, r.claimed_at ?? r.started_at, r.completed_at]);
      await c.query(`update public.runs set owner_wallet=$2,evaluation_id=$1,task_id=$3,task_version_id=$4,seq=1 where id=$1`, [r.id, scope.owner, tv.taskId, tv.versionId]);
      summary.insertedEvaluations++;
    }
    await c.query(apply ? 'commit' : 'rollback');
    return summary;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally { c.release(); }
}

async function main() {
  const { values } = parseArgs({ options: { manifest: { type: 'string' }, apply: { type: 'boolean', default: false } } });
  if (!values.manifest) throw Error('usage: bench-adopt --manifest <scope.json> [--apply]');
  const { default: pg } = await import('pg');
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).username.includes('itera_api_service')) throw Error('the existing itera_api_service DB connection is required');
  const ca = readFileSync(process.env.ITERA_DB_CA_PATH ?? '/app/apps/api/certs/supabase-pooler-ca-bundle.pem', 'utf8');
  const pool = new pg.Pool({ connectionString: url, ssl: { ca }, max: 1 });
  try { console.log(JSON.stringify(await adoptBenchRuns(pool, JSON.parse(readFileSync(resolve(values.manifest), 'utf8')), values.apply))); }
  finally { await pool.end(); }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e instanceof Error ? e.message : 'adoption failed'); process.exitCode = 1; });

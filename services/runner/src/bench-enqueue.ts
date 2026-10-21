// Operator CLI: queue ONE benchmark run directly on the TestMyAgent DB, for the live worker to claim.
//   tsx src/bench-enqueue.ts --task helpdesk-refunds --model opencode-go/deepseek-v4.1-flash \
//       [--agent-dir examples/bench-agent] [--wait] [--timeout-min 20]
//
// Why: the public flow (wallet login, quote, payment) is for users. A benchmark campaign (plan
// 20261012-testmyagent-dfl-benchmark-tasks, K10/K7) needs runs of one fixed agent file set on
// several models, without a payment. This tool writes the same rows the API writes (vendor, agent,
// agent_version, release_declaration, runs.status = 'queued') and nothing else; the worker then
// runs and grades it exactly like any other run.
//
// Campaigns (K11): `--campaign <id> [--cap-usd 2]` tags the run and enforces the campaign's
// cumulative OpenRouter cap BEFORE the run is queued: spent (metered model_cost_usd of the campaign's
// finished OpenRouter runs) + a reserve for every OpenRouter run still queued or running + the
// reserve of the new run must stay within the cap (reserve = --reserve-usd, default the per-run cap
// US$0.50). So no run can start that could take the campaign past the cap. When the check fails the
// stop is recorded on bench_campaigns (stopped_at, stop_reason) and the tool exits 4. opencode go
// runs spend subscription credit: they are tagged but do not count against the OpenRouter cap.
//
// Needs DATABASE_URL (+ the pooler CA, like the worker). Run it inside the runner container.
// It prints no secret. With --wait it polls the run to a terminal status and prints a summary.
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Pool } from 'pg';
import { isAllowedAgentPath } from './agent-files.js';

export const BENCH_VENDOR = 'ITERA benchmark campaign';
const TERMINAL = new Set(['pass', 'fail', 'invalid', 'timeout', 'infra_error', 'cancelled']);

/** The agent file snapshot of a directory: AGENTS.md, CLAUDE.md, POLICY.md and skills/** only (same rule as the worker). */
export async function readAgentFiles(dir: string): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const rel = relative(dir, full).split('\\').join('/');
        if (isAllowedAgentPath(rel)) out.push({ path: rel, content: await readFile(full, 'utf-8') });
      }
    }
  };
  await walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** A stable id of a file set: `files-<sha256[0:40]>` (agent_versions.commit_sha and release_ref). */
export function filesDigest(files: Array<{ path: string; content: string }>): string {
  const h = createHash('sha256');
  for (const f of files) h.update(`${f.path}\0${f.content}\0`);
  return `files-${h.digest('hex').slice(0, 40)}`;
}

export interface CampaignBudget {
  capUsd: number;
  spentUsd: number;
  inFlight: number;
  reserveUsd: number;
}

/** True when one more OpenRouter run (worst case: its reserve) still fits under the cap. */
export function campaignAllows(b: CampaignBudget): boolean {
  return b.spentUsd + (b.inFlight + 1) * b.reserveUsd <= b.capUsd + 1e-9;
}

export class CampaignStopped extends Error {}

export interface EnqueueInput {
  task: string;
  model: string;
  /** K11: campaign id (bench_campaigns) and its cumulative OpenRouter cap. */
  campaign?: { id: string; capUsd: number; reserveUsd: number };
  files: Array<{ path: string; content: string }>;
  /** Agent name (unique per vendor). Default: `bench <model>`. */
  name?: string;
}

/** Writes vendor → agent → agent_version → release_declaration → queued run, in one transaction. */
export async function enqueueBenchRun(pool: Pool, input: EnqueueInput): Promise<{ runId: string; agentId: string; agentVersionId: string; taskVersion: string; filesDigest: string }> {
  if (input.files.length === 0) throw new Error('the agent directory has no AGENTS.md, CLAUDE.md or skills/ file');
  const digest = filesDigest(input.files);
  const name = (input.name ?? `bench ${input.model}`).slice(0, 120);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const pack = await client.query<{ version: string }>(
      `select version from public.task_packs where id = $1 order by version desc limit 1`,
      [input.task],
    );
    if (!pack.rows[0]) throw new Error(`task pack ${input.task} is not registered (the worker registers benchmarks/* at boot)`);
    const taskVersion = pack.rows[0].version;
    if (input.campaign) await checkCampaign(client, input.campaign, input.model);
    let vendor = await client.query<{ id: string }>(`select id from public.vendors where display_name = $1 order by created_at limit 1`, [BENCH_VENDOR]);
    if (!vendor.rows[0]) vendor = await client.query<{ id: string }>(`insert into public.vendors (display_name) values ($1) returning id`, [BENCH_VENDOR]);
    const vendorId = vendor.rows[0]!.id;
    const agent = await client.query<{ id: string }>(
      `insert into public.agents (vendor_id, name, endpoint_url, model, connector, visibility, status)
       values ($1, $2, $3, $4, 'endpoint', 'private', 'active')
       on conflict (vendor_id, name) do update set model = excluded.model
       returning id`,
      [vendorId, name, `bench://${encodeURIComponent(name)}`, input.model],
    );
    const agentId = agent.rows[0]!.id;
    const version = await client.query<{ id: string }>(
      `insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, $3)
       on conflict (agent_id, commit_sha) do update set files = excluded.files
       returning id`,
      [agentId, digest, JSON.stringify(input.files)],
    );
    const agentVersionId = version.rows[0]!.id;
    const release = await client.query<{ id: string }>(
      `insert into public.release_declarations (agent_id, release_ref) values ($1, $2)
       on conflict (agent_id, release_ref) do update set release_ref = excluded.release_ref
       returning id`,
      [agentId, digest],
    );
    const run = await client.query<{ id: string }>(
      `insert into public.runs (release_declaration_id, task_pack_id, task_pack_version, nonce, status, agent_version_id, campaign_id, model_requested)
       values ($1, $2, $3, $4, 'queued', $5, $6, $7) returning id`,
      [release.rows[0]!.id, input.task, taskVersion, `bench-${randomUUID()}`, agentVersionId, input.campaign?.id ?? null, input.model],
    );
    await client.query('commit');
    return { runId: run.rows[0]!.id, agentId, agentVersionId, taskVersion, filesDigest: digest };
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

type Queryable = { query: Pool['query'] };

/**
 * Creates the campaign on first use; refuses (CampaignStopped) when it is stopped or when one more
 * OpenRouter run could pass the cap, and records the stop. Runs inside the enqueue transaction,
 * with the campaign row locked, so two enqueues cannot both take the last slot.
 */
export async function checkCampaign(db: Queryable, c: { id: string; capUsd: number; reserveUsd: number }, model: string): Promise<CampaignBudget | null> {
  await db.query(`insert into public.bench_campaigns (id, cap_usd) values ($1, $2) on conflict (id) do nothing`, [c.id, c.capUsd]);
  const row = (await db.query<{ cap_usd: string; stopped_at: Date | null; stop_reason: string | null }>(
    `select cap_usd, stopped_at, stop_reason from public.bench_campaigns where id = $1 for update`,
    [c.id],
  )).rows[0]!;
  if (row.stopped_at) throw new CampaignStopped(`campaign ${c.id} is stopped: ${row.stop_reason ?? 'no reason recorded'}`);
  if (model.startsWith('opencode-go/')) return null; // subscription credit, not the OpenRouter cap
  const sums = (await db.query<{ spent: string; in_flight: string }>(
    `select coalesce(sum(model_cost_usd) filter (where status not in ('queued', 'running')), 0) as spent,
            count(*) filter (where status in ('queued', 'running')) as in_flight
       from public.runs
      where campaign_id = $1 and coalesce(model_route, case when model_requested like 'opencode-go/%' then 'opencode-go' else 'openrouter' end) = 'openrouter'`,
    [c.id],
  )).rows[0]!;
  const budget = { capUsd: Number(row.cap_usd), spentUsd: Number(sums.spent), inFlight: Number(sums.in_flight), reserveUsd: c.reserveUsd };
  if (!campaignAllows(budget)) {
    const reason = `cap reached: spent US$${budget.spentUsd.toFixed(6)} + ${budget.inFlight + 1} run reserve(s) of US$${budget.reserveUsd} > cap US$${budget.capUsd}`;
    // Recorded outside the enqueue transaction, which rolls back.
    throw Object.assign(new CampaignStopped(`campaign ${c.id} stopped: ${reason}`), { budget, reason });
  }
  return budget;
}

/**
 * Records a campaign stop. A separate statement: the enqueue transaction rolled back, and with it
 * the campaign row when this was the campaign's first enqueue, so this one upserts the row.
 */
export async function recordCampaignStop(db: Queryable, c: { id: string; capUsd: number }, reason: string): Promise<void> {
  await db.query(
    `insert into public.bench_campaigns (id, cap_usd, stopped_at, stop_reason) values ($1, $2, now(), $3)
     on conflict (id) do update set stopped_at = now(), stop_reason = excluded.stop_reason
      where public.bench_campaigns.stopped_at is null`,
    [c.id, c.capUsd, reason.slice(0, 500)],
  );
}

/** Summary of a run row (no secret: the sealed key column is never selected). */
export async function runSummary(pool: Pool, runId: string): Promise<Record<string, unknown> | null> {
  const r = await pool.query(
    `select id, status, phase, score_total, error, model_cost_usd, model_tokens_in, model_tokens_out,
            started_at, claimed_at, completed_at, campaign_id, model_route, model_requested, model_effective,
            model_provider, model_cost_source, rate_limited, wall_ms, timeout_s, provenance,
            evidence_manifest->'runner' as runner,
            evidence_manifest->'mcp' as mcp
       from public.runs where id = $1`,
    [runId],
  );
  return r.rows[0] ?? null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      task: { type: 'string' },
      model: { type: 'string' },
      'agent-dir': { type: 'string', default: resolve(import.meta.dirname, '..', 'examples', 'bench-agent') },
      name: { type: 'string' },
      campaign: { type: 'string' },
      'cap-usd': { type: 'string', default: '2' },
      'reserve-usd': { type: 'string', default: process.env.ITERA_RUN_MAX_COST_USD || '0.5' },
      wait: { type: 'boolean', default: false },
      'timeout-min': { type: 'string', default: '20' },
    },
  });
  if (!values.task || !values.model) throw new Error('usage: bench-enqueue --task <pack id> --model <model id> [--agent-dir <dir>] [--name <agent name>] [--wait]');
  const { default: pg } = await import('pg');
  const { readFileSync } = await import('node:fs');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const repoRoot = resolve(process.env.ITERA_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..', '..'));
  const caPath = process.env.ITERA_DB_CA_PATH ?? join(repoRoot, 'apps', 'api', 'certs', 'supabase-pooler-ca-bundle.pem');
  const ssl = process.env.ITERA_DB_SSL === 'disable' ? false : { ca: readFileSync(caPath, 'utf-8') };
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl, max: 2 });
  try {
    const files = await readAgentFiles(resolve(values['agent-dir']!));
    const campaign = values.campaign ? { id: values.campaign, capUsd: Number(values['cap-usd']), reserveUsd: Number(values['reserve-usd']) } : undefined;
    let queued;
    try {
      queued = await enqueueBenchRun(pool, { task: values.task, model: values.model, files, name: values.name, campaign });
    } catch (err) {
      if (err instanceof CampaignStopped) {
        const reason = (err as CampaignStopped & { reason?: string }).reason;
        if (reason && campaign) await recordCampaignStop(pool, campaign, reason);
        console.log(JSON.stringify({ event: 'campaign_stop', campaign: campaign?.id, message: err.message }));
        process.exitCode = 4;
        return;
      }
      throw err;
    }
    console.log(JSON.stringify({ event: 'queued', ...queued, model: values.model, files: files.map((f) => f.path) }));
    if (!values.wait) return;
    const deadline = Date.now() + Number(values['timeout-min']) * 60_000;
    for (;;) {
      const row = await runSummary(pool, queued.runId);
      if (row && TERMINAL.has(String(row.status))) {
        console.log(JSON.stringify({ event: 'done', ...row }, null, 2));
        return;
      }
      if (Date.now() > deadline) {
        console.log(JSON.stringify({ event: 'wait_timeout', status: row?.status, phase: row?.phase }));
        process.exitCode = 3;
        return;
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}

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

/** The agent file snapshot of a directory: AGENTS.md, CLAUDE.md and skills/** only (same rule as the worker). */
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

export interface EnqueueInput {
  task: string;
  model: string;
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
      `insert into public.runs (release_declaration_id, task_pack_id, task_pack_version, nonce, status, agent_version_id)
       values ($1, $2, $3, $4, 'queued', $5) returning id`,
      [release.rows[0]!.id, input.task, taskVersion, `bench-${randomUUID()}`, agentVersionId],
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

/** Summary of a run row (no secret: the sealed key column is never selected). */
export async function runSummary(pool: Pool, runId: string): Promise<Record<string, unknown> | null> {
  const r = await pool.query(
    `select id, status, phase, score_total, error, model_cost_usd, model_tokens_in, model_tokens_out,
            started_at, claimed_at, completed_at,
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
    const queued = await enqueueBenchRun(pool, { task: values.task, model: values.model, files, name: values.name });
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

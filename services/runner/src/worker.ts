// The runner worker: claims queued runs and executes them in the sandbox (shared contract "Job protocol").
//   DATABASE_URL and ITERA_RUN_KEY_SECRET required. The model key is the user's (BYOK, runs.model_api_key_enc). See README.md "Worker".
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runEvaluation } from '../../evaluator/src/runner.js';
import type { EvidenceManifest } from '../../evaluator/src/types.js';
import { materializeAgentFiles } from './agent-files.js';
import { runAgent, type AgentRunResult } from './agent-run.js';
import type { ClaimedRun, JobStore, RunOutcome } from './jobs.js';
import { finalStatus, runnerEvidence } from './outcome.js';
import { decryptRunKey } from './run-key.js';
import type { SandboxConfig } from './sandbox.js';

const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

export interface WorkerDeps {
  store: JobStore;
  workerId: string;
  repoRoot: string;
  /** ITERA_RUN_KEY_SECRET: opens runs.model_api_key_enc (BYOK). */
  runKeySecret: string;
  config: SandboxConfig;
  runAgent: typeof runAgent;
  grade: (opts: { repoRoot: string; scenarioId: string; patch: string }) => Promise<EvidenceManifest>;
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}

/** Execute one claimed run to a terminal status. Never throws for a run-level failure. */
export async function processRun(deps: WorkerDeps, claimed: ClaimedRun): Promise<RunOutcome> {
  const { store, workerId } = deps;
  const fail = (error: string, extra: Partial<RunOutcome> = {}): RunOutcome => ({
    status: 'infra_error',
    phase: 'done',
    scoreTotal: 0,
    evidenceManifest: { error },
    error,
    patch: null,
    actions: [],
    ...extra,
  });

  let outcome: RunOutcome;
  let agentDir: string | null = null;
  try {
    const job = await store.loadJob(claimed);
    let modelKey: string | null = null;
    if (job?.modelApiKeyEnc) {
      try {
        modelKey = decryptRunKey(job.modelApiKeyEnc, deps.runKeySecret);
      } catch {
        modelKey = null;
      }
    }
    if (!job) {
      outcome = fail('run has no agent version with files and a model');
    } else if (!modelKey) {
      outcome = fail('run has no usable model API key (BYOK): start a new run with your OpenRouter key');
    } else {
      agentDir = await mkdtemp(join(tmpdir(), 'itera-agent-'));
      const files = await materializeAgentFiles(job.files, agentDir);
      if (files.written.length === 0) {
        outcome = fail('the agent version has no AGENTS.md, CLAUDE.md or skills/ file');
      } else {
        await store.setPhase(job.runId, workerId, 'agent_running');
        let agent: AgentRunResult | null = null;
        try {
          agent = await deps.runAgent({
            runId: job.runId,
            repoRoot: deps.repoRoot,
            scenarioId: job.scenarioId,
            agentDir,
            model: job.model,
            openrouterKey: modelKey,
            config: deps.config,
          });
        } catch (err) {
          outcome = fail(`sandbox failed: ${message(err)}`);
        }
        if (agent) {
          await store.setPhase(job.runId, workerId, 'grading');
          const manifest = await deps.grade({ repoRoot: deps.repoRoot, scenarioId: job.scenarioId, patch: agent.patch });
          const status = finalStatus(agent, manifest);
          outcome = {
            status,
            phase: 'done',
            scoreTotal: Math.round(manifest.score.total),
            evidenceManifest: { ...manifest, runner: runnerEvidence(agent) },
            error: status === 'timeout' ? agent.agentErrors.join('; ') || 'agent wall limit reached' : status === 'infra_error' ? manifest.errors.join('; ') : null,
            patch: agent.patch,
            actions: agent.actions,
          };
        }
      }
    }
  } catch (err) {
    outcome = fail(message(err));
  } finally {
    if (agentDir) await rm(agentDir, { recursive: true, force: true });
  }
  await store.finish(claimed.runId, workerId, outcome!);
  return outcome!;
}

export interface LoopOptions {
  concurrency: number;
  pollMs: number;
  staleMs: number;
  signal: AbortSignal;
}

/** Claim-and-run loop with `concurrency` slots. Resolves after `signal` aborts and in-flight runs end. */
export async function workerLoop(deps: WorkerDeps, opts: LoopOptions): Promise<void> {
  const inFlight = new Set<Promise<void>>();
  let lastReap = 0;
  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      opts.signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
    });

  while (!opts.signal.aborted) {
    try {
      if (Date.now() - lastReap > 60_000) {
        lastReap = Date.now();
        const reaped = await deps.store.reapStale(opts.staleMs);
        if (reaped > 0) log({ event: 'reaped', count: reaped });
      }
      if (inFlight.size < opts.concurrency) {
        const claimed = await deps.store.claim(deps.workerId);
        if (claimed) {
          log({ event: 'claimed', runId: claimed.runId, scenario: claimed.scenarioId });
          const started = Date.now();
          const p: Promise<void> = processRun(deps, claimed)
            .then((o) => log({ event: 'finished', runId: claimed.runId, status: o.status, score: o.scoreTotal, actions: o.actions.length, ms: Date.now() - started, error: o.error }))
            .catch((err) => log({ event: 'finish_failed', runId: claimed.runId, error: message(err) }))
            .finally(() => inFlight.delete(p));
          inFlight.add(p);
          continue;
        }
      }
    } catch (err) {
      log({ event: 'loop_error', error: message(err) });
    }
    await sleep(opts.pollMs);
  }
  await Promise.all(inFlight);
}

async function main(): Promise<void> {
  const { default: pg } = await import('pg');
  const { readFileSync } = await import('node:fs');
  const { PgJobStore } = await import('./jobs.pg.js');
  const { defaultSandboxConfig, ensureSandboxImage, removeOrphans } = await import('./sandbox.js');

  const databaseUrl = process.env.DATABASE_URL;
  const runKeySecret = process.env.ITERA_RUN_KEY_SECRET;
  if (!databaseUrl || !runKeySecret) throw new Error('DATABASE_URL and ITERA_RUN_KEY_SECRET are required');

  const repoRoot = resolve(process.env.ITERA_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..', '..'));
  // Same TLS setup as apps/api/src/domain/pool.ts: pinned Supabase pooler CA, no sslmode in the URL.
  const caPath = process.env.ITERA_DB_CA_PATH ?? join(repoRoot, 'apps', 'api', 'certs', 'supabase-pooler-ca-bundle.pem');
  // ITERA_DB_SSL=disable is for a local test database only.
  const ssl = process.env.ITERA_DB_SSL === 'disable' ? false : { ca: readFileSync(caPath, 'utf-8') };
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl, max: 4 });
  const store = new PgJobStore(pool);

  const config = defaultSandboxConfig();
  if (!process.env.ITERA_SANDBOX_IMAGE) {
    config.image = await ensureSandboxImage(join(repoRoot, 'services', 'runner', 'sandbox'));
  }
  const workerId = `${process.env.ITERA_WORKER_NAME ?? 'itera-runner'}@${hostname()}`;
  const orphans = await removeOrphans();
  // One worker replica: any run still `running` at boot belongs to a dead process.
  const reaped = process.env.ITERA_RUNNER_SINGLETON === 'false' ? 0 : await store.reapStale(0);
  log({ event: 'boot', workerId, image: config.image, wallMs: config.wallMs, orphansRemoved: orphans, runsReaped: reaped });

  const controller = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      log({ event: 'shutdown', signal: sig });
      controller.abort();
    });
  }
  await workerLoop(
    { store, workerId, repoRoot, runKeySecret, config, runAgent, grade: runEvaluation },
    {
      concurrency: Number(process.env.ITERA_RUNNER_CONCURRENCY ?? 2),
      pollMs: Number(process.env.ITERA_RUNNER_POLL_MS ?? 3000),
      staleMs: Number(process.env.ITERA_RUNNER_STALE_MS ?? 15 * 60_000),
      signal: controller.signal,
    },
  );
  await pool.end();
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((err) => {
    log({ event: 'fatal', error: message(err) });
    process.exit(1);
  });
}

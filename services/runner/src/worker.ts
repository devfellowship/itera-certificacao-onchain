// The runner worker: claims queued runs and executes them in the sandbox (shared contract "Job protocol").
//   DATABASE_URL required. Model key: the run's own sealed key when the user gave one (BYOK,
//   runs.model_api_key_enc + ITERA_RUN_KEY_SECRET), else ITERA's platform key ITERA_RUNNER_OPENROUTER_KEY
//   (Tainan TG 20967: ITERA pays the model tokens). See README.md "Worker".
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EvidenceManifest } from '../../evaluator/src/types.js';
import { materializeAgentFiles } from './agent-files.js';
import { runAgent, type AgentRunResult } from './agent-run.js';
import type { ClaimedRun, JobStore, RunOutcome } from './jobs.js';
import { finalStatus, runnerEvidence, statusError } from './outcome.js';
import { decryptRunKey } from './run-key.js';
import type { SandboxConfig } from './sandbox.js';

const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

export interface WorkerDeps {
  store: JobStore;
  workerId: string;
  repoRoot: string;
  /** ITERA_RUN_KEY_SECRET: opens runs.model_api_key_enc (BYOK). Absent → BYOK runs fail, platform runs work. */
  runKeySecret?: string;
  /**
   * ITERA_RUNNER_OPENROUTER_KEY: ITERA's own OpenRouter key, used when the run has no BYOK key
   * (Tainan TG 20967, plan 20261012-itera-testmyagent-ui-refactor Q2 = B). It goes only to the run's
   * gateway container, never into the sandbox. The gateway caps the cost per run.
   */
  platformModelKey?: string;
  config: SandboxConfig;
  runAgent: typeof runAgent;
  /** Grades in a separate sandbox container (grade.ts). Throws on a grader failure. */
  grade: (opts: { runId: string; repoRoot: string; scenarioId: string; patch: string }) => Promise<EvidenceManifest>;
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}

/** Billed model usage of the run: the gateway's measure (OpenRouter accounting), else opencode's own count. */
export function runCost(agent: AgentRunResult): RunOutcome['cost'] {
  const m = agent.modelUsage;
  if (m && (m.calls > 0 || m.costUsd > 0)) return { costUsd: m.costUsd, tokensIn: m.tokensIn, tokensOut: m.tokensOut };
  const u = agent.usage;
  if (u.costUsd > 0 || u.inputTokens > 0 || u.outputTokens > 0) return { costUsd: u.costUsd, tokensIn: u.inputTokens, tokensOut: u.outputTokens };
  return null;
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
    let keyError = 'no model API key is configured for this run (ITERA_RUNNER_OPENROUTER_KEY is not set on the runner)';
    if (job?.modelApiKeyEnc) {
      // BYOK: the user's own key. A key that does not open is an error, never a silent switch to ITERA's key.
      try {
        modelKey = decryptRunKey(job.modelApiKeyEnc, deps.runKeySecret ?? '');
      } catch {
        modelKey = null;
        keyError = "the run's own model API key (BYOK) could not be opened: start a new run";
      }
    } else if (job) {
      modelKey = deps.platformModelKey || null;
    }
    if (!job) {
      outcome = fail('run has no agent version with files and a model');
    } else if (!modelKey) {
      outcome = fail(keyError);
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
          let manifest: EvidenceManifest | null = null;
          try {
            manifest = await deps.grade({ runId: job.runId, repoRoot: deps.repoRoot, scenarioId: job.scenarioId, patch: agent.patch });
          } catch (err) {
            // Keep the agent's evidence (patch, actions) even when grading fails.
            outcome = fail(`grading failed: ${message(err)}`, {
              evidenceManifest: { error: `grading failed: ${message(err)}`, runner: runnerEvidence(agent) },
              patch: agent.patch,
              actions: agent.actions,
              cost: runCost(agent),
            });
          }
          if (manifest) {
            const status = finalStatus(agent, manifest);
            outcome = {
              status,
              phase: 'done',
              // A run that is not measured carries no score.
              scoreTotal: status === 'infra_error' ? 0 : Math.round(manifest.score.total),
              evidenceManifest: { ...manifest, runner: runnerEvidence(agent) },
              error: statusError(status, manifest, agent.agentErrors),
              patch: agent.patch,
              actions: agent.actions,
              cost: runCost(agent),
            };
          }
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
  /** After `signal` aborts: how long to wait for in-flight runs before returning. Default 420 000. */
  drainMs?: number;
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
  // Graceful shutdown: no new claim after the abort; in-flight runs get `drainMs` to finish.
  // A run still in flight after that is left `running`: the next worker requeues it once
  // (orphans.ts recoverLostRuns), because this worker's container is then no longer live.
  const drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS;
  if (inFlight.size > 0) {
    log({ event: 'draining', inFlight: inFlight.size, drainMs });
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      Promise.all(inFlight).then(() => false),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(true), drainMs))),
    ]);
    clearTimeout(timer);
    log(timedOut ? { event: 'drain_timeout', left: inFlight.size } : { event: 'drained' });
  }
}

/** Below the 480 s Dokploy stop grace period (README step 8), so the worker exits before SIGKILL. */
export const DEFAULT_DRAIN_MS = 420_000;

async function main(): Promise<void> {
  const { default: pg } = await import('pg');
  const { readFileSync } = await import('node:fs');
  const { PgJobStore } = await import('./jobs.pg.js');
  const { defaultSandboxConfig, ensureSandboxImage } = await import('./sandbox.js');
  const { exec } = await import('./exec.js');
  const { removeOrphans, recoverLostRuns } = await import('./orphans.js');
  const { gradeInSandbox } = await import('./grade.js');

  const databaseUrl = process.env.DATABASE_URL;
  const runKeySecret = process.env.ITERA_RUN_KEY_SECRET || undefined;
  const platformModelKey = process.env.ITERA_RUNNER_OPENROUTER_KEY || undefined;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!runKeySecret && !platformModelKey) throw new Error('set ITERA_RUNNER_OPENROUTER_KEY (platform key) and/or ITERA_RUN_KEY_SECRET (BYOK)');

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
  const selfHost = hostname();
  const workerId = `${process.env.ITERA_WORKER_NAME ?? 'itera-runner'}@${selfHost}`;
  // Safe during a rolling redeploy: runs of a still-live worker (the old one, draining) are kept.
  const docker = (args: string[]) => exec('docker', args, { timeoutMs: 30_000 });
  const recovered = await recoverLostRuns({ docker, store, selfHost });
  const orphans = await removeOrphans({ docker, store, selfHost });
  log({
    event: 'boot', workerId, image: config.image, wallMs: config.wallMs, maxCostUsd: config.maxCostUsd,
    platformKey: Boolean(platformModelKey), byok: Boolean(runKeySecret), orphansRemoved: orphans.removed, orphansKept: orphans.kept,
    runsRequeued: recovered.requeued, runsFailed: recovered.failed, runsOfLiveWorkers: recovered.keptLive,
  });

  const controller = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      log({ event: 'shutdown', signal: sig });
      controller.abort();
    });
  }
  await workerLoop(
    { store, workerId, repoRoot, runKeySecret, platformModelKey, config, runAgent, grade: (o) => gradeInSandbox({ ...o, config }) },
    {
      concurrency: Number(process.env.ITERA_RUNNER_CONCURRENCY ?? 2),
      pollMs: Number(process.env.ITERA_RUNNER_POLL_MS ?? 3000),
      staleMs: Number(process.env.ITERA_RUNNER_STALE_MS ?? 15 * 60_000),
      drainMs: Number(process.env.ITERA_RUNNER_DRAIN_MS ?? DEFAULT_DRAIN_MS),
      signal: controller.signal,
    },
  );
  await pool.end();
  log({ event: 'exit' });
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((err) => {
    log({ event: 'fatal', error: message(err) });
    process.exit(1);
  });
}

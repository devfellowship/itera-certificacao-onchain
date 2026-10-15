// The runner worker: claims queued runs and executes them in the sandbox (shared contract "Job protocol").
//   DATABASE_URL required. Model key: the run's own sealed key when the user gave one (BYOK,
//   runs.model_api_key_enc + ITERA_RUN_KEY_SECRET), else ITERA's platform key ITERA_RUNNER_OPENROUTER_KEY
//   (Tainan TG 20967: ITERA pays the model tokens). See README.md "Worker".
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadTask, taskDigests } from '../../evaluator/src/task.js';
import type { EvidenceManifest } from '../../evaluator/src/types.js';
import type { ValidationResult } from '../../evaluator/src/validate.js';
import { materializeAgentFiles } from './agent-files.js';
import { runAgent, type AgentRunResult } from './agent-run.js';
import type { ClaimedRun, JobStore, RunOutcome } from './jobs.js';
import { evalLogOf, finalStatus, rateLimitedFinal, runScore, runnerEvidence, statusError } from './outcome.js';
import { buildProvenance, taskWallMs, type RunnerFacts } from './provenance.js';
import { decryptRunKey } from './run-key.js';
import { modelRoute, type SandboxConfig } from './sandbox.js';
import { toolEnvironment } from '@itera/contracts';
import { scenarioDir } from '../../evaluator/src/task.js';
import type { McpServerEvidence } from '../../evaluator/src/mcp-state.js';
import { mcpEvidence, planSidecars, type McpCatalogLookup, type McpSidecarPlan } from './mcp-sidecar.js';
import { fetchTaskFolder, GitHubReadError, isUserPack, type TaskRepoReader } from './task-source.js';
import type { ClaimedValidation, UserTaskStore, ValidationOutcome } from './user-tasks.js';

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
  /**
   * OPENCODE_GO_API_KEY: ITERA's opencode go subscription key (K10, TMA-Q1 = A). Used for a run whose
   * agent model is `opencode-go/<model>`. Platform-only: a BYOK key is an OpenRouter key.
   */
  opencodeGoKey?: string;
  config: SandboxConfig;
  /** K11: facts about this worker (runner digest, sandbox image Id, opencode version), read at boot. */
  facts?: RunnerFacts | null;
  runAgent: typeof runAgent;
  /** Grades in a separate sandbox container (grade.ts). Throws on a grader failure. */
  grade: (opts: { runId: string; repoRoot: string; scenarioId: string; taskDir?: string; patch: string; mcp?: McpServerEvidence[] }) => Promise<EvidenceManifest>;
  /** ADR-11: pins a task's `catalog: name@version` to a published image digest (mcp_catalog). */
  mcpCatalog?: McpCatalogLookup;
  /** U19 user tasks: the validation queue and the pins (0009_user_tasks.sql). Absent → no user task work. */
  userTasks?: UserTaskStore;
  /** Reads a user task folder at its pinned commit through the GitHub App. Null → user tasks fail with a clear error. */
  taskReader?: TaskRepoReader | null;
  /** The validation gate in grading containers (grade.ts validateTaskInSandbox). */
  validate?: (opts: { runId: string; taskDir: string; repeats: number }) => Promise<ValidationResult>;
}

const NO_GITHUB = 'the runner cannot read user tasks: GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY are not set';

/**
 * Fetch a user task (pack `user-<task_version_id>`) at its pinned commit into `dir` and check that
 * the bytes are the ones the gate validated (environment and hidden-test digests). Returns the task
 * directory. Throws with a message for the run's error.
 */
export async function materializeUserTask(deps: WorkerDeps, packId: string, dir: string): Promise<string> {
  if (!deps.userTasks) throw new Error('user tasks are not enabled on this runner');
  if (!deps.taskReader) throw new Error(NO_GITHUB);
  const pin = await deps.userTasks.pinOfPack(packId);
  if (!pin) throw new Error(`user task ${packId} is unknown or did not pass the validation gate`);
  await fetchTaskFolder(deps.taskReader, pin, dir);
  const digests = await taskDigests(await loadTask(dir));
  if ((pin.hiddenDigest && digests.hidden_tests !== pin.hiddenDigest) || (pin.fixtureDigest && digests.environment !== pin.fixtureDigest)) {
    throw new Error('the task content at the pinned commit differs from the validated digests');
  }
  return dir;
}

/** Gate result of a task folder that could not be accepted at all (no check ran). */
export function folderRejected(detail: string): ValidationResult {
  const notRun = { ok: false, detail: 'not checked' };
  return {
    status: 'invalid',
    checks: {
      contract: { ok: false, detail },
      baseline_hidden_fails: { ...notRun, hidden_total: 0, hidden_failed: 0 },
      solution_passes: { ...notRun, public: '0/0', hidden: '0/0', scope_allowed: false },
      repeatable: { ...notRun, runs: 0, identical: false },
      verifier_time: { ...notRun, max_ms: 0, budget_ms: 0 },
    },
    digests: null,
    environment_digest: null,
    duration_ms: 0,
  };
}

/** Run the validation gate of one claimed user task version. Never throws. */
export async function processValidation(deps: WorkerDeps, claimed: ClaimedValidation): Promise<ValidationOutcome> {
  let outcome: ValidationOutcome;
  let root: string | null = null;
  try {
    if (!deps.taskReader) throw new GitHubReadError(NO_GITHUB);
    if (!deps.validate) throw new GitHubReadError('the validation gate is not configured on this runner');
    root = await mkdtemp(join(tmpdir(), 'itera-task-'));
    const taskDir = join(root, 'task');
    try {
      await fetchTaskFolder(deps.taskReader, claimed.pin, taskDir);
    } catch (err) {
      if (err instanceof GitHubReadError) throw err;
      // The folder itself is not acceptable (symlink, size, no task.json): the version is invalid.
      return (outcome = { status: 'invalid', result: folderRejected(message(err)), error: null });
    }
    const result = await deps.validate({ runId: claimed.id, taskDir, repeats: claimed.repeats });
    outcome = { status: result.status, result, error: null };
  } catch (err) {
    outcome = { status: 'error', result: null, error: message(err) };
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
    if (deps.userTasks) await deps.userTasks.finishValidation(claimed.id, deps.workerId, outcome!).catch((err) => log({ event: 'validation_finish_failed', id: claimed.id, error: message(err) }));
  }
  return outcome!;
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
  let userTaskRoot: string | null = null;
  try {
    const job = await store.loadJob(claimed);
    let modelKey: string | null = null;
    let keyError = 'no model API key is configured for this run (ITERA_RUNNER_OPENROUTER_KEY is not set on the runner)';
    let route: ReturnType<typeof modelRoute>['route'] = 'openrouter';
    if (job) {
      try {
        route = modelRoute(job.model, deps.config).route;
      } catch (err) {
        keyError = message(err);
        route = 'openrouter';
      }
    }
    if (job && route === 'opencode-go') {
      // K10: the opencode go subscription is ITERA's own; a BYOK key cannot pay this route.
      if (job.modelApiKeyEnc) keyError = 'the opencode-go route runs only on ITERA\'s subscription: a BYOK (OpenRouter) key cannot pay it';
      else if (!deps.opencodeGoKey) keyError = 'the opencode-go route is not configured on this runner (OPENCODE_GO_API_KEY is not set)';
      else modelKey = deps.opencodeGoKey;
    } else if (job?.modelApiKeyEnc) {
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
      // U19: a user task is read from GitHub at its pinned commit, for this run only.
      let taskDir: string | undefined;
      let taskError: string | null = null;
      if (isUserPack(job.scenarioId)) {
        userTaskRoot = await mkdtemp(join(tmpdir(), 'itera-task-'));
        try {
          taskDir = await materializeUserTask(deps, job.scenarioId, join(userTaskRoot, 'task'));
        } catch (err) {
          taskError = `user task could not be read: ${message(err)}`;
        }
      }
      // ADR-11: the task's tool environment. Each MCP server must resolve to a published catalog
      // digest BEFORE the agent starts; a server that cannot run stops the run as infra_error.
      let mcpPlans: McpSidecarPlan[] = [];
      let builtinTools: readonly string[] | undefined;
      let taskInfo = { id: job.scenarioId, version: job.scenarioVersion, contractDigest: null as string | null, timeoutSec: null as number | null };
      if (!taskError) {
        // A bundle that does not load fails in runAgent with its own error; here only the MCP plan can fail.
        const task = await loadTask(taskDir ?? scenarioDir(deps.repoRoot, job.scenarioId)).catch(() => null);
        if (task) {
          taskInfo = { ...taskInfo, contractDigest: task.contractDigest, timeoutSec: task.contract.agent?.timeout_sec ?? null };
          builtinTools = toolEnvironment(task.contract).builtin;
          try {
            mcpPlans = await planSidecars(task, deps.mcpCatalog);
          } catch (err) {
            taskError = `tool environment: ${message(err)}`;
          }
        }
      }
      if (taskError) {
        outcome = fail(taskError);
      } else if (files.written.length === 0) {
        outcome = fail('the agent version has no AGENTS.md, CLAUDE.md or skills/ file');
      } else {
        await store.setPhase(job.runId, workerId, 'agent_running');
        // K11: the wall cap follows the task's agent.timeout_sec (capped by ITERA_RUN_MAX_WALL_MS).
        const runConfig: SandboxConfig = { ...deps.config, wallMs: taskWallMs(taskInfo.timeoutSec, deps.config) };
        const provenanceOf = (a: AgentRunResult | null, m: EvidenceManifest | null) =>
          buildProvenance({
            model: job.model, route, agentCommit: job.agentCommit ?? null, agentFiles: files.written, task: taskInfo,
            agent: a, config: runConfig, facts: deps.facts ?? null, mcp: mcpPlans, manifest: m,
          });
        let agent: AgentRunResult | null = null;
        try {
          agent = await deps.runAgent({
            runId: job.runId,
            repoRoot: deps.repoRoot,
            scenarioId: job.scenarioId,
            agentDir,
            model: job.model,
            modelKey,
            config: runConfig,
            taskDir,
            mcp: mcpPlans,
            builtinTools,
          });
        } catch (err) {
          outcome = fail(`sandbox failed: ${message(err)}`, { provenance: provenanceOf(null, null) });
        }
        if (agent) {
          await store.setPhase(job.runId, workerId, 'grading');
          let manifest: EvidenceManifest | null = null;
          try {
            // The final MCP state is scored here, on the worker; only digests and counts go on.
            const mcp = mcpPlans.length > 0 ? mcpEvidence(mcpPlans, agent.mcp ?? []) : undefined;
            manifest = await deps.grade({ runId: job.runId, repoRoot: deps.repoRoot, scenarioId: job.scenarioId, taskDir, patch: agent.patch, ...(mcp ? { mcp } : {}) });
          } catch (err) {
            // Keep the agent's evidence (patch, actions) even when grading fails.
            outcome = fail(`grading failed: ${message(err)}`, {
              evidenceManifest: { error: `grading failed: ${message(err)}`, runner: runnerEvidence(agent) },
              patch: agent.patch,
              actions: agent.actions,
              cost: runCost(agent),
              provenance: provenanceOf(agent, null),
            });
          }
          if (manifest) {
            const status = finalStatus(agent, manifest);
            outcome = {
              status,
              phase: 'done',
              // A run that is not measured carries no score; a run that did not finish scores 0 (score v2).
              scoreTotal: runScore(status, manifest),
              evidenceManifest: evalLogOf(manifest, agent, status),
              error: statusError(status, manifest, agent.agentErrors, rateLimitedFinal(agent)),
              patch: agent.patch,
              actions: agent.actions,
              cost: runCost(agent),
              provenance: provenanceOf(agent, manifest),
            };
          }
        }
      }
    }
  } catch (err) {
    outcome = fail(message(err));
  } finally {
    if (agentDir) await rm(agentDir, { recursive: true, force: true });
    if (userTaskRoot) await rm(userTaskRoot, { recursive: true, force: true });
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
        const reapedValidations = deps.userTasks ? await deps.userTasks.reapStaleValidations(opts.staleMs) : 0;
        if (reapedValidations > 0) log({ event: 'reaped_validations', count: reapedValidations });
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
        // U19: the validation gate of a user task shares the run slots (runs first).
        const validation = deps.userTasks ? await deps.userTasks.claimValidation(deps.workerId) : null;
        if (validation) {
          log({ event: 'validation_claimed', id: validation.id, taskVersionId: validation.taskVersionId, repo: validation.pin.repoFullName, commit: validation.pin.commitSha.slice(0, 7) });
          const started = Date.now();
          const p: Promise<void> = processValidation(deps, validation)
            .then((o) => log({ event: 'validation_finished', id: validation.id, status: o.status, ms: Date.now() - started, error: o.error }))
            .catch((err) => log({ event: 'validation_failed', id: validation.id, error: message(err) }))
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

/**
 * Age after which a `running` run counts as lost (reapStale). It must exceed the longest run this
 * worker can make: the agent wall cap (ITERA_RUN_MAX_WALL_MS, up to 900 s since K11) plus setup and
 * grading. K7 campaign 2026-10-15: with the old fixed 15 min, a task-C run that used its full 900 s
 * wall and then graded PASS 100 was reaped as infra_error 3 s before it finished.
 * An explicit ITERA_RUNNER_STALE_MS still wins, but never below maxWallMs + the margin.
 */
export const STALE_MARGIN_MS = 15 * 60_000;
export function staleMsFor(maxWallMs: number, envValue?: string): number {
  const floor = maxWallMs + STALE_MARGIN_MS;
  const configured = Number(envValue);
  return Number.isFinite(configured) && configured > 0 ? Math.max(configured, floor) : Math.max(15 * 60_000, floor);
}

async function main(): Promise<void> {
  const { default: pg } = await import('pg');
  const { readFileSync } = await import('node:fs');
  const { PgJobStore } = await import('./jobs.pg.js');
  const { defaultSandboxConfig, ensureSandboxImage, pruneSandboxImages } = await import('./sandbox.js');
  const { runnerFacts } = await import('./provenance.js');
  const { exec } = await import('./exec.js');
  const { removeOrphans, recoverLostRuns } = await import('./orphans.js');
  const { gradeInSandbox, validateTaskInSandbox } = await import('./grade.js');
  const { mcpGate } = await import('./mcp-gate.js');
  const { PgUserTaskStore } = await import('./user-tasks.pg.js');
  const { GitHubTaskReader } = await import('./task-source.js');

  const databaseUrl = process.env.DATABASE_URL;
  const runKeySecret = process.env.ITERA_RUN_KEY_SECRET || undefined;
  const platformModelKey = process.env.ITERA_RUNNER_OPENROUTER_KEY || undefined;
  const opencodeGoKey = process.env.OPENCODE_GO_API_KEY || undefined;
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
  let prunedImages: string[] = [];
  if (!process.env.ITERA_SANDBOX_IMAGE) {
    config.image = await ensureSandboxImage(join(repoRoot, 'services', 'runner', 'sandbox'));
    // K11 (plan risk R10, disk): every sandbox/ change builds a new tag; drop the stale ones.
    prunedImages = await pruneSandboxImages(config.image).catch(() => []);
  }
  const imageId = (await exec('docker', ['image', 'inspect', '-f', '{{.Id}}', config.image], { timeoutMs: 30_000 })).stdout.trim() || null;
  const facts = await runnerFacts(join(repoRoot, 'services', 'runner'), config.image, imageId);
  const taskReader = GitHubTaskReader.fromEnv();
  const selfHost = hostname();
  const workerId = `${process.env.ITERA_WORKER_NAME ?? 'itera-runner'}@${selfHost}`;
  // Safe during a rolling redeploy: runs of a still-live worker (the old one, draining) are kept.
  const docker = (args: string[]) => exec('docker', args, { timeoutMs: 30_000 });
  // U29: register benchmarks/* bundles in task_packs (the service role can; a migration cannot).
  const { registerCuratedPacks } = await import('./curated-packs.js');
  const packs = await registerCuratedPacks(pool, repoRoot).catch((err) => ({ inserted: 0, known: 0, errors: [message(err)] }));
  log({ event: 'curated_packs', ...packs });
  const recovered = await recoverLostRuns({ docker, store, selfHost });
  const orphans = await removeOrphans({ docker, store, selfHost });
  log({
    event: 'boot', workerId, image: config.image, imageId, runnerDigest: facts.runnerDigest.slice(0, 12), opencode: facts.opencodeVersion, prunedImages, wallMs: config.wallMs, maxWallMs: config.maxWallMs, staleMs: staleMsFor(config.maxWallMs, process.env.ITERA_RUNNER_STALE_MS), maxCostUsd: config.maxCostUsd,
    platformKey: Boolean(platformModelKey), opencodeGoKey: Boolean(opencodeGoKey), byok: Boolean(runKeySecret), userTasksGithub: Boolean(taskReader), orphansRemoved: orphans.removed, orphansKept: orphans.kept,
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
    {
      store, workerId, repoRoot, runKeySecret, platformModelKey, opencodeGoKey, config, facts, runAgent,
      grade: (o) => gradeInSandbox({ ...o, config }),
      // U29: MCP catalog digests (0013_mcp_catalog.sql).
      mcpCatalog: (name, version) => store.mcpCatalog(name, version),
      // U19 user tasks (needs 0009_user_tasks.sql; ITERA_USER_TASKS=off disables the queue).
      userTasks: process.env.ITERA_USER_TASKS === 'off' ? undefined : new PgUserTaskStore(pool),
      taskReader: taskReader,
      validate: (o) => validateTaskInSandbox({ ...o, config, mcpGate: mcpGate({ lookup: (n, v) => store.mcpCatalog(n, v), runId: o.runId }) }),
    },
    {
      concurrency: Number(process.env.ITERA_RUNNER_CONCURRENCY ?? 2),
      pollMs: Number(process.env.ITERA_RUNNER_POLL_MS ?? 3000),
      staleMs: staleMsFor(config.maxWallMs, process.env.ITERA_RUNNER_STALE_MS),
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

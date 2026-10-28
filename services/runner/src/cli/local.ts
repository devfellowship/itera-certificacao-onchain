// The local runner core (plan 20261026-tma-local-runner-and-self-declared-results, ADR-6): the SAME
// workspace, sandbox, gateway and grader code as the hosted worker, driven from the user's machine.
//
//   workspace: the agent-visible task (environment/ + public tests; never the hidden tests or the
//              solution), for any harness. The instruction goes to INSTRUCTION.md.
//   grade:     the patch is the diff of that workspace against a FRESH baseline of the task (built
//              here, not read from the workspace), then the sandboxed grader of the hosted worker.
//   run:       opencode in the TMA sandbox with the USER's key, then the same grader.
//
// Everything that needs Docker comes in through `LocalDeps`, so a test passes fakes. Only numbers leave
// the machine (result.ts). The patch, the actions and the evidence manifest stay in a local runs folder
// (default ./tma-runs/<run-id>/) for the user.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { toolEnvironment } from '@itera/contracts';
import { materializeWorkspace, readInstruction } from '../../../evaluator/src/task.js';
import type { EvidenceManifest } from '../../../evaluator/src/types.js';
import { runAgent, type AgentRunResult } from '../agent-run.js';
import { exec } from '../exec.js';
import { gradeInSandbox } from '../grade.js';
import { evalLogOf, finalStatus, rateLimitedFinal, runScore } from '../outcome.js';
import { taskWallMs } from '../provenance.js';
import { defaultSandboxConfig, ensureSandboxImage, type SandboxConfig } from '../sandbox.js';
import { AGENT_FILES, commitBaseline, diffAgainstBaseline } from '../workspace.js';
import { childEnv, CliError, sandboxEnv, userEnv } from './env.js';
import { costSourceOf, resultRow, type ResultRow } from './result.js';
import { trackRun } from './cleanup.js';
import { REPO_ROOT, refuseMcp, type ResolvedTask } from './tasks.js';

/** The instruction file of a local workspace. It is ignored by the diff, so it never enters a patch. */
export const INSTRUCTION_FILE = 'INSTRUCTION.md';
export const LOCAL_GITIGNORE = `node_modules/\n/${INSTRUCTION_FILE}\n`;
export const SANDBOX_CONTEXT = join(REPO_ROOT, 'services', 'runner', 'sandbox');
export const DEFAULT_RUNS_DIR = 'tma-runs';

/** The grader call. `config` is the sandbox config of the command. */
export type GradeFn = (o: { runId: string; repoRoot: string; scenarioId: string; taskDir: string; patch: string; config: SandboxConfig }) => Promise<EvidenceManifest>;
export type RunAgentFn = typeof runAgent;

/** What the commands need from outside: Docker, the clock, the environment. A test replaces them. */
export interface LocalDeps {
  /** The environment that `userModelKey` reads. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  runAgent?: RunAgentFn;
  grade?: GradeFn;
  /** The sandbox config of the profile, and the image id of the sandbox image (docker). */
  sandbox?: (profile: string, log: (line: string) => void) => Promise<{ config: SandboxConfig; imageId: string | null }>;
  now?: () => Date;
}

export const defaultGrade: GradeFn = (o) => gradeInSandbox(o);

async function isEmptyOrAbsent(dir: string): Promise<boolean> {
  const st = await stat(dir).catch(() => null);
  if (!st) return true;
  if (!st.isDirectory()) return false;
  return (await readdir(dir)).length === 0;
}

/**
 * Materialize the agent-visible workspace of a task in `dest` (absent or empty). The hidden tests and
 * the solution are never copied. Dependencies are installed (the profile's install command) only with
 * `install`, so the default is offline and needs no npm.
 */
export async function materializeLocalWorkspace(
  r: ResolvedTask,
  dest: string,
  opts: { install: boolean; installCmd: string[]; installTimeoutMs: number },
): Promise<{ dir: string; instruction: string }> {
  const dir = resolve(dest);
  if (!(await isEmptyOrAbsent(dir))) throw new CliError(`${dest} exists and is not empty: give a new folder`);
  await materializeWorkspace(r.task, dir);
  if (opts.install) {
    const install = await exec(opts.installCmd[0]!, opts.installCmd.slice(1), {
      cwd: dir,
      timeoutMs: opts.installTimeoutMs,
      // As on the worker: no variable of this shell reaches npm (a .npmrc can expand ${VAR}).
      env: childEnv(),
    });
    if (install.code !== 0) throw new CliError(`install (${opts.installCmd.slice(0, 2).join(' ')}) failed: ${install.stderr.slice(0, 400)}`);
  }
  await writeFile(join(dir, '.gitignore'), LOCAL_GITIGNORE, 'utf-8');
  const instruction = join(dir, INSTRUCTION_FILE);
  await writeFile(instruction, `${await readInstruction(r.task)}\n`, 'utf-8');
  return { dir, instruction };
}

/**
 * The patch of an edited workspace: its diff against a FRESH baseline of the task. The baseline is
 * built from the task bundle, never from the workspace, so a harness cannot move the baseline (a
 * commit, a reset, a planted .git): the diff always shows what differs from the task as published.
 * A file that the harness adds under a protected path (a test) stays in the patch: the grader's
 * scope check then marks the run `invalid`, as on the worker.
 */
export async function workspacePatch(r: ResolvedTask, workspaceDir: string): Promise<string> {
  const ws = resolve(workspaceDir);
  if (!(await stat(ws).catch(() => null))?.isDirectory()) throw new CliError(`no workspace folder at ${workspaceDir}`);
  const root = await mkdtemp(join(tmpdir(), 'tma-base-'));
  try {
    const base = join(root, 'w');
    await materializeWorkspace(r.task, base);
    await commitBaseline(base, LOCAL_GITIGNORE);
    try {
      return await diffAgainstBaseline(base, ws);
    } catch (err) {
      const why = err instanceof Error ? err.message.split('\n')[0]!.slice(0, 300) : String(err);
      throw new CliError(`cannot diff the workspace ${workspaceDir}: ${why}. A folder inside it with its own .git is the usual cause: remove that .git.`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function newRunId(): string {
  const id = `local-${randomUUID().slice(0, 8)}`;
  // L10: a signal (Ctrl-C, docker stop) skips the `finally` of a run; the CLI then removes this id's containers.
  trackRun(id);
  return id;
}

/** Hide the user's key in a text. The key reaches only the gateway of a run; no log line may echo it. */
export function redact(text: string, secret?: string): string {
  return secret && secret.length >= 4 ? text.split(secret).join('[key]') : text;
}

/** Keep the run's evidence for the user, on this machine only. Never uploaded. */
export async function saveRunFolder(runsDir: string, runId: string, files: { patch: string; run: Record<string, unknown> }, secret?: string): Promise<string> {
  const dir = join(resolve(runsDir), runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'patch.diff'), redact(files.patch, secret), 'utf-8');
  await writeFile(join(dir, 'run.json'), redact(`${JSON.stringify(files.run, null, 2)}\n`, secret), 'utf-8');
  return dir;
}

export interface GradeOutcome {
  row: ResultRow;
  manifest: EvidenceManifest | null;
  runDir: string;
}

/** Grade one edited workspace with the hosted grader (any harness). Wall, cost and tokens are what the user reports. */
export async function gradeWorkspace(input: {
  r: ResolvedTask;
  workspaceDir: string;
  grade: GradeFn;
  config: SandboxConfig;
  runsDir: string;
  reported: { wallS: number | null; costUsd: number | null };
  log: (line: string) => void;
}): Promise<GradeOutcome> {
  refuseMcp(input.r);
  const runId = newRunId();
  const patch = await workspacePatch(input.r, input.workspaceDir);
  input.log(`[tma] grade ${runId}: task ${input.r.id}, patch ${patch.length} bytes`);
  let manifest: EvidenceManifest | null = null;
  let graderError: string | null = null;
  try {
    manifest = await input.grade({ runId, repoRoot: REPO_ROOT, scenarioId: input.r.id, taskDir: input.r.dir, patch, config: input.config });
  } catch (err) {
    graderError = err instanceof Error ? err.message : String(err);
    input.log(`[tma] grade ${runId}: grading failed: ${graderError}`);
  }
  const status = manifest ? finalStatus({ timedOut: false, patch }, manifest) : 'infra_error';
  const row = resultRow({
    itemSha256: input.r.itemSha256,
    repeat: 1,
    status,
    score: manifest ? runScore(status, manifest) : 0,
    manifest,
    wallS: input.reported.wallS,
    costUsd: input.reported.costUsd,
    tokensIn: null,
    tokensOut: null,
    facts: { emptyPatch: patch.trim() === '' },
  });
  const runDir = await saveRunFolder(input.runsDir, runId, { patch, run: { runId, mode: 'grade', status, score: row.score, grader_error: graderError, manifest } });
  return { row, manifest, runDir };
}

/** The agent directory must hold at least one agent file, as on the hosted worker. */
export async function checkAgentDir(agentDir: string): Promise<string> {
  const dir = resolve(agentDir);
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new CliError(`no agent folder at ${agentDir}`);
  const found = [];
  for (const name of [...AGENT_FILES, 'skills']) if (await stat(join(dir, name)).catch(() => null)) found.push(name);
  if (found.length === 0) throw new CliError(`the agent folder ${agentDir} has no AGENTS.md, CLAUDE.md or skills/: the sandbox copies only those`);
  return dir;
}

/** Run opencode in the TMA sandbox on one task item, then grade. The key goes only to the run's gateway. */
export async function runItem(input: {
  r: ResolvedTask;
  agentDir: string;
  model: string;
  modelKey: string;
  config: SandboxConfig;
  runAgent: RunAgentFn;
  grade: GradeFn;
  runsDir: string;
  repeat: number;
  log: (line: string) => void;
}): Promise<GradeOutcome & { costSource: ReturnType<typeof costSourceOf> | null }> {
  refuseMcp(input.r);
  const runId = newRunId();
  const log = (line: string) => input.log(redact(line, input.modelKey));
  const config: SandboxConfig = { ...input.config, wallMs: taskWallMs(input.r.task.contract.agent?.timeout_sec, input.config) };
  log(`[tma] run ${runId}: task ${input.r.id} repeat ${input.repeat}, model ${input.model}, wall ${Math.round(config.wallMs / 1000)} s`);
  let agent: AgentRunResult;
  try {
    agent = await input.runAgent({
      runId,
      repoRoot: REPO_ROOT,
      scenarioId: input.r.id,
      taskDir: input.r.dir,
      agentDir: input.agentDir,
      model: input.model,
      modelKey: input.modelKey,
      config,
      builtinTools: toolEnvironment(input.r.task.contract).builtin,
    });
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err), input.modelKey);
    log(`[tma] run ${runId}: the sandbox failed: ${message}`);
    const row = resultRow({ itemSha256: input.r.itemSha256, repeat: input.repeat, status: 'infra_error', score: 0, manifest: null, wallS: null, costUsd: null, tokensIn: null, tokensOut: null });
    const runDir = await saveRunFolder(input.runsDir, runId, { patch: '', run: { runId, mode: 'run', status: 'infra_error', sandbox_error: message } }, input.modelKey);
    return { row, manifest: null, runDir, costSource: null };
  }
  log(`[tma] run ${runId}: agent done in ${Math.round(agent.durationMs / 1000)} s, ${agent.actions.length} tool calls, patch ${agent.patch.length} bytes`);
  let manifest: EvidenceManifest | null = null;
  let graderError: string | null = null;
  try {
    manifest = await input.grade({ runId, repoRoot: REPO_ROOT, scenarioId: input.r.id, taskDir: input.r.dir, patch: agent.patch, config });
  } catch (err) {
    graderError = redact(err instanceof Error ? err.message : String(err), input.modelKey);
    log(`[tma] run ${runId}: grading failed: ${graderError}`);
  }
  const status = manifest ? finalStatus(agent, manifest) : 'infra_error';
  const usage = agent.modelUsage;
  const row = resultRow({
    itemSha256: input.r.itemSha256,
    repeat: input.repeat,
    status,
    score: manifest ? runScore(status, manifest) : 0,
    manifest,
    wallS: agent.durationMs / 1000,
    costUsd: usage ? usage.costUsd : agent.usage.costUsd,
    tokensIn: usage ? usage.tokensIn : agent.usage.inputTokens,
    tokensOut: usage ? usage.tokensOut : agent.usage.outputTokens,
    facts: { timedOut: agent.timedOut, costCapped: agent.costCapped, rateLimited: rateLimitedFinal(agent) > 0, emptyPatch: agent.patch.trim() === '' },
  });
  const runDir = await saveRunFolder(
    input.runsDir,
    runId,
    {
      patch: agent.patch,
      run: {
        runId,
        mode: 'run',
        status,
        score: row.score,
        grader_error: graderError,
        agent_errors: agent.agentErrors,
        actions: agent.actions,
        evidence: manifest ? evalLogOf(manifest, agent, status) : null,
      },
    },
    input.modelKey,
  );
  return { row, manifest, runDir, costSource: costSourceOf(usage) };
}

/** One cost source for the whole result: the common one, else `derived` (a mix is never `metered`). */
export function combineCostSources(sources: Array<ReturnType<typeof costSourceOf> | null>): ReturnType<typeof costSourceOf> {
  const known = sources.filter((s): s is ReturnType<typeof costSourceOf> => s !== null && s !== 'none');
  if (known.length === 0) return 'none';
  return known.every((s) => s === known[0]) ? known[0]! : 'derived';
}

/** The `docker image inspect` id of an image (sha256:<64 hex>), or null. */
export async function imageId(image: string): Promise<string | null> {
  const r = await exec('docker', ['image', 'inspect', '-f', '{{.Id}}', image]).catch(() => null);
  const id = r && r.code === 0 ? r.stdout.trim() : '';
  return /^sha256:[0-9a-f]{64}$/.test(id) ? id : null;
}

/**
 * The default `sandbox` dependency: the built-in profile, and the user's sandbox image or one built
 * from the bundled context (as the worker does at boot). No worker override (wall, cost cap) applies.
 */
export async function localSandbox(profile: string, log: (line: string) => void): Promise<{ config: SandboxConfig; imageId: string | null }> {
  const config = defaultSandboxConfig(sandboxEnv(profile));
  if (!userEnv('ITERA_SANDBOX_IMAGE')) {
    log('[tma] preparing the sandbox image (the first time, docker builds it: a few minutes)');
    config.image = await ensureSandboxImage(SANDBOX_CONTEXT);
  }
  return { config, imageId: await imageId(config.image) };
}

/** The sandbox config of a command. A Docker failure is a user error with the cause, not a stack trace. */
export async function prepareSandbox(deps: LocalDeps, profile: string, log: (line: string) => void): Promise<{ config: SandboxConfig; imageId: string | null }> {
  try {
    return await (deps.sandbox ?? localSandbox)(profile, log);
  } catch (err) {
    throw new CliError(`the sandbox is not ready (docker is needed to run or grade): ${err instanceof Error ? err.message.slice(0, 400) : String(err)}`);
  }
}

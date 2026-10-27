import { loadTask, readInstruction, scenarioDir } from '../../evaluator/src/task.js';
import { join } from 'node:path';
import { parseOpencodeEvents } from './trace.js';
import { runInSandbox, type SandboxConfig } from './sandbox.js';
import type { ModelUsage } from './model-usage.js';
import type { RouteId } from './model-route.js';
import type { AgentUsage, RunAction } from './types.js';
import type { CollectedSidecar, McpSidecarPlan } from './mcp-sidecar.js';
import { diffAgainstBaseline, prepareWorkspace } from './workspace.js';
import { collectRunArtifacts } from './run-artifacts.js';
import type { RunArtifact, SkippedArtifact } from '@itera/contracts/run-artifacts';

export interface AgentRunResult {
  scenarioId: string;
  model: string;
  agentFiles: string[];
  timedOut: boolean;
  exitCode: number;
  durationMs: number;
  actions: RunAction[];
  usage: AgentUsage;
  /** Usage measured by the gateway from OpenRouter's own accounting (the billed cost). Null if unknown. */
  modelUsage: ModelUsage | null;
  /** K10: the upstream route of the run (openrouter | opencode-go). */
  route: RouteId;
  /** True when the run's cost cap (ITERA_RUN_MAX_COST_USD) stopped the agent. */
  costCapped: boolean;
  agentErrors: string[];
  patch: string;
  /** ADR-11: final state + call log of each MCP sidecar (scored on the worker, never stored raw). */
  mcp?: CollectedSidecar[];
  /**
   * L17a: the agent's stored outputs (stderr tail, opencode trace, allowlisted files it added or modified),
   * collected before the workspace is removed. The worker adds result.json in front.
   */
  artifacts: RunArtifact[];
  /** L17a: what the collector left out, and why (goes into result.json). */
  artifactsSkipped: SkippedArtifact[];
}

/** The agent prompt is the task's instruction file (task.json `instruction`, Harbor's instruction.md). */
export async function scenarioPrompt(repoRoot: string, scenarioId: string, taskDir?: string): Promise<string> {
  return readInstruction(await loadTask(taskDir ?? scenarioDir(repoRoot, scenarioId)));
}

/** Prepare the workspace, run the agent in the sandbox, collect trace + patch. Grading is separate. */
export async function runAgent(opts: {
  runId: string;
  repoRoot: string;
  scenarioId: string;
  agentDir: string;
  model: string;
  /** The key of the run's route: OpenRouter (platform or BYOK) or opencode go (platform only). */
  modelKey: string;
  config: SandboxConfig;
  /** A user task fetched at its pinned commit (U19). Default: benchmarks/<scenarioId>. */
  taskDir?: string;
  /** ADR-11: the task's MCP sidecars and built-in tool allow-list (worker: planSidecars). */
  mcp?: McpSidecarPlan[];
  builtinTools?: readonly string[];
}): Promise<AgentRunResult> {
  const prompt = await scenarioPrompt(opts.repoRoot, opts.scenarioId, opts.taskDir);
  const ws = await prepareWorkspace({ repoRoot: opts.repoRoot, scenarioId: opts.scenarioId, taskDir: opts.taskDir, agentDir: opts.agentDir, installCmd: opts.config.profile.install_cmd });
  try {
    const outDir = join(ws.root, 'agent-out');
    const sandbox = await runInSandbox({
      runId: opts.runId,
      workspaceDir: ws.dir,
      outDir,
      model: opts.model,
      prompt,
      modelKey: opts.modelKey,
      config: opts.config,
      mcp: opts.mcp,
      builtinTools: opts.builtinTools,
    });
    const trace = parseOpencodeEvents(sandbox.events, (opts.mcp ?? []).map((m) => m.name));
    const patch = await diffAgainstBaseline(ws.dir, outDir);
    // L17a: the stored outputs, read now, BEFORE the workspace is removed. A collector failure never
    // fails the run: the outputs are a view for the owner, not evidence.
    let artifacts: RunArtifact[] = [];
    let artifactsSkipped: SkippedArtifact[] = [];
    try {
      const collected = await collectRunArtifacts({ baselineDir: ws.dir, agentTree: outDir, events: sandbox.events, stderrTail: sandbox.stderrTail, modelKey: opts.modelKey });
      artifacts = collected.artifacts;
      artifactsSkipped = collected.skipped;
    } catch (err) {
      console.error(JSON.stringify({ at: new Date().toISOString(), event: 'artifacts_failed', runId: opts.runId, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) }));
      artifactsSkipped = [{ path: 'files', reason: 'unreadable' }];
    }
    const agentErrors = [...trace.errors];
    if (sandbox.timedOut) agentErrors.push(`agent wall limit reached (${Math.round(opts.config.wallMs / 1000)} s)`);
    else if (sandbox.exitCode !== 0) agentErrors.push(`opencode exited with code ${sandbox.exitCode}`);
    const costCapped = sandbox.modelUsage?.capStopped === true;
    if (costCapped) {
      agentErrors.push(
        `model cost cap reached: US$${sandbox.modelUsage!.costUsd.toFixed(4)} spent, cap US$${sandbox.modelUsage!.maxCostUsd} per run (ITERA_RUN_MAX_COST_USD); the gateway refused further model calls`,
      );
    }
    return {
      scenarioId: opts.scenarioId,
      model: opts.model,
      agentFiles: ws.agentFiles,
      timedOut: sandbox.timedOut,
      exitCode: sandbox.exitCode,
      durationMs: sandbox.durationMs,
      actions: trace.actions,
      usage: trace.usage,
      modelUsage: sandbox.modelUsage,
      route: sandbox.route,
      costCapped,
      agentErrors,
      patch,
      mcp: sandbox.mcp,
      artifacts,
      artifactsSkipped,
    };
  } finally {
    await ws.cleanup();
  }
}

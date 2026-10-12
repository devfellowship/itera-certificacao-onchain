import { loadTask, readInstruction, scenarioDir } from '../../evaluator/src/task.js';
import { join } from 'node:path';
import { parseOpencodeEvents } from './trace.js';
import { runInSandbox, type SandboxConfig } from './sandbox.js';
import type { ModelUsage } from './model-usage.js';
import type { AgentUsage, RunAction } from './types.js';
import { diffAgainstBaseline, prepareWorkspace } from './workspace.js';

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
  /** True when the run's cost cap (ITERA_RUN_MAX_COST_USD) stopped the agent. */
  costCapped: boolean;
  agentErrors: string[];
  patch: string;
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
  openrouterKey: string;
  config: SandboxConfig;
}): Promise<AgentRunResult> {
  const prompt = await scenarioPrompt(opts.repoRoot, opts.scenarioId);
  const ws = await prepareWorkspace({ repoRoot: opts.repoRoot, scenarioId: opts.scenarioId, agentDir: opts.agentDir, installCmd: opts.config.profile.install_cmd });
  try {
    const outDir = join(ws.root, 'agent-out');
    const sandbox = await runInSandbox({
      runId: opts.runId,
      workspaceDir: ws.dir,
      outDir,
      model: opts.model,
      prompt,
      openrouterKey: opts.openrouterKey,
      config: opts.config,
    });
    const trace = parseOpencodeEvents(sandbox.events);
    const patch = await diffAgainstBaseline(ws.dir, outDir);
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
      costCapped,
      agentErrors,
      patch,
    };
  } finally {
    await ws.cleanup();
  }
}

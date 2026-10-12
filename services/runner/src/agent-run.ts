import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseOpencodeEvents } from './trace.js';
import { runInSandbox, type SandboxConfig } from './sandbox.js';
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
  agentErrors: string[];
  patch: string;
}

export async function scenarioPrompt(repoRoot: string, scenarioId: string): Promise<string> {
  const spec = JSON.parse(await readFile(join(repoRoot, 'benchmarks', scenarioId, 'scenario.json'), 'utf-8'));
  if (typeof spec.agent_prompt !== 'string' || !spec.agent_prompt) throw new Error(`scenario ${scenarioId} has no agent_prompt`);
  return spec.agent_prompt;
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
  const ws = await prepareWorkspace({ repoRoot: opts.repoRoot, scenarioId: opts.scenarioId, agentDir: opts.agentDir });
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
    return {
      scenarioId: opts.scenarioId,
      model: opts.model,
      agentFiles: ws.agentFiles,
      timedOut: sandbox.timedOut,
      exitCode: sandbox.exitCode,
      durationMs: sandbox.durationMs,
      actions: trace.actions,
      usage: trace.usage,
      agentErrors,
      patch,
    };
  } finally {
    await ws.cleanup();
  }
}

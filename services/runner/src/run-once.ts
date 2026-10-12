// Local CLI: run ONE agent on ONE scenario in the sandbox, then grade the patch.
//   tsx src/run-once.ts --scenario webhook-ledger --agent-dir <dir> --model <openrouter-model> [--out result.json]
// Needs: docker, git, npm, the sandbox image (ITERA_SANDBOX_IMAGE, default itera-runner-sandbox:latest)
// and OPENROUTER_API_KEY (or ITERA_RUNNER_OPENROUTER_KEY) in the environment.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gradeInSandbox } from './grade.js';
import { runAgent } from './agent-run.js';
import { finalStatus } from './outcome.js';
import { defaultSandboxConfig } from './sandbox.js';

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key && value !== undefined) args[key] = value;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.scenario || !args['agent-dir'] || !args.model) {
    throw new Error('Usage: run-once --scenario <id> --agent-dir <dir> --model <openrouter-model> [--out <file.json>]');
  }
  const openrouterKey = process.env.ITERA_RUNNER_OPENROUTER_KEY ?? process.env.OPENROUTER_API_KEY;
  if (!openrouterKey) throw new Error('set ITERA_RUNNER_OPENROUTER_KEY or OPENROUTER_API_KEY');

  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  const runId = `local-${randomUUID().slice(0, 8)}`;
  const config = defaultSandboxConfig();
  console.error(`[run-once] run ${runId}: scenario=${args.scenario} model=${args.model} wall=${config.wallMs}ms`);

  const agent = await runAgent({
    runId,
    repoRoot,
    scenarioId: args.scenario,
    agentDir: resolve(args['agent-dir']),
    model: args.model,
    openrouterKey,
    config,
  });
  console.error(`[run-once] agent done in ${agent.durationMs} ms: ${agent.actions.length} tool calls, patch ${agent.patch.length} bytes`);

  const manifest = await gradeInSandbox({ runId, repoRoot, scenarioId: args.scenario, patch: agent.patch, config });
  const status = finalStatus(agent, manifest);
  const result = { runId, status, ...agent, manifest };
  const json = JSON.stringify(result, null, 2);
  if (args.out) await writeFile(args.out, json, 'utf-8');
  else console.log(json);

  const s = manifest.score;
  console.error(
    `[run-once] status ${status}, score ${s.total}/100 (public ${s.public_behavior}, hidden ${s.hidden_behavior}, regression ${s.regression}, ` +
      `scope ${s.patch_integrity_and_scope}, evidence ${s.reproducible_evidence}); errors: ${[...agent.agentErrors, ...manifest.errors].join('; ') || 'none'}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

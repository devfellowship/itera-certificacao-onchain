// Local CLI: run ONE agent on ONE scenario in the sandbox, then grade the patch. A thin alias for
// `tma run` (src/cli/commands/run.ts); the old flag --scenario works as --task.
//   tsx src/run-once.ts --scenario tsk_webhook_dup --agent-dir <dir> --model <openrouter-model | opencode-go/<model>> [--out result.json]
// Needs: docker, git, npm and a model key of YOUR own in the environment (OPENROUTER_API_KEY, or
// OPENCODE_GO_API_KEY for an opencode-go/<model>). `--agent <id>` is optional here: without it the
// result carries a placeholder agent id (all zeros), good for a local look but not for `tma upload`.
// The result is the numbers-only tma-local-result/1; the actions and the patch go to ./tma-runs/.
import { main } from './cli/tma.js';

/** `--scenario <id>` → `--task <id>`; a placeholder agent id when `--agent` is absent. */
export function runOnceArgs(argv: string[]): string[] {
  const args = argv.map((a) => (a === '--scenario' ? '--task' : a.startsWith('--scenario=') ? `--task=${a.slice('--scenario='.length)}` : a));
  const hasAgent = args.some((a) => a === '--agent' || a.startsWith('--agent='));
  return ['run', ...args, ...(hasAgent ? [] : ['--agent', '00000000-0000-4000-8000-000000000000'])];
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/run-once.ts')) {
  main(runOnceArgs(process.argv.slice(2))).then((code) => process.exit(code));
}

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runEvaluation } from './runner.js';
import { validateTask } from './validate.js';

// Usage:
//   evaluator --scenario <id> --patch <diff> [--out <manifest.json>]     grade benchmarks/<id>
//   evaluator --task <dir> --patch <diff> [--out <manifest.json>]        grade any task bundle
//   evaluator --validate --task <dir> [--repeats 3] [--out <gate.json>]  run the validation gate
// This CLI runs the verifier as a local child process (NOT a sandbox). The runner grades in
// sandbox containers through services/runner/src/grade.ts instead.
function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!.replace(/^--/, '');
    if (key === 'validate') {
      args.set('validate', 'true');
      continue;
    }
    const value = argv[i + 1];
    if (value !== undefined) args.set(key, value);
    i++;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  const out = args.get('out');
  const taskDir = args.get('task') ? resolve(args.get('task')!) : undefined;

  if (args.has('validate')) {
    if (!taskDir) throw new Error('Usage: evaluator --validate --task <dir> [--repeats 3] [--out <gate.json>]');
    const gate = await validateTask({ taskDir, repeats: Number(args.get('repeats') ?? 3) });
    const json = JSON.stringify(gate, null, 2);
    if (out) await writeFile(out, json, 'utf-8');
    else console.log(json);
    console.log(`\nGate: ${gate.status}`);
    if (gate.status !== 'ready') process.exitCode = 1;
    return;
  }

  const scenario = args.get('scenario');
  const patchFile = args.get('patch');
  if ((!scenario && !taskDir) || !patchFile) {
    throw new Error('Usage: evaluator (--scenario <id> | --task <dir>) --patch <path-to-diff> [--out <manifest.json>]');
  }
  const patch = await readFile(patchFile, 'utf-8');
  const manifest = await runEvaluation({ repoRoot, scenarioId: scenario, taskDir, patch });
  const json = JSON.stringify(manifest, null, 2);

  if (out) {
    await writeFile(out, json, 'utf-8');
    console.log(`Manifest written to ${out}`);
  } else {
    console.log(json);
  }

  console.log(`\nScore: ${manifest.score.total}/100`);
  if (manifest.errors.length > 0) {
    console.error(`Errors: ${manifest.errors.join('; ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

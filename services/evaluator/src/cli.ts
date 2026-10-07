import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runEvaluation } from './runner.js';

function parseArgs(argv: string[]): { scenario: string; patchFile: string; out?: string } {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key && value) args.set(key, value);
  }

  const scenario = args.get('scenario');
  const patchFile = args.get('patch');
  if (!scenario || !patchFile) {
    throw new Error('Usage: evaluator --scenario <id> --patch <path-to-diff> [--out <manifest.json>]');
  }
  return { scenario, patchFile, out: args.get('out') };
}

async function main(): Promise<void> {
  const { scenario, patchFile, out } = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  const patch = await readFile(patchFile, 'utf-8');

  const manifest = await runEvaluation({ repoRoot, scenarioId: scenario, patch });
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

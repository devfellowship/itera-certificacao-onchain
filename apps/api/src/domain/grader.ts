import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.js';

export interface EvidenceManifest {
  schema_version: string;
  evaluator_version: string;
  scenario_id: string;
  generated_at: string;
  fixture_hash: string;
  patch_hash: string;
  patch_scope: { changed_files: string[]; allowed: boolean };
  tests: {
    public_baseline: { total: number; passed: number; failed: number };
    public_after_patch: { total: number; passed: number; failed: number };
    hidden: { total: number; passed: number; failed: number };
  };
  score: {
    public_behavior: number;
    hidden_behavior: number;
    regression: number;
    patch_integrity_and_scope: number;
    reproducible_evidence: number;
    total: number;
  };
  errors: string[];
}

/**
 * Runs services/evaluator as a SEPARATE PROCESS, not an in-process import — matches this repo's
 * own convention (see services/run-issuer/src/client.ts's comment on duplicating rather than
 * cross-importing between services) and the doc's architecture table, which lists the grader as
 * its own isolated component ("Worker: Processo isolado"). Spawns the evaluator's existing CLI
 * (services/evaluator/src/cli.ts), the same contract `npm run cli -w @itera/evaluator` already
 * uses, rather than a bespoke in-process call that would need @itera/evaluator built as a
 * library with its own dist output (it has none — TS source + a CLI entrypoint only).
 *
 * Takes 15-90s for a real grading run (observed range across this project's own test suite) --
 * the caller is expected to accept that this blocks the HTTP request; there is no async
 * worker/queue in this MVP (doc section 4 lists one as a future component, not required for the
 * 72h build).
 */
export async function gradePatch(scenarioId: string, patch: string): Promise<EvidenceManifest> {
  const workDir = await mkdtemp(join(tmpdir(), 'itera-api-grade-'));
  const patchFile = join(workDir, 'patch.diff');
  const outFile = join(workDir, 'manifest.json');
  try {
    await writeFile(patchFile, patch, 'utf-8');
    const result = await run(
      'npx',
      ['tsx', 'services/evaluator/src/cli.ts', '--scenario', scenarioId, '--patch', patchFile, '--out', outFile],
      REPO_ROOT,
    );
    const manifestText = await readFile(outFile, 'utf-8').catch(() => null);
    if (!manifestText) {
      throw new GraderError(`evaluator produced no manifest (exit ${result.code}): ${result.stderr.slice(0, 1000)}`);
    }
    return JSON.parse(manifestText) as EvidenceManifest;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export class GraderError extends Error {}

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32' });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stderr }));
  });
}

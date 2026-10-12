// Grading in a sandbox container. The evaluator executes agent-authored src/** (through vitest), so
// it must not run in the worker process, which is root, holds the Docker socket and DATABASE_URL.
// The grader container: same image as the agent sandbox, --network none, no secret, no socket,
// non-root, capabilities dropped. It gets the fixture (with node_modules), the hidden tests, the
// evaluator bundle and the patch, and returns the manifest JSON through `docker cp`.
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceManifest } from '../../evaluator/src/types.js';
import { exec, pipe } from './exec.js';
import { SANDBOX_UID, type SandboxConfig } from './sandbox.js';
import { WORKSPACE_IN_SANDBOX } from './trace.js';

export const GRADE_WALL_MS = 240_000;
const BUNDLE_REL = join('services', 'evaluator', 'dist', 'cli.mjs');

/** Bundle services/evaluator/src/cli.ts into one ESM file (no tsx needed in the grader). */
export async function ensureEvaluatorBundle(repoRoot: string): Promise<string> {
  const out = join(repoRoot, BUNDLE_REL);
  if (await stat(out).catch(() => null)) return out;
  const { build } = await import('esbuild');
  await build({
    entryPoints: [join(repoRoot, 'services', 'evaluator', 'src', 'cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: out,
    logLevel: 'silent',
  });
  return out;
}

/** `docker create` arguments for the grader. No network at all, no env, no mounts. */
export function buildGraderArgs(opts: { name: string; config: SandboxConfig; scenarioId: string }): string[] {
  const root = WORKSPACE_IN_SANDBOX;
  return [
    'create',
    '--name', opts.name,
    '--label', 'itera.role=agent-sandbox',
    '--network', 'none',
    '--memory', opts.config.memory,
    '--memory-swap', opts.config.memory,
    '--cpus', opts.config.cpus,
    '--pids-limit', String(opts.config.pidsLimit),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', `${SANDBOX_UID}:${SANDBOX_UID}`,
    '-e', 'NPM_CONFIG_OFFLINE=true',
    '-w', root,
    '--entrypoint', 'node',
    opts.config.image,
    `${root}/${BUNDLE_REL}`,
    '--scenario', opts.scenarioId,
    '--patch', `${root}/patch.diff`,
    '--out', `${root}/out/manifest.json`,
  ];
}

export class GraderError extends Error {}

export async function gradeInSandbox(opts: {
  runId: string;
  repoRoot: string;
  scenarioId: string;
  patch: string;
  config: SandboxConfig;
}): Promise<EvidenceManifest> {
  if (!/^[a-z0-9-]+$/.test(opts.scenarioId)) throw new GraderError(`invalid scenario id: ${opts.scenarioId}`);
  const bundle = await ensureEvaluatorBundle(opts.repoRoot);
  const root = await mkdtemp(join(tmpdir(), 'itera-grade-'));
  const id = opts.runId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  const name = `itera-grade-${id}`;
  try {
    const scenarioSrc = join(opts.repoRoot, 'benchmarks', opts.scenarioId);
    const scenarioDst = join(root, 'benchmarks', opts.scenarioId);
    await cp(join(scenarioSrc, 'fixture'), join(scenarioDst, 'fixture'), {
      recursive: true,
      filter: (src) => !src.split('/').includes('node_modules'),
    });
    await cp(join(scenarioSrc, 'evaluator', 'hidden'), join(scenarioDst, 'evaluator', 'hidden'), { recursive: true });
    await cp(join(scenarioSrc, 'scenario.json'), join(scenarioDst, 'scenario.json'));
    // Dependencies come from the lockfile, on the trusted side; --ignore-scripts runs no package code.
    const install = await exec('npm', ['ci', '--include=dev', '--no-audit', '--no-fund', '--ignore-scripts'], {
      cwd: join(scenarioDst, 'fixture'),
      timeoutMs: 180_000,
    });
    if (install.code !== 0) throw new GraderError(`npm ci for the grader failed: ${install.stderr.slice(0, 300)}`);
    await mkdir(join(root, 'services', 'evaluator', 'dist'), { recursive: true });
    await cp(bundle, join(root, BUNDLE_REL));
    await mkdir(join(root, 'out'), { recursive: true });
    await writeFile(join(root, 'patch.diff'), opts.patch, 'utf-8');

    const created = await exec('docker', buildGraderArgs({ name, config: opts.config, scenarioId: opts.scenarioId }));
    if (created.code !== 0) throw new GraderError(`grader create failed: ${created.stderr.slice(0, 300)}`);
    const copyIn = await pipe(
      { cmd: 'tar', args: ['--mode=a+rwX', '-C', root, '-cf', '-', '.'] },
      { cmd: 'docker', args: ['cp', '-', `${name}:${WORKSPACE_IN_SANDBOX}`] },
    );
    if (copyIn.fromCode !== 0 || copyIn.toCode !== 0) throw new GraderError(`grader copy-in failed: ${copyIn.stderr.slice(0, 300)}`);

    const run = await exec('docker', ['start', '-a', name], { timeoutMs: GRADE_WALL_MS });
    if (run.timedOut) {
      await exec('docker', ['kill', name]);
      throw new GraderError(`grading exceeded ${GRADE_WALL_MS / 1000} s`);
    }
    const out = await exec('docker', ['cp', `${name}:${WORKSPACE_IN_SANDBOX}/out/manifest.json`, join(root, 'manifest.json')]);
    if (out.code !== 0) throw new GraderError(`grader produced no manifest (exit ${run.code}): ${run.stderr.slice(-300)}`);
    const text = await readFile(join(root, 'manifest.json'), 'utf-8');
    return parseManifest(text);
  } finally {
    await exec('docker', ['rm', '-f', name]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

/** Parse and shape-check the grader output. Anything else is a grader failure, never a score. */
export function parseManifest(text: string): EvidenceManifest {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GraderError('grader output is not JSON');
  }
  const suite = (s: any) => s && typeof s.total === 'number' && typeof s.passed === 'number' && typeof s.failed === 'number';
  const ok =
    value &&
    typeof value.scenario_id === 'string' &&
    typeof value.patch_hash === 'string' &&
    value.patch_scope && typeof value.patch_scope.allowed === 'boolean' && Array.isArray(value.patch_scope.changed_files) &&
    value.tests && suite(value.tests.public_baseline) && suite(value.tests.public_after_patch) && suite(value.tests.hidden) &&
    value.score && typeof value.score.total === 'number' &&
    Array.isArray(value.errors);
  if (!ok) throw new GraderError('grader output is not an evidence manifest');
  return value as EvidenceManifest;
}

// Grading in sandbox containers (ADR-9). The evaluator orchestrates on the TRUSTED side (it copies
// the task, installs the lockfile without scripts, applies the patch with git, checks the scope and
// computes the score). Only the verifier command — the step that executes agent-authored code and
// task-authored tests — runs in a container, and every suite gets a FRESH one:
//
//   public-baseline, public-after-patch, hidden: three containers, nothing carries over.
//
// Each grading container: no network, no Docker socket, no environment from the worker (no
// DATABASE_URL, no key), read-only root filesystem, a uid (10002) that is neither root nor the
// agent's uid, all capabilities dropped, no-new-privileges, CPU / memory / pids / open-files /
// file-size limits, a wall timeout. The workspace is root-owned and not writable by that uid (only
// its top directory is sticky-writable, for vitest's temporary config file), so the tests, the
// test framework in node_modules and the config cannot be rewritten by the patched code. The
// report comes back with `docker cp` and is cross-checked against the verifier exit code
// (services/evaluator/src/suite.ts interpretRun). See services/runner/README.md "Grader sandbox".
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvaluation } from '../../evaluator/src/runner.js';
import { BUILD_FAILED_EXIT, BUILD_FAILED_MARKER, type SuiteExecutor, type SuiteRunRequest } from '../../evaluator/src/suite.js';
import { scenarioDir } from '../../evaluator/src/task.js';
import type { EvidenceManifest, ExecutorInfo } from '../../evaluator/src/types.js';
import { validateTask, type McpGate, type ValidationResult } from '../../evaluator/src/validate.js';
import type { McpServerEvidence } from '../../evaluator/src/mcp-state.js';
import { exec, pipe } from './exec.js';
import type { SandboxConfig } from './sandbox.js';

/** The grader's uid: not root, not the agent sandbox's 10001. */
export const GRADER_UID = 10002;
export const GRADER_WORKDIR = '/workspace/w';
export const GRADER_REPORT = '/out/report/report.json';
/** Upper bound for the report file the worker reads back. */
const MAX_REPORT_BYTES = 20 * 1024 * 1024;

/** What every grading container enforces. Recorded in the manifest (environment.executor.controls). */
export const GRADER_CONTROLS = [
  'network=none',
  'docker-socket=absent',
  'env=empty (no worker variable)',
  'rootfs=read-only',
  `uid=${GRADER_UID} (not root, not the agent uid)`,
  'cap-drop=ALL',
  'no-new-privileges',
  'workspace=root-owned, not writable by the test uid',
  'limits: cpus, memory (no swap), pids, nofile, fsize, wall timeout',
  'one fresh container per suite; hidden tests only in the hidden-suite container',
  'patch applied and scope checked outside the container',
  'report cross-checked with the verifier exit code',
];

function cap(value: number | undefined, max: number): number {
  return value && value > 0 ? Math.min(value, max) : max;
}

function memoryMb(memory: string): number {
  const m = memory.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([kmg]?)b?$/);
  if (!m) return 2048;
  const n = Number(m[1]);
  return Math.floor(m[2] === 'g' ? n * 1024 : m[2] === 'k' ? n / 1024 : m[2] === 'm' ? n : n / (1024 * 1024));
}

/**
 * The only images a task may name in verifier.image: an Itera grader image (graders/<name>/), pinned
 * by digest. The task schema has the same pattern; this is the second check, on the worker.
 */
export const GRADER_IMAGE_PATTERN = /^ghcr\.io\/devfellowship\/testmyagent-grader-[a-z0-9][a-z0-9-]{0,40}@sha256:[0-9a-f]{64}$/;

/** The image of one verifier run: the task's digest-pinned grader image, else the sandbox image. */
export function graderImage(config: SandboxConfig, image?: string): string {
  if (image === undefined || image === '') return config.image;
  if (!GRADER_IMAGE_PATTERN.test(image)) throw new Error(`verifier.image is not a digest-pinned Itera grader image: ${image.slice(0, 120)}`);
  return image;
}

/** task.json verifier.cwd (ADR-5): a workspace-relative directory; the schema pattern, checked again here. */
const REL_DIR = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9_.@+-]+(\/[A-Za-z0-9_.@+-]+)*$/;

/** The container working directory of one verifier run: the workspace, or verifier.cwd inside it. */
export function graderWorkdir(cwd?: string): string {
  if (cwd === undefined || cwd === '' || cwd === '.') return GRADER_WORKDIR;
  if (!REL_DIR.test(cwd)) throw new Error(`verifier.cwd is not a workspace-relative directory: ${cwd.slice(0, 120)}`);
  return `${GRADER_WORKDIR}/${cwd}`;
}

/** POSIX single-quote one shell word. */
export function shellQuote(word: string): string {
  return `'${word.split("'").join(`'\\''`)}'`;
}

/**
 * The container command of one run. With environment.build (ADR-5) it is `sh -c`: the build in the
 * workspace root (its output to stderr), then `exec` of the verifier argv, passed as "$@" (never
 * through the shell parser). A failed build exits BUILD_FAILED_EXIT with BUILD_FAILED_MARKER.
 */
export function graderCommand(argv: string[], workdir: string, build?: string[]): string[] {
  if (!build || build.length === 0) return argv;
  const script = `cd ${GRADER_WORKDIR} && ${build.map(shellQuote).join(' ')} >&2 || { echo ${shellQuote(BUILD_FAILED_MARKER)} >&2; exit ${BUILD_FAILED_EXIT}; }; cd ${shellQuote(workdir)} && exec "$@"`;
  return ['sh', '-c', script, 'sh', ...argv];
}

/** `docker create` arguments for one verifier run. */
export function buildGraderArgs(opts: { name: string; config: SandboxConfig; argv: string[]; limits?: SuiteRunRequest['limits']; image?: string; cwd?: string; build?: string[] }): string[] {
  const mem = `${cap(opts.limits?.memoryMb, memoryMb(opts.config.memory))}m`;
  const cpus = String(cap(opts.limits?.cpus, Number(opts.config.cpus) || 2));
  const workdir = graderWorkdir(opts.cwd);
  const argv = graderCommand(opts.argv.map((a) => a.split('{report}').join(GRADER_REPORT)), workdir, opts.build);
  return [
    'create',
    '--name', opts.name,
    '--label', 'itera.role=agent-sandbox',
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
    '--mount', 'type=volume,dst=/workspace',
    '--mount', 'type=volume,dst=/out',
    '--memory', mem,
    '--memory-swap', mem,
    '--cpus', cpus,
    '--pids-limit', String(opts.config.pidsLimit),
    '--ulimit', 'nofile=1024:1024',
    '--ulimit', 'fsize=268435456:268435456',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', `${GRADER_UID}:${GRADER_UID}`,
    '-e', 'HOME=/tmp',
    '-e', 'CI=1',
    '-e', 'NPM_CONFIG_OFFLINE=true',
    '-e', 'NPM_CONFIG_UPDATE_NOTIFIER=false',
    '-w', workdir,
    '--entrypoint', argv[0]!,
    graderImage(opts.config, opts.image),
    ...argv.slice(1),
  ];
}

/**
 * Stage a copy of the workspace for one container: without .git, every file root-readable and not
 * group/other-writable (docker cp writes them as root), the top directory (and verifier.cwd) with its node_modules/.vite
 * sticky and world-writable (vite writes its bundled config next to vitest.config.ts; vitest keeps
 * a results cache), and an empty world-writable report directory.
 */
/**
 * environment.build outputs (a `*` segment matches one directory) -> the directories they name.
 * Every path component must be a real directory or absent: a symbolic link (a patch can add one;
 * it is a scope violation, but the suites still run) is never followed, so rm and chmod below stay
 * inside the staged workspace.
 */
export async function expandOutputs(root: string, outputs: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  const walk = async (rel: string, segs: string[]): Promise<void> => {
    if (rel) {
      const st = await lstat(join(root, rel)).catch(() => null);
      if (st && !st.isDirectory()) return; // a file or a symbolic link: not an output directory
    }
    if (segs.length === 0) return void found.add(rel);
    const [head, ...rest] = segs as [string, ...string[]];
    if (head !== '*') return walk(rel ? `${rel}/${head}` : head, rest);
    const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) await walk(rel ? `${rel}/${e.name}` : e.name, rest);
  };
  for (const out of outputs) await walk('', out.split('/'));
  return [...found].sort();
}

/** The staged directory of verifier.cwd, or null when a component is missing, a file or a symbolic link. */
async function realSubdir(root: string, rel: string): Promise<string | null> {
  let dir = root;
  for (const seg of rel.split('/')) {
    dir = join(dir, seg);
    const st = await lstat(dir).catch(() => null);
    if (!st?.isDirectory()) return null;
  }
  return dir;
}

/** The top directory, or verifier.cwd: sticky and world-writable, plus its node_modules/.vite cache. */
async function openForVite(dir: string): Promise<void> {
  if (await stat(join(dir, 'node_modules')).catch(() => null)) {
    await mkdir(join(dir, 'node_modules', '.vite'), { recursive: true });
    await chmod(join(dir, 'node_modules', '.vite'), 0o1777);
  }
  await chmod(dir, 0o1777);
}

export async function stageWorkspace(workspaceDir: string, stageRoot: string, buildOutputs: readonly string[] = [], cwd?: string): Promise<void> {
  const w = join(stageRoot, 'w');
  await cp(workspaceDir, w, { recursive: true, verbatimSymlinks: true, filter: (src) => !src.split('/').includes('.git') });
  const chmodR = await exec('chmod', ['-R', 'a+rX,go-w', w]);
  if (chmodR.code !== 0) throw new Error(`chmod failed: ${chmodR.stderr.slice(0, 200)}`);
  await openForVite(w);
  // verifier.cwd (ADR-5) gets the same: vite writes its bundled config next to the package's
  // vitest.config.ts. Sticky: the grader uid cannot delete or rename the root-owned files there.
  if (cwd && cwd !== '.') {
    const dir = await realSubdir(w, cwd);
    if (dir) await openForVite(dir);
  }
  // Build outputs start EMPTY (a stale build must not pass for a fresh one) and writable by the
  // grader uid; loadTask refused any output under node_modules or under protected_paths.
  for (const rel of await expandOutputs(w, buildOutputs)) {
    const dir = join(w, rel);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o777);
  }
  await mkdir(join(stageRoot, 'out', 'report'), { recursive: true });
  await chmod(join(stageRoot, 'out', 'report'), 0o777);
}

export function sandboxExecutor(opts: { runId: string; config: SandboxConfig }): SuiteExecutor {
  const id = opts.runId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  const infos = new Map<string, ExecutorInfo>();
  /** A digest-pinned grader image is pulled once per worker; the sandbox image is built locally. */
  const ensureImage = async (image: string) => {
    if (image === opts.config.image) return;
    if ((await exec('docker', ['image', 'inspect', '-f', '{{.Id}}', image])).code === 0) return;
    const pulled = await exec('docker', ['pull', '--quiet', image], { timeoutMs: 600_000 });
    if (pulled.code !== 0) throw new Error(`grader image pull failed: ${pulled.stderr.slice(0, 300)}`);
  };
  return {
    async describe(d) {
      const image = graderImage(opts.config, d?.image);
      const cached = infos.get(image);
      if (cached) return cached;
      await ensureImage(image);
      const inspect = await exec('docker', ['image', 'inspect', '-f', '{{.Id}}', image]);
      const info: ExecutorInfo = {
        profile: 'sandbox-container',
        image,
        image_id: inspect.code === 0 ? inspect.stdout.trim() : null,
        node_version: null,
        controls: GRADER_CONTROLS,
      };
      infos.set(image, info);
      return info;
    },
    async runSuite(req) {
      const label = req.label.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
      const name = `itera-grade-${id}-${label}`;
      const stage = await mkdtemp(join(tmpdir(), 'itera-grade-'));
      try {
        await stageWorkspace(req.workspaceDir, stage, req.build?.outputs, req.cwd);
        await exec('docker', ['rm', '-fv', name]);
        await ensureImage(graderImage(opts.config, req.image));
        const created = await exec('docker', buildGraderArgs({ name, config: opts.config, argv: req.argv, limits: req.limits, image: req.image, cwd: req.cwd, build: req.build?.argv }));
        if (created.code !== 0) throw new Error(`grader create failed: ${created.stderr.slice(0, 300)}`);
        const ws = await pipe({ cmd: 'tar', args: ['-C', stage, '-cf', '-', 'w'] }, { cmd: 'docker', args: ['cp', '-', `${name}:/workspace`] });
        const out = await pipe({ cmd: 'tar', args: ['-C', join(stage, 'out'), '-cf', '-', '.'] }, { cmd: 'docker', args: ['cp', '-', `${name}:/out`] });
        if (ws.fromCode !== 0 || ws.toCode !== 0 || out.fromCode !== 0 || out.toCode !== 0) {
          throw new Error(`grader copy-in failed: ${(ws.stderr + out.stderr).slice(0, 300)}`);
        }
        const started = Date.now();
        const run = await exec('docker', ['start', '-a', name], { timeoutMs: req.timeoutMs });
        const durationMs = Date.now() - started;
        if (run.timedOut) await exec('docker', ['kill', name]);
        const state = await exec('docker', ['inspect', '-f', '{{.State.ExitCode}}', name]);
        const exitCode = run.timedOut ? null : Number(state.stdout.trim());
        const local = join(stage, 'report.json');
        const got = await exec('docker', ['cp', `${name}:${GRADER_REPORT}`, local]);
        let report: string | null = null;
        if (got.code === 0) {
          const st = await stat(local).catch(() => null);
          // docker cp of a symlink planted in place of the report copies the link, not a file.
          if (st?.isFile() && st.size <= MAX_REPORT_BYTES) report = await readFile(local, 'utf-8');
        }
        return { exitCode: Number.isFinite(exitCode) ? exitCode : null, timedOut: run.timedOut, durationMs, report, stderrTail: run.stderr.slice(-2000) };
      } finally {
        await exec('docker', ['rm', '-fv', name]).catch(() => undefined);
        await rm(stage, { recursive: true, force: true });
      }
    },
  };
}

export class GraderError extends Error {}

/** Grade one patch for the worker. A curated task is benchmarks/<scenarioId>; a user task passes taskDir. */
export async function gradeInSandbox(opts: {
  runId: string;
  repoRoot: string;
  scenarioId: string;
  taskDir?: string;
  patch: string;
  config: SandboxConfig;
  /** ADR-11: the scored final state of the task's MCP servers (mcp-sidecar.ts mcpEvidence). */
  mcp?: McpServerEvidence[];
}): Promise<EvidenceManifest> {
  const taskDir = opts.taskDir ?? scenarioDir(opts.repoRoot, opts.scenarioId);
  try {
    return await runEvaluation({ taskDir, scenarioId: opts.scenarioId, patch: opts.patch, executor: sandboxExecutor(opts), mcp: opts.mcp });
  } catch (err) {
    throw new GraderError(err instanceof Error ? err.message : String(err));
  }
}

/** The validation gate of a user task (ADR-8), with every verifier run in a grading container. */
export function validateTaskInSandbox(opts: { runId: string; taskDir: string; config: SandboxConfig; repeats?: number; mcpGate?: McpGate }): Promise<ValidationResult> {
  return validateTask({ taskDir: opts.taskDir, repeats: opts.repeats, executor: sandboxExecutor(opts), mcpGate: opts.mcpGate });
}

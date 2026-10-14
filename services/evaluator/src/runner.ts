import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPatchScope } from './patch-scope.js';
import { computeScore, runScorers, SCORERS } from './score.js';
import { MCP_STATE_WEIGHT, mcpStateScore, type McpServerEvidence } from './mcp-state.js';
import { EMPTY_SUITE, interpretRun, localExecutor, resolveCmd, type SuiteExecutor } from './suite.js';
import { addTests, hashDirectory, loadTask, materializeWorkspace, scenarioDir, type LoadedTask } from './task.js';
import type { EvalLog, ExecutorInfo, Score, TestSuiteResult } from './types.js';

export const EVALUATOR_VERSION = '0.2.0';
export const DEFAULT_INSTALL = ['npm', 'ci', '--include=dev', '--no-audit', '--no-fund', '--ignore-scripts'];
const INSTALL_TIMEOUT_MS = 180_000;

/** git flags for every call on a tree that holds agent output: our config and hooks only. */
const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.symlinks=true'];
const GIT_ID = ['-c', 'user.email=evaluator@itera.local', '-c', 'user.name=itera-evaluator'];

export interface RunEvaluationOptions {
  /** The task bundle (directory with task.json). Or give repoRoot + scenarioId for benchmarks/<id>. */
  taskDir?: string;
  repoRoot?: string;
  scenarioId?: string;
  /** Unified diff text, paths relative to the workspace root (e.g. "src/app.ts"). '' = no change. */
  patch: string;
  /** Where each verifier run executes. Default: local child process (NOT a sandbox). */
  executor?: SuiteExecutor;
  /** Keep the temp workspace after the run instead of deleting it (for debugging). */
  keepWorkspace?: boolean;
  /**
   * ADR-11: final state of the task's MCP servers, already evaluated on the worker (mcp-state.ts).
   * Present only for a task with `expose_state_to_scorer` servers. The `mcp_state` Scorer then
   * weighs MCP_STATE_WEIGHT of the total and the code scorers weigh the rest.
   */
  mcp?: McpServerEvidence[];
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn without a shell, with a scrubbed environment (no DATABASE_URL, no keys reach npm or git). */
function run(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME ?? tmpdir(), TMPDIR: tmpdir(), LANG: 'C.UTF-8' };
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk.toString()).slice(-8000)));
    child.on('error', (err) => (clearTimeout(timer), reject(err)));
    child.on('close', (code) => (clearTimeout(timer), resolve({ code: code ?? 1, stdout, stderr })));
  });
}

const git = (args: string[], cwd: string) => run('git', [...SAFE_GIT, ...args], cwd);

/** npm never runs lifecycle scripts on the trusted side, whatever task.json says. */
export function installCommand(task: LoadedTask): string[] {
  const argv = [...(task.contract.environment.install ?? DEFAULT_INSTALL)];
  if (argv[0] === 'npm' && !argv.includes('--ignore-scripts')) argv.push('--ignore-scripts');
  return argv;
}

/** sha256 of the canonical JSON of a value (object keys sorted). */
export function canonicalDigest(value: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canon(value))).digest('hex');
}

let evaluatorDigestCache: string | null = null;
/** sha256 over the evaluator's own source files (not the tests): which grader code ran. */
export async function evaluatorDigest(): Promise<string> {
  if (evaluatorDigestCache) return evaluatorDigestCache;
  const dir = import.meta.dirname;
  const hash = createHash('sha256');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort();
  for (const f of files) {
    hash.update(f);
    hash.update(await readFile(join(dir, f)));
  }
  evaluatorDigestCache = hash.digest('hex');
  return evaluatorDigestCache;
}

/** The deployment's git commit, when it is known. Never guessed. */
export function evaluatorCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.ITERA_GIT_COMMIT ?? env.SOURCE_COMMIT ?? null;
  return value && /^[0-9a-f]{7,40}$/.test(value) ? value : null;
}

export function limitationsFor(executor: ExecutorInfo, task: LoadedTask): string[] {
  const out = [
    'The verifier runs the patched code in the same process as the tests. A patch can still change the test framework in memory; the evaluator cross-checks the report with the verifier exit code, so a full pass needs exit code 0.',
    'One grading run per agent run; no repetition and no confidence interval.',
  ];
  if (executor.profile === 'local-process') out.unshift('Grading ran as a child process of the evaluator, not in a sandbox container.');
  if (task.contract.task.name.startsWith('itera/')) {
    out.push('The hidden tests of curated tasks are in a public repository: custody by path, not secrecy.');
  }
  return out;
}

/** "/tmp/itera-eval-x/workspace/tests/hidden/a.test.ts" -> "tests/hidden/a.test.ts". */
export function workspaceRelative(file: string, testsDir: string): string {
  const posix = file.split('\\').join('/');
  const idx = posix.lastIndexOf(`/${testsDir}/`);
  if (idx >= 0) return posix.slice(idx + 1);
  if (posix.startsWith(`${testsDir}/`)) return posix;
  return posix.split('/').pop() ?? '';
}

export async function runEvaluation(options: RunEvaluationOptions): Promise<EvalLog> {
  const taskDir = options.taskDir ?? (options.repoRoot && options.scenarioId ? scenarioDir(options.repoRoot, options.scenarioId) : null);
  if (!taskDir) throw new Error('runEvaluation needs taskDir, or repoRoot and scenarioId');
  const task = await loadTask(taskDir);
  const scenarioId = options.scenarioId ?? task.contract.task.name.split('/')[1]!;
  const executor = options.executor ?? localExecutor();
  const verifierImage = task.contract.verifier.image;
  const executorInfo = await executor.describe(verifierImage ? { image: verifierImage } : undefined);
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const verifier = task.contract.verifier;
  const timeoutMs = verifier.timeout_sec * 1000;
  const limits = { cpus: task.contract.environment.cpus, memoryMb: task.contract.environment.memory_mb };

  const workDir = await mkdtemp(join(tmpdir(), 'itera-eval-'));
  const ws = join(workDir, 'workspace');

  const runSuite = async (label: string, testsDir: string): Promise<TestSuiteResult> => {
    const res = await executor.runSuite({ label, workspaceDir: ws, argv: resolveCmd(verifier.cmd, testsDir), timeoutMs, limits, ...(verifierImage ? { image: verifierImage } : {}) });
    const { suite, error } = interpretRun(res, verifier.report);
    if (error) errors.push(`${label}: ${error}`);
    // Reports carry absolute paths of the grading host or container (/tmp/itera-eval-…). The
    // manifest keeps only the workspace-relative path of each test file.
    suite.cases = suite.cases.map((c) => ({ ...c, file: workspaceRelative(c.file, testsDir) }));
    return suite;
  };
  const skipped = (): TestSuiteResult => ({ ...EMPTY_SUITE, cases: [], state: 'skipped' });

  try {
    // The agent-visible workspace: environment/ + public tests. Hashed before any install.
    await materializeWorkspace(task, ws);
    const fixtureHash = await hashDirectory(ws);

    // Dependencies come from the lockfile, on the trusted side; lifecycle scripts never run.
    const installCmd = installCommand(task);
    const install = await run(installCmd[0]!, installCmd.slice(1), ws, INSTALL_TIMEOUT_MS);
    if (install.code !== 0) errors.push(`install failed: ${install.stderr.slice(0, 500)}`);

    await writeFile(join(ws, '.gitignore'), 'node_modules/\n', 'utf-8');
    await git(['init', '-q'], ws);
    await git(['add', '-A'], ws);
    await git([...GIT_ID, 'commit', '-q', '-m', 'baseline'], ws);

    const publicBaseline = await runSuite('public-baseline', task.contract.tests.public);
    const baselinePassingNames = new Set(publicBaseline.cases.filter((c) => c.passed).map((c) => c.name));

    // Freeze the patch. It is applied HERE, on the trusted side, with git: the scope verdict never
    // depends on anything that ran inside a grading container.
    const patchHash = createHash('sha256').update(options.patch).digest('hex');
    const patchFile = join(workDir, 'patch.diff');
    await writeFile(patchFile, options.patch, 'utf-8');
    const emptyPatch = options.patch.trim() === '';

    // --index stages the patch as part of applying it (including files it creates), so a new file
    // under tests/ shows up in `git diff --cached`. --no-renames lists BOTH sides of a rename: a
    // rename out of tests/ must count as a change to tests/.
    const apply = emptyPatch ? { code: 0, stdout: '', stderr: '' } : await git(['apply', '--whitespace=nowarn', '--index', patchFile], ws);
    if (apply.code !== 0) errors.push(`patch did not apply: ${apply.stderr.slice(0, 500)}`);

    const nameOnly = await git(['diff', '--cached', '--no-renames', '--name-only'], ws);
    const changedFiles = nameOnly.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const raw = await git(['diff', '--cached', '--no-renames', '--raw'], ws);
    const symlinks = raw.stdout
      .split('\n')
      .map((l) => l.match(/^:\d{6} (\d{6}) \S+ \S+ \S+\t(.+)$/))
      .filter((m): m is RegExpMatchArray => !!m && m[1] === '120000')
      .map((m) => m[2]!);
    const patchScope = checkPatchScope(changedFiles, task.scope, symlinks);

    const publicAfterPatch = apply.code === 0 ? await runSuite('public-after-patch', task.contract.tests.public) : skipped();

    const regressionCandidates = publicAfterPatch.cases.filter((c) => baselinePassingNames.has(c.name));
    const regressionRatio =
      baselinePassingNames.size === 0 ? 1 : regressionCandidates.filter((c) => c.passed).length / baselinePassingNames.size;

    // Mount the hidden tests only now that the patch is frozen.
    let hidden: TestSuiteResult = skipped();
    if (apply.code === 0) {
      // Undo anything the previous verifier run wrote into the tree (it matters for the local
      // executor, which runs in place; the sandbox executor never writes back to this directory).
      await git(['checkout', '--', '.'], ws);
      await git(['clean', '-fdq'], ws);
      await rm(join(ws, task.contract.tests.hidden), { recursive: true, force: true });
      await addTests(task, ws, 'hidden');
      hidden = await runSuite('hidden', task.contract.tests.hidden);
    }

    const mcpEvidence = options.mcp && options.mcp.length > 0 ? options.mcp : null;
    const mcpScore = mcpEvidence ? mcpStateScore(mcpEvidence) : null;
    if (mcpScore && mcpScore.value === null) errors.push(`mcp_state: ${mcpScore.explanation}`);

    const scoreInputs = {
      publicAfterPatch,
      hidden,
      regressionRatio,
      patchScopeAllowed: patchScope.allowed,
      runCompletedWithoutErrors: errors.length === 0,
    };
    const codeScore = computeScore(scoreInputs);
    const scores: Record<string, Score> = runScorers(scoreInputs);
    // With MCP state: the code scorers keep their own points (diagnostics) and the total becomes
    // (100 − MCP_STATE_WEIGHT) % of the code total + the mcp_state points. A scope violation is still 0.
    const score =
      mcpScore === null
        ? codeScore
        : {
            ...codeScore,
            mcp_state: mcpScore.value ?? 0,
            total: patchScope.allowed ? Math.round((codeScore.total * (100 - MCP_STATE_WEIGHT)) / 100) + (mcpScore.value ?? 0) : 0,
          };
    if (mcpScore) scores.mcp_state = mcpScore;
    const scorerNames = [...SCORERS.map((x) => x.name), ...(mcpScore ? ['mcp_state'] : [])];

    const lock = await readFile(join(task.paths.environment, 'package-lock.json')).catch(() => null);
    const environment = {
      executor: executorInfo,
      install_cmd: installCmd,
      lockfile_sha256: lock ? createHash('sha256').update(lock).digest('hex') : null,
    };

    const environmentDigest = canonicalDigest(environment);
    const evaluator = { version: EVALUATOR_VERSION, digest: await evaluatorDigest(), commit: evaluatorCommit() };
    const instruction = await readFile(task.paths.instruction).catch(() => Buffer.from(''));
    const completedAt = new Date().toISOString();

    return {
      schema_version: '0.3.0',
      evaluator_version: EVALUATOR_VERSION,
      scenario_id: scenarioId,
      generated_at: completedAt,
      fixture_hash: fixtureHash,
      patch_hash: patchHash,
      patch_scope: { changed_files: changedFiles, ...patchScope },
      tests: {
        public_baseline: publicBaseline,
        public_after_patch: publicAfterPatch,
        hidden,
      },
      score,
      errors,
      ...(mcpEvidence ? { mcp: { weight: MCP_STATE_WEIGHT, servers: mcpEvidence } } : {}),
      contract: {
        schema_version: task.contract.schema_version,
        name: task.contract.task.name,
        version: task.contract.task.version,
        contract_digest: task.contractDigest,
        verifier_cmd: verifier.cmd,
      },
      environment,
      environment_digest: environmentDigest,
      evaluator_commit: evaluator.commit,
      evaluator_digest: evaluator.digest,
      executor: { profile: executorInfo.profile },
      limitations: limitationsFor(executorInfo, task),
      // Inspect AI EvalLog blocks (names from inspect_ai/log/_log.py; our run = one Sample).
      version: 2,
      status: errors.length === 0 ? 'success' : 'error',
      eval: {
        task: task.contract.task.name,
        task_version: task.contract.task.version,
        task_digest: task.contractDigest,
        created: startedAt,
        dataset: { name: task.contract.task.name, samples: 1 },
        scorers: scorerNames,
        evaluator,
        environment_digest: environmentDigest,
      },
      plan: {
        name: 'testmyagent',
        steps: [
          { solver: 'install', params: { cmd: installCmd } },
          { solver: 'agent', params: {} },
          ...(mcpEvidence ? [{ solver: 'mcp_state', params: { servers: mcpEvidence.map((m) => m.server) } }] : []),
          { solver: 'verifier', params: { cmd: verifier.cmd, suites: ['public-baseline', 'public-after-patch', 'hidden'] } },
        ],
      },
      results: {
        total_samples: 1,
        completed_samples: errors.length === 0 ? 1 : 0,
        scores: scorerNames.map((n) => ({ name: n, scorer: n, metrics: { value: { name: 'value' as const, value: scores[n]!.value } } })),
      },
      stats: { started_at: startedAt, completed_at: completedAt },
      samples: [
        {
          id: task.contract.task.name,
          epoch: 1,
          input: createHash('sha256').update(instruction).digest('hex'),
          target: `${task.contract.tests.hidden} pass`,
          scores,
          metadata: { patch_hash: patchHash, fixture_hash: fixtureHash },
        },
      ],
    };
  } finally {
    if (!options.keepWorkspace) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

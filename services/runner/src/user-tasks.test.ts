// U19: user tasks read from GitHub at a pinned commit. A fake reader serves a local task bundle
// (the escape-probe test task) as if it were a repo tree.
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listFiles, loadTask, taskDigests } from '../../evaluator/src/task.js';
import type { ValidationResult } from '../../evaluator/src/validate.js';
import { FakeJobStore } from './jobs.fake.js';
import { defaultSandboxConfig } from './sandbox.js';
import { fetchTaskFolder, GitHubReadError, TaskSourceError, type TaskPin, type TaskRepoReader } from './task-source.js';
import type { ClaimedValidation, UserTaskPin, UserTaskStore, ValidationOutcome } from './user-tasks.js';
import { CLAIM_VALIDATION_SQL } from './user-tasks.pg.js';
import { processRun, processValidation, workerLoop, type WorkerDeps } from './worker.js';
import { prepareWorkspace } from './workspace.js';

const TASK = resolve(import.meta.dirname, '..', 'test-tasks', 'escape-probe');
const SHA = 'c'.repeat(40);
const VERSION_ID = '0b6f1c2e-0000-4000-8000-000000000001';
const PACK = `user-${VERSION_ID}`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A repo whose tree is `tasks/probe/<every file of the local bundle>` plus extra entries. */
class LocalReader implements TaskRepoReader {
  calls = 0;
  constructor(
    private readonly bundle: string,
    private readonly extra: Array<{ path: string; type: 'blob' | 'tree' | 'commit'; mode: string; sha: string }> = [],
    private readonly fail = false,
  ) {}
  async listTree(_pin: TaskPin) {
    this.calls += 1;
    if (this.fail) throw new GitHubReadError('GitHub GET /repos/x/y/git/trees -> 502');
    const files = await listFiles(this.bundle, (n) => n === 'node_modules');
    return {
      truncated: false,
      entries: [
        { path: 'README.md', type: 'blob' as const, mode: '100644', sha: 'readme' },
        ...files.map((f) => ({ path: `tasks/probe/${f}`, type: 'blob' as const, mode: '100644', sha: f })),
        ...this.extra,
      ],
    };
  }
  async readBlob(_pin: TaskPin, sha: string) {
    return readFile(join(this.bundle, sha));
  }
}

const pin: TaskPin = { installationId: 7, repoFullName: 'alice/tasks', commitSha: SHA, repoPath: 'tasks/probe' };

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  }
  await walk(dir);
  return out;
}

describe('fetchTaskFolder', () => {
  it('writes the task folder at the pinned commit, and nothing outside it', async () => {
    const dest = join(await tmp('itera-task-'), 'task');
    const out = await fetchTaskFolder(new LocalReader(TASK), pin, dest);
    expect(out.files).toBeGreaterThan(5);
    expect(await filesUnder(dest)).toContain('tests/hidden/escape.test.ts');
    expect(await filesUnder(dest)).not.toContain('README.md');
    const loaded = await loadTask(dest);
    expect(loaded.contract.task.name).toBe('itera-test/escape-probe');
  });

  it('refuses symlinks, submodules, a missing task.json and a bad pin', async () => {
    const dest = join(await tmp('itera-task-'), 'task');
    const link = { path: 'tasks/probe/environment/src/link.ts', type: 'blob' as const, mode: '120000', sha: 'x' };
    await expect(fetchTaskFolder(new LocalReader(TASK, [link]), pin, dest)).rejects.toThrow(TaskSourceError);
    const sub = { path: 'tasks/probe/vendor', type: 'commit' as const, mode: '160000', sha: 'x' };
    await expect(fetchTaskFolder(new LocalReader(TASK, [sub]), pin, dest)).rejects.toThrow(/submodules/);
    await expect(fetchTaskFolder(new LocalReader(TASK), { ...pin, repoPath: 'nope' }, dest)).rejects.toThrow(/no task.json/);
    await expect(fetchTaskFolder(new LocalReader(TASK), { ...pin, commitSha: 'main' }, dest)).rejects.toThrow(/full SHA/);
  });
});

describe('hidden tests of a user task never reach the agent workspace', () => {
  it('the workspace built from a fetched user task holds no hidden-test file and no hidden-test bytes', async () => {
    const root = await tmp('itera-task-');
    const taskDir = join(root, 'task');
    await fetchTaskFolder(new LocalReader(TASK), pin, taskDir);
    const agentDir = await tmp('itera-agent-');
    await writeFile(join(agentDir, 'AGENTS.md'), '# agent\n');
    const ws = await prepareWorkspace({ repoRoot: '/nonexistent', scenarioId: PACK, taskDir, agentDir, installDeps: false });
    cleanups.push(ws.cleanup);

    const hiddenFiles = await listFiles(join(taskDir, 'tests', 'hidden'));
    const hiddenBytes = await Promise.all(hiddenFiles.map((f) => readFile(join(taskDir, 'tests', 'hidden', f))));
    const files = (await filesUnder(ws.dir)).filter((f) => !f.startsWith('.git/'));
    expect(files).toContain('tests/public/public.test.ts');
    expect(files.some((f) => f.startsWith('tests/hidden'))).toBe(false);
    expect(files.some((f) => f.startsWith('solution'))).toBe(false);
    for (const f of files) {
      const bytes = await readFile(join(ws.dir, f));
      for (const h of hiddenBytes) expect(bytes.includes(h)).toBe(false);
    }
    // The git baseline does not hold them either (every object is checked by content hash).
    const hiddenBlobIds = hiddenBytes.map((b) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'));
    const objects = await filesUnder(join(ws.dir, '.git', 'objects')).catch(() => []);
    for (const id of hiddenBlobIds) expect(objects).not.toContain(`${id.slice(0, 2)}/${id.slice(2)}`);
  });
});

function gate(status: 'ready' | 'invalid'): ValidationResult {
  const ok = status === 'ready';
  return {
    status,
    checks: {
      contract: { ok: true, detail: 'x@1' },
      baseline_hidden_fails: { ok, detail: ok ? 'FAIL as expected' : 'all 3 hidden cases already pass on the baseline', hidden_total: 3, hidden_failed: ok ? 3 : 0 },
      solution_passes: { ok: true, detail: '', public: '1/1', hidden: '3/3', scope_allowed: true },
      repeatable: { ok: true, detail: '3 / 3 same result', runs: 3, identical: true },
      verifier_time: { ok: true, detail: '2 s', max_ms: 2000, budget_ms: 60000 },
    },
    digests: { environment: 'e', hidden_tests: 'h', solution: 's', contract: 'c', public_tests: 'p' },
    environment_digest: 'x',
    duration_ms: 10,
  };
}

class FakeUserTasks implements UserTaskStore {
  queue: ClaimedValidation[] = [];
  finished: Array<{ id: string; outcome: ValidationOutcome }> = [];
  pins = new Map<string, UserTaskPin>();
  async claimValidation() {
    return this.queue.shift() ?? null;
  }
  async finishValidation(id: string, _w: string, outcome: ValidationOutcome) {
    this.finished.push({ id, outcome });
  }
  async reapStaleValidations() {
    return 0;
  }
  async pinOfPack(packId: string) {
    return this.pins.get(packId) ?? null;
  }
}

function deps(over: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    store: new FakeJobStore(),
    workerId: 'w1',
    repoRoot: '/repo',
    platformModelKey: 'sk-platform',
    config: defaultSandboxConfig({}),
    runAgent: async () => {
      throw new Error('not used');
    },
    grade: async () => {
      throw new Error('not used');
    },
    ...over,
  };
}

const claimed: ClaimedValidation = { id: 'val-1', taskId: 't1', taskVersionId: VERSION_ID, repeats: 3, pin };

describe('processValidation', () => {
  it('fetches the folder at the pinned commit, runs the gate with 3 repeats, records ready', async () => {
    const userTasks = new FakeUserTasks();
    const seen: { repeats?: number; hasTaskJson?: boolean } = {};
    const out = await processValidation(
      deps({
        userTasks,
        taskReader: new LocalReader(TASK),
        validate: async (o) => {
          seen.repeats = o.repeats;
          seen.hasTaskJson = (await stat(join(o.taskDir, 'task.json')).catch(() => null)) !== null;
          return gate('ready');
        },
      }),
      claimed,
    );
    expect(out.status).toBe('ready');
    expect(seen).toEqual({ repeats: 3, hasTaskJson: true });
    expect(userTasks.finished).toEqual([{ id: 'val-1', outcome: out }]);
  });

  it('a task whose hidden tests pass on the baseline is invalid, with the reason', async () => {
    const userTasks = new FakeUserTasks();
    const out = await processValidation(deps({ userTasks, taskReader: new LocalReader(TASK), validate: async () => gate('invalid') }), claimed);
    expect(out.status).toBe('invalid');
    expect(out.result!.checks.baseline_hidden_fails.detail).toMatch(/already pass on the baseline/);
  });

  it('an unacceptable folder is invalid without running the gate; GitHub down or no App key is a platform error', async () => {
    const userTasks = new FakeUserTasks();
    let gateRuns = 0;
    const validate = async () => (gateRuns++, gate('ready'));
    const link = { path: 'tasks/probe/x', type: 'blob' as const, mode: '120000', sha: 'x' };
    const bad = await processValidation(deps({ userTasks, taskReader: new LocalReader(TASK, [link]), validate }), claimed);
    expect(bad.status).toBe('invalid');
    expect(bad.result!.checks.contract.detail).toMatch(/symbolic links/);
    const down = await processValidation(deps({ userTasks, taskReader: new LocalReader(TASK, [], true), validate }), claimed);
    expect(down).toMatchObject({ status: 'error', result: null });
    const noKey = await processValidation(deps({ userTasks, taskReader: null, validate }), claimed);
    expect(noKey.error).toMatch(/GITHUB_APP_ID/);
    expect(gateRuns).toBe(0);
  });
});

describe('processRun on a user task', () => {
  async function setupRun(pinOver: Partial<UserTaskPin> = {}) {
    const store = new FakeJobStore();
    store.enqueue(
      { runId: 'run-u', scenarioId: PACK, scenarioVersion: '1', agentVersionId: 'av-1' },
      { runId: 'run-u', scenarioId: PACK, scenarioVersion: '1', agentVersionId: 'av-1', model: 'qwen/qwen3-coder', modelApiKeyEnc: null, files: [{ path: 'AGENTS.md', content: '# agent' }] },
    );
    const digests = await taskDigests(await loadTask(TASK));
    const userTasks = new FakeUserTasks();
    userTasks.pins.set(PACK, { ...pin, taskVersionId: VERSION_ID, fixtureDigest: digests.environment, hiddenDigest: digests.hidden_tests, ...pinOver });
    const seen: { agentTaskDir?: string; gradeTaskDir?: string } = {};
    const d = deps({
      store,
      userTasks,
      taskReader: new LocalReader(TASK),
      runAgent: async (o) => {
        seen.agentTaskDir = o.taskDir;
        expect(await stat(join(o.taskDir!, 'task.json'))).toBeTruthy();
        throw new Error('stop after the agent step');
      },
    });
    return { store, d, seen };
  }

  it('reads the task at the pinned commit for the run and gives its dir to the agent step', async () => {
    const { store, d, seen } = await setupRun();
    const out = await processRun(d, (await store.claim('w1'))!);
    expect(seen.agentTaskDir).toMatch(/itera-task-/);
    expect(out.error).toMatch(/stop after the agent step/);
    // The per-run copy is removed when the run ends (no copy at rest).
    expect(await stat(seen.agentTaskDir!).catch(() => null)).toBeNull();
  });

  it('refuses a task whose bytes differ from the validated digests', async () => {
    const { store, d, seen } = await setupRun({ hiddenDigest: 'f'.repeat(64) });
    const out = await processRun(d, (await store.claim('w1'))!);
    expect(out.status).toBe('infra_error');
    expect(out.error).toMatch(/differs from the validated digests/);
    expect(seen.agentTaskDir).toBeUndefined();
  });

  it('an unknown or unvalidated user pack never starts the agent', async () => {
    const { store, d, seen } = await setupRun();
    (d.userTasks as FakeUserTasks).pins.clear();
    const out = await processRun(d, (await store.claim('w1'))!);
    expect(out.error).toMatch(/did not pass the validation gate/);
    expect(seen.agentTaskDir).toBeUndefined();
  });
});

describe('workerLoop', () => {
  it('claims a validation when no run is queued', async () => {
    const userTasks = new FakeUserTasks();
    userTasks.queue.push(claimed);
    const controller = new AbortController();
    const d = deps({
      userTasks,
      taskReader: new LocalReader(TASK),
      validate: async () => {
        controller.abort();
        return gate('ready');
      },
    });
    await workerLoop(d, { concurrency: 1, pollMs: 5, staleMs: 60_000, signal: controller.signal, drainMs: 5_000 });
    expect(userTasks.finished.map((f) => f.outcome.status)).toEqual(['ready']);
  });

  it('the claim SQL skips locked rows and takes the oldest queued validation', () => {
    expect(CLAIM_VALIDATION_SQL).toMatch(/for update skip locked/);
    expect(CLAIM_VALIDATION_SQL).toMatch(/where status = 'queued'/);
  });
});

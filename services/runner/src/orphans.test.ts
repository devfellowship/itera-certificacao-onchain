import { describe, expect, it } from 'vitest';
import { FakeJobStore } from './jobs.fake.js';
import { LOST_RUN_REQUEUED } from './jobs.js';
import { isOrphan, recoverLostRuns, removeOrphans, runIdFromName, workerHost, type DockerFn } from './orphans.js';
import { defaultSandboxConfig } from './sandbox.js';
import { workerLoop, type WorkerDeps } from './worker.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function fakeDocker(state: { containers: string[]; networks: string[]; liveHosts: string[] }) {
  const calls: string[][] = [];
  const docker: DockerFn = async (args) => {
    calls.push(args);
    if (args[0] === 'inspect') return { code: 0, stdout: state.liveHosts.includes(args.at(-1)!) ? 'true\n' : 'false\n', stderr: '' };
    if (args[0] === 'ps') {
      const role = args.find((a) => a.startsWith('label='))!;
      const names = state.containers.filter((n) =>
        role.endsWith('model-gateway') ? n.startsWith('itera-gw-') : role.endsWith('mcp-sidecar') ? n.startsWith('itera-mcp-') : !n.startsWith('itera-gw-') && !n.startsWith('itera-mcp-'),
      );
      return { code: 0, stdout: names.map((n) => `id-${n} ${n}`).join('\n'), stderr: '' };
    }
    if (args[0] === 'network' && args[1] === 'ls') return { code: 0, stdout: state.networks.map((n) => `nid-${n} ${n}`).join('\n'), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { docker, calls };
}

function storeWith(runs: Array<{ id: string; status: string; workerId: string | null; error?: string | null }>) {
  const store = new FakeJobStore();
  for (const r of runs) {
    store.enqueue({ runId: r.id, scenarioId: 'webhook-ledger', scenarioVersion: '1', agentVersionId: 'av' }, null);
    Object.assign(store.runs.get(r.id)!, { status: r.status, workerId: r.workerId, error: r.error ?? null });
  }
  return store;
}

describe('names', () => {
  it('reads the run id from every sandbox name and the host from a worker id', () => {
    expect(runIdFromName(`itera-run-${A}`)).toBe(A);
    expect(runIdFromName(`itera-gw-${A}`)).toBe(A);
    expect(runIdFromName(`itera-sbx-${A}`)).toBe(A);
    expect(runIdFromName(`itera-grade-${A}-hidden`)).toBe(A);
    expect(runIdFromName('itera-run-old')).toBeNull();
    expect(workerHost('itera-runner@3f2a9c1b0d4e')).toBe('3f2a9c1b0d4e');
    expect(workerHost(null)).toBeNull();
  });

  it('orphan iff the run is not running or its worker is not live', () => {
    expect(isOrphan({ status: 'running', workerId: 'w@x' }, true)).toBe(false);
    expect(isOrphan({ status: 'running', workerId: 'w@x' }, false)).toBe(true);
    expect(isOrphan({ status: 'pass', workerId: 'w@x' }, true)).toBe(true);
    expect(isOrphan(undefined, true)).toBe(true);
  });
});

describe('removeOrphans (rolling redeploy)', () => {
  it('keeps the sandbox of a live worker, removes those of a dead worker and of a finished run', async () => {
    const store = storeWith([
      { id: A, status: 'running', workerId: 'itera-runner@oldhost' }, // old worker, still draining
      { id: B, status: 'running', workerId: 'itera-runner@deadhost' },
      { id: C, status: 'pass', workerId: 'itera-runner@oldhost' },
    ]);
    const { docker, calls } = fakeDocker({
      containers: [`itera-run-${A}`, `itera-gw-${A}`, `itera-run-${B}`, `itera-grade-${C}-hidden`],
      networks: [`itera-sbx-${A}`, `itera-sbx-${B}`],
      liveHosts: ['oldhost'],
    });
    const res = await removeOrphans({ docker, store, selfHost: 'newhost' });
    expect(res).toEqual({ removed: 2, kept: 2 });
    const rm = calls.find((c) => c[0] === 'rm')!;
    expect(rm).toEqual(['rm', '-fv', `id-itera-run-${B}`, `id-itera-grade-${C}-hidden`]);
    const netRm = calls.filter((c) => c[0] === 'network' && c[1] === 'rm').map((c) => c[2]);
    expect(netRm).toEqual([`nid-itera-sbx-${B}`]);
  });
});

describe('recoverLostRuns', () => {
  it('requeues a run of a dead worker once, then fails it on the second loss; never touches a live worker', async () => {
    const store = storeWith([
      { id: A, status: 'running', workerId: 'itera-runner@oldhost' },
      { id: B, status: 'running', workerId: 'itera-runner@deadhost' },
    ]);
    const { docker } = fakeDocker({ containers: [], networks: [], liveHosts: ['oldhost'] });
    expect(await recoverLostRuns({ docker, store, selfHost: 'newhost' })).toEqual({ requeued: 1, failed: 0, keptLive: 1 });
    expect(store.runs.get(A)!.status).toBe('running');
    expect(store.runs.get(B)!).toMatchObject({ status: 'queued', workerId: null, claimedAt: null, error: LOST_RUN_REQUEUED });

    // Claimed again by a worker that then dies too: the second loss is final.
    await store.claim('itera-runner@deadhost2');
    expect(await recoverLostRuns({ docker, store, selfHost: 'newhost' })).toEqual({ requeued: 0, failed: 1, keptLive: 1 });
    expect(store.runs.get(B)!.status).toBe('infra_error');
  });
});

describe('workerLoop drain', () => {
  function deps(store: FakeJobStore, agentMs: number): WorkerDeps {
    return {
      store,
      workerId: 'w1',
      repoRoot: '/repo',
      platformModelKey: 'sk-or-v1-itera',
      config: defaultSandboxConfig({}),
      runAgent: () => new Promise((r) => setTimeout(() => r(null as never), agentMs)),
      grade: async () => {
        throw new Error('not reached');
      },
    } as WorkerDeps;
  }

  it('stops claiming on abort and returns after drainMs when a run is still in flight', async () => {
    const store = new FakeJobStore();
    store.enqueue({ runId: A, scenarioId: 'webhook-ledger', scenarioVersion: '1', agentVersionId: 'av' }, {
      runId: A, scenarioId: 'webhook-ledger', scenarioVersion: '1', agentVersionId: 'av',
      model: 'm', modelApiKeyEnc: null, files: [{ path: 'AGENTS.md', content: '# a' }],
    });
    const controller = new AbortController();
    const started = Date.now();
    const loop = workerLoop(deps(store, 5_000), { concurrency: 1, pollMs: 5, staleMs: 60_000, drainMs: 100, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 50));
    store.enqueue({ runId: B, scenarioId: 'webhook-ledger', scenarioVersion: '1', agentVersionId: 'av' }, null);
    controller.abort();
    await loop;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(store.runs.get(A)!.status).toBe('running'); // left for the next worker to requeue
    expect(store.runs.get(B)!.status).toBe('queued'); // never claimed after the abort
  });
});

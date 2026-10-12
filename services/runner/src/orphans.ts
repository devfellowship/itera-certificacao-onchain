// Start-up recovery that is safe during a rolling redeploy. Two workers can be alive at the same
// time (the old one draining, the new one booting). The new worker must not remove the sandbox of
// a run that the old one is still executing, and must not fail that run.
//
// - A worker is live iff its host (the part of worker_id after "@", the worker container's short id
//   inside Docker) is a running container, or is this worker itself.
// - A sandbox container / network is an orphan iff its run is not `running`, or its run's worker is
//   not live. Names carry the run id: itera-run-<id>, itera-gw-<id>, itera-sbx-<id>, itera-grade-<id>[-label].
// - A run that is `running` under a dead worker is requeued ONCE as a free retry; a second loss is
//   infra_error, as before.
import type { JobStore } from './jobs.js';

export type DockerFn = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const NAME_RE = /^\/?itera-(?:run|gw|sbx|grade)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-.*)?$/;

export function runIdFromName(name: string): string | null {
  return name.trim().match(NAME_RE)?.[1] ?? null;
}

export function workerHost(workerId: string | null): string | null {
  if (!workerId) return null;
  const at = workerId.lastIndexOf('@');
  const host = at >= 0 ? workerId.slice(at + 1) : '';
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(host) ? host : null;
}

/** Memoised liveness check of worker hosts through the Docker API. */
export function livenessChecker(docker: DockerFn, selfHost: string): (host: string | null) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (host) => {
    if (!host) return Promise.resolve(false);
    if (host === selfHost) return Promise.resolve(true);
    let hit = cache.get(host);
    if (!hit) {
      hit = docker(['inspect', '-f', '{{.State.Running}}', host]).then((r) => r.code === 0 && r.stdout.trim() === 'true').catch(() => false);
      cache.set(host, hit);
    }
    return hit;
  };
}

export function isOrphan(run: { status: string; workerId: string | null } | undefined, workerLive: boolean): boolean {
  if (!run) return true;
  if (run.status !== 'running') return true;
  return !workerLive;
}

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

/** Remove orphan sandbox containers and run networks. Returns the number of containers removed. */
export async function removeOrphans(deps: { docker: DockerFn; store: Pick<JobStore, 'runStates'>; selfHost: string }): Promise<{ removed: number; kept: number }> {
  const { docker, store } = deps;
  const live = livenessChecker(docker, deps.selfHost);
  const containers: Array<{ id: string; name: string }> = [];
  for (const role of ['agent-sandbox', 'model-gateway']) {
    const ps = await docker(['ps', '-a', '--filter', `label=itera.role=${role}`, '--format', '{{.ID}} {{.Names}}']);
    for (const l of lines(ps.stdout)) {
      const [id, name] = l.split(/\s+/);
      if (id && name) containers.push({ id, name });
    }
  }
  const netLs = await docker(['network', 'ls', '--filter', 'label=itera.role=sandbox-net', '--format', '{{.ID}} {{.Name}}']);
  const networks = lines(netLs.stdout).map((l) => {
    const [id, name] = l.split(/\s+/);
    return { id: id ?? '', name: name ?? '' };
  });

  const runIds = [...new Set([...containers, ...networks].map((c) => runIdFromName(c.name)).filter((x): x is string => !!x))];
  const states = runIds.length > 0 ? await store.runStates(runIds) : new Map();
  const orphan = async (name: string) => {
    const runId = runIdFromName(name);
    if (!runId) return true; // not ours by name: a leftover of an older naming scheme
    const run = states.get(runId);
    return isOrphan(run, run ? await live(workerHost(run.workerId)) : false);
  };

  const remove: string[] = [];
  let kept = 0;
  for (const c of containers) {
    if (await orphan(c.name)) remove.push(c.id);
    else kept++;
  }
  // -v: grader containers carry anonymous volumes.
  if (remove.length > 0) await docker(['rm', '-fv', ...remove]);
  for (const n of networks) {
    if (!(await orphan(n.name))) continue;
    const inspect = await docker(['network', 'inspect', '-f', '{{range $k, $v := .Containers}}{{$v.Name}} {{end}}', n.id]);
    for (const name of inspect.stdout.split(' ').map((s) => s.trim()).filter(Boolean)) {
      await docker(['network', 'disconnect', '-f', n.id, name]);
    }
    await docker(['network', 'rm', n.id]);
  }
  return { removed: remove.length, kept };
}

/** Runs left `running` by a dead worker: requeue once (free retry), else infra_error. */
export async function recoverLostRuns(deps: {
  docker: DockerFn;
  store: Pick<JobStore, 'runningRuns' | 'recoverLost'>;
  selfHost: string;
}): Promise<{ requeued: number; failed: number; keptLive: number }> {
  const live = livenessChecker(deps.docker, deps.selfHost);
  const out = { requeued: 0, failed: 0, keptLive: 0 };
  for (const run of await deps.store.runningRuns()) {
    if (await live(workerHost(run.workerId))) {
      out.keptLive++;
      continue;
    }
    const r = await deps.store.recoverLost(run.runId, run.workerId);
    if (r === 'requeued') out.requeued++;
    else if (r === 'failed') out.failed++;
  }
  return out;
}

// Container cleanup when the local runner stops early (plan 20261026-tma-local-runner-and-self-declared-results,
// task L10, safety bar: "cleanup of containers on exit").
//
// A normal end, or an error, already removes every container and network of a run: runSandbox and the
// grader executor remove them in a `finally`. A signal (Ctrl-C, `docker stop` of the launcher container,
// `kill`) ends the Node process before any `finally` runs. So the CLI keeps the ids of its own runs, and
// on SIGINT / SIGTERM / SIGHUP it removes the containers and networks whose names carry one of THESE ids
// (itera-run-<id>, itera-gw-<id>, itera-grade-<id>-*, itera-mcp-<id>-*, network itera-sbx-<id>).
// It never touches a container of another process: the match is on this process's ids only.
import { exec } from '../exec.js';

export type DockerFn = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const active = new Set<string>();

/** The docker name part of a run id, as runSandbox and the grader executor derive it. */
export function nameId(runId: string): string {
  return runId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
}

/** Record a run id of this process. Its containers are removed if the process gets a signal. */
export function trackRun(runId: string): void {
  active.add(nameId(runId));
}

/** Forget a run id (its own `finally` removed its containers). */
export function untrackRun(runId: string): void {
  active.delete(nameId(runId));
}

export function trackedRuns(): string[] {
  return [...active];
}

const NAME_PREFIXES = ['itera-run-', 'itera-gw-', 'itera-grade-', 'itera-mcp-'];

/** True when the container name belongs to the run `id` (exact id, then the end of the name or a `-`). */
export function belongsTo(name: string, id: string): boolean {
  const n = name.replace(/^\//, '');
  return NAME_PREFIXES.some((p) => n === `${p}${id}` || n.startsWith(`${p}${id}-`));
}

/**
 * Remove the containers (with their anonymous volumes) and the networks of the given run ids.
 * Returns the names that it removed. Docker errors are ignored: cleanup is best effort.
 */
export async function removeRunContainers(ids: string[], docker: DockerFn = (args) => exec('docker', args, { timeoutMs: 30_000 })): Promise<string[]> {
  if (ids.length === 0) return [];
  const removed: string[] = [];
  const ps = await docker(['ps', '-a', '--format', '{{.Names}}', ...ids.flatMap((id) => ['--filter', `name=${id}`])]);
  const names = ps.code === 0 ? ps.stdout.split('\n').map((s) => s.trim()).filter((n) => ids.some((id) => belongsTo(n, id))) : [];
  if (names.length > 0) {
    const rm = await docker(['rm', '-f', '-v', ...names]);
    if (rm.code === 0) removed.push(...names);
  }
  for (const id of ids) {
    const net = `itera-sbx-${id}`;
    const r = await docker(['network', 'rm', net]);
    if (r.code === 0) removed.push(net);
  }
  return removed;
}

let installed = false;
let stopping = false;

/**
 * The normal exit path of the CLI waits here. After a signal it never resolves: the signal handler
 * exits once both cleanup passes are done, with the signal's exit code.
 */
export function exitAllowed(): Promise<void> {
  return stopping ? new Promise<void>(() => undefined) : Promise.resolve();
}
/** The wait before the second cleanup pass. */
export const SECOND_PASS_MS = 2_000;

/**
 * Install the signal handlers once. On a signal: remove the tracked runs' containers, print what was
 * removed, and exit with 128 + the signal number (130 for SIGINT, 143 for SIGTERM).
 */
export function installSignalCleanup(log: (line: string) => void = (l) => process.stderr.write(`${l}\n`), docker?: DockerFn): void {
  if (installed) return;
  installed = true;
  const codes: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  for (const sig of Object.keys(codes) as NodeJS.Signals[]) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      const ids = trackedRuns();
      log(`[tma] ${sig}: removing the containers of ${ids.length} run(s) of this process`);
      // Two passes: a `docker create` that was in flight when the signal came lands after the first pass.
      const pass = () => removeRunContainers(ids, docker).catch(() => [] as string[]);
      pass()
        .then(async (first) => {
          await new Promise((r) => setTimeout(r, SECOND_PASS_MS));
          return [...first, ...(await pass())];
        })
        .then((names) => log(`[tma] removed: ${names.length ? [...new Set(names)].join(' ') : 'nothing'}`))
        .finally(() => process.exit(codes[sig]));
    });
  }
}

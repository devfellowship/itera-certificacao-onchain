/**
 * Runner heartbeat (T12). The worker upserts one row in `runner_heartbeats` (0020) every
 * HEARTBEAT_INTERVAL_MS, so GET /health of the API can report `runnerSeenAt`.
 *
 * Rules:
 *  - A failed write is logged and never throws out of the loop. The worker keeps working.
 *  - A missing table (Postgres 42P01) is logged once. The loop keeps running, so the first
 *    heartbeat after the migration lands without a restart.
 *  - The loop does not keep the process alive (`unref`) and stops on `stop()`.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface HeartbeatDb {
  query(text: string, values: unknown[]): Promise<unknown>;
}

export interface HeartbeatOptions {
  db: HeartbeatDb;
  runnerId: string;
  version: string | null;
  concurrency: number;
  intervalMs?: number;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => Date;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export const UPSERT_HEARTBEAT = `insert into runner_heartbeats (runner_id, seen_at, version, concurrency)
values ($1, $2, $3, $4)
on conflict (runner_id) do update set seen_at = excluded.seen_at, version = excluded.version, concurrency = excluded.concurrency`;

export function heartbeatIntervalMs(envValue: string | undefined): number {
  const n = Number(envValue);
  return Number.isFinite(n) && n >= 1000 ? n : HEARTBEAT_INTERVAL_MS;
}

/** One upsert. Returns true when the row was written. Never throws. */
export async function beatOnce(opts: HeartbeatOptions, state: { missingTableLogged: boolean }): Promise<boolean> {
  const log = opts.log ?? (() => {});
  try {
    await opts.db.query(UPSERT_HEARTBEAT, [opts.runnerId, (opts.now ?? (() => new Date()))(), opts.version, opts.concurrency]);
    return true;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '42P01') {
      if (!state.missingTableLogged) {
        state.missingTableLogged = true;
        log({ event: 'heartbeat_table_missing', hint: 'apply db/migrations/0020_runner_heartbeats.sql; the worker keeps running' });
      }
    } else {
      log({ event: 'heartbeat_failed', error: err instanceof Error ? err.message : String(err) });
    }
    return false;
  }
}

/** Starts the loop: one beat now, then one per interval. Returns a stop function. */
export function startHeartbeat(opts: HeartbeatOptions): () => void {
  const state = { missingTableLogged: false };
  const every = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const set = opts.setInterval ?? ((fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  });
  const clear = opts.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout));
  void beatOnce(opts, state);
  const handle = set(() => void beatOnce(opts, state), every);
  return () => clear(handle);
}

import type { RequestHandler } from "express";

/** A heartbeat older than this counts as a stopped runner (only enforced behind TMA_HEALTH_REQUIRE_RUNNER). */
export const RUNNER_STALE_MS = 5 * 60_000;
export const DB_PING_TIMEOUT_MS = 2000;

export interface HealthDb {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface HealthDeps {
  /** Lazy, so a test or a process without a database can still build the app. */
  db: () => HealthDb;
  /** TMA_HEALTH_REQUIRE_RUNNER=true. Default false: a stopped runner never takes the API out of rotation. */
  requireRunner?: boolean;
  now?: () => Date;
  dbTimeoutMs?: number;
  /** /health is public and unlimited: share one result between calls this close together. Default 2 s; 0 turns it off. */
  cacheMs?: number;
}

export interface HealthBody {
  status: "ok" | "down" | "runner_stale";
  db: "ok" | "down";
  queued: number | null;
  runnerSeenAt: string | null;
}

export function healthRequiresRunner(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TMA_HEALTH_REQUIRE_RUNNER === "true";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Builds the /health payload.
 *  - `db`: `select 1` with a 2 s timeout. Down → HTTP 503.
 *  - `queued`: count of runs with status `queued` (null when the count fails).
 *  - `runnerSeenAt`: max(runner_heartbeats.seen_at); null when the table is missing (42P01, 0020 not applied) or empty.
 *  - A heartbeat older than 5 min → 503 ONLY when `requireRunner` is on. A missing table or an empty
 *    table never fails the check: the flag is for operators who have applied 0020 and run a runner.
 */
export async function checkHealth(deps: HealthDeps): Promise<{ httpStatus: 200 | 503; body: HealthBody }> {
  const timeoutMs = deps.dbTimeoutMs ?? DB_PING_TIMEOUT_MS;
  const now = (deps.now ?? (() => new Date()))();
  let db: HealthDb;
  try {
    db = deps.db();
    await withTimeout(db.query("select 1"), timeoutMs);
  } catch {
    return { httpStatus: 503, body: { status: "down", db: "down", queued: null, runnerSeenAt: null } };
  }

  let queued: number | null = null;
  try {
    const r = await withTimeout(db.query("select count(*)::int as n from runs where status = 'queued'"), timeoutMs);
    queued = Number(r.rows[0]?.n ?? 0);
  } catch {
    queued = null;
  }

  let runnerSeenAt: string | null = null;
  try {
    const r = await withTimeout(db.query("select max(seen_at) as seen_at from runner_heartbeats"), timeoutMs);
    const seen = r.rows[0]?.seen_at;
    if (seen) runnerSeenAt = new Date(seen as string | Date).toISOString();
  } catch {
    // Missing table (42P01, 0020 not applied), a timeout or any other error: unknown, so null. Never a 503 by itself.
    runnerSeenAt = null;
  }

  if (deps.requireRunner && runnerSeenAt !== null && now.getTime() - Date.parse(runnerSeenAt) > RUNNER_STALE_MS) {
    return { httpStatus: 503, body: { status: "runner_stale", db: "ok", queued, runnerSeenAt } };
  }
  return { httpStatus: 200, body: { status: "ok", db: "ok", queued, runnerSeenAt } };
}

export function createHealthHandler(deps: HealthDeps): RequestHandler {
  const cacheMs = deps.cacheMs ?? 2000;
  let cached: { at: number; result: Promise<Awaited<ReturnType<typeof checkHealth>>> } | null = null;
  return (_req, res) => {
    const t = Date.now();
    if (!cached || cacheMs <= 0 || t - cached.at >= cacheMs) cached = { at: t, result: checkHealth(deps) };
    cached.result
      .then(({ httpStatus, body }) => res.status(httpStatus).json(body))
      .catch(() => res.status(503).json({ status: "down", db: "down", queued: null, runnerSeenAt: null }));
  };
}

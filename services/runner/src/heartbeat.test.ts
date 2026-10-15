import { describe, expect, it } from 'vitest';
import { beatOnce, heartbeatIntervalMs, HEARTBEAT_INTERVAL_MS, startHeartbeat, UPSERT_HEARTBEAT, type HeartbeatDb } from './heartbeat.js';

/** A fake clock: it holds the callbacks that setInterval received and fires them on demand. */
function fakeClock() {
  let nowMs = Date.parse('2026-10-15T12:00:00Z');
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    now: () => new Date(nowMs),
    setInterval: (fn: () => void, ms: number) => {
      timers.set(next, { fn, ms });
      return next++;
    },
    clearInterval: (h: unknown) => void timers.delete(h as number),
    tick(ms: number) {
      nowMs += ms;
      for (const t of timers.values()) t.fn();
    },
    timers,
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('heartbeat loop', () => {
  it('writes at start, then once per interval, with the clock time', async () => {
    const clock = fakeClock();
    const calls: unknown[][] = [];
    const db: HeartbeatDb = { query: async (_t, v) => void calls.push(v) };
    const stop = startHeartbeat({ db, runnerId: 'w@host', version: 'abc123', concurrency: 2, ...clock });
    await flush();
    expect(calls).toHaveLength(1);
    expect([...clock.timers.values()][0]!.ms).toBe(HEARTBEAT_INTERVAL_MS);
    clock.tick(30_000);
    await flush();
    clock.tick(30_000);
    await flush();
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(['w@host', new Date('2026-10-15T12:00:00Z'), 'abc123', 2]);
    expect((calls[2]![1] as Date).toISOString()).toBe('2026-10-15T12:01:00.000Z');
    stop();
    expect(clock.timers.size).toBe(0);
  });

  it('uses the upsert statement keyed on runner_id', () => {
    expect(UPSERT_HEARTBEAT).toMatch(/on conflict \(runner_id\) do update/);
  });

  it('logs a failure and keeps beating (never throws)', async () => {
    const clock = fakeClock();
    const logs: Array<Record<string, unknown>> = [];
    let fail = true;
    const calls: number[] = [];
    const db: HeartbeatDb = {
      query: async () => {
        calls.push(1);
        if (fail) throw new Error('connection terminated');
      },
    };
    startHeartbeat({ db, runnerId: 'w', version: null, concurrency: 1, log: (e) => void logs.push(e), ...clock });
    await flush();
    expect(logs).toEqual([{ event: 'heartbeat_failed', error: 'connection terminated' }]);
    fail = false;
    clock.tick(30_000);
    await flush();
    expect(calls).toHaveLength(2);
    expect(logs).toHaveLength(1);
  });

  it('logs a missing table once and keeps running', async () => {
    const clock = fakeClock();
    const logs: Array<Record<string, unknown>> = [];
    let missing = true;
    const calls: number[] = [];
    const db: HeartbeatDb = {
      query: async () => {
        calls.push(1);
        if (missing) throw Object.assign(new Error('relation "runner_heartbeats" does not exist'), { code: '42P01' });
      },
    };
    startHeartbeat({ db, runnerId: 'w', version: null, concurrency: 1, log: (e) => void logs.push(e), ...clock });
    await flush();
    clock.tick(30_000);
    await flush();
    clock.tick(30_000);
    await flush();
    expect(calls).toHaveLength(3);
    expect(logs.filter((l) => l.event === 'heartbeat_table_missing')).toHaveLength(1);
    // The migration lands: the next beat writes without a restart.
    missing = false;
    clock.tick(30_000);
    await flush();
    expect(calls).toHaveLength(4);
  });

  it('beatOnce reports whether the row was written', async () => {
    const state = { missingTableLogged: false };
    expect(await beatOnce({ db: { query: async () => undefined }, runnerId: 'w', version: null, concurrency: 1 }, state)).toBe(true);
    expect(await beatOnce({ db: { query: async () => { throw new Error('x'); } }, runnerId: 'w', version: null, concurrency: 1 }, state)).toBe(false);
  });
});

describe('heartbeatIntervalMs', () => {
  it('defaults to 30 s and accepts a configured value of at least 1 s', () => {
    expect(heartbeatIntervalMs(undefined)).toBe(30_000);
    expect(heartbeatIntervalMs('abc')).toBe(30_000);
    expect(heartbeatIntervalMs('100')).toBe(30_000);
    expect(heartbeatIntervalMs('5000')).toBe(5000);
  });
});

// Test fixtures of `tma studio serve`. All synthetic: no real trace, task, repo or host text.
// A fake TMA API signs and checks HS256 tokens with a test-only key, as apps/api/src/auth/session.ts does.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Introspect } from './auth.js';
import type { StudioSources } from './content.js';

const TEST_KEY = 'studio-fixture-key-not-a-secret';
export const ALLOWED = 'dfl:00000000-0000-4000-8000-000000000001';
export const OTHER = 'dfl:00000000-0000-4000-8000-000000000002';

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function signToken(claims: Record<string, unknown>, key = TEST_KEY): string {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(claims);
  const sig = createHmac('sha256', key).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function webToken(sub = ALLOWED, nowMs = Date.now(), ttlS = 3600): string {
  const iat = Math.floor(nowMs / 1000);
  return signToken({ sub, amr: 'dfl', iat, exp: iat + ttlS, iss: 'itera-api' });
}

/** A fake `GET /auth/me`: 200 {id} for a token with a valid test signature that has not expired, else 401. */
export function fakeApi(opts: { disabled?: Set<string> } = {}): Introspect & { calls: number } {
  const fn = Object.assign(async (token: string): Promise<{ status: number; body: Record<string, unknown> | null }> => {
    fn.calls++;
    const [h, p, s] = token.split('.');
    const expected = createHmac('sha256', TEST_KEY).update(`${h}.${p}`).digest();
    const given = Buffer.from(s ?? '', 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { status: 401, body: { error: 'unauthorized' } };
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8')) as { sub: string; exp: number };
    if (claims.exp * 1000 <= Date.now()) return { status: 401, body: { error: 'unauthorized' } };
    if (opts.disabled?.has(claims.sub)) return { status: 403, body: { error: 'account_disabled' } };
    return { status: 200, body: { id: claims.sub, kind: 'dfl', wallet: claims.sub } };
  }, { calls: 0 });
  return fn;
}

export const SID_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
export const SID_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
export const SID_OUTSIDE = 'cccccccc-0000-4000-8000-00000000000c';
export const SUB_AGENT = 'a0fixture0sub';

/** Builds a private-root-like tree in a temp dir: trace-select output, a SQLite index, layer-1 files. */
export function buildFixture(): StudioSources & { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'tma-studio-'));
  const selectDir = join(root, 'trace-select');
  const trajectoryRoot = join(root, 'session-trajectories');
  const outside = join(root, 'elsewhere');
  for (const d of [selectDir, join(trajectoryRoot, '2026-11'), outside]) mkdirSync(d, { recursive: true });

  const candidate = (sid: string, agentId: string | null, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema: 'tma-trace-select/1',
      session_id: sid,
      agent_id: agentId,
      run_kind: agentId ? 'subagent' : 'main',
      identifier: 'DFL-00001',
      task_id: '11111111-0000-4000-8000-000000000001',
      harness: 'claude-code',
      host: 'fixture-host',
      model: 'fixture-model',
      l2_class: 'build',
      mode: 'trace_review',
      why: 'red',
      red: true,
      signals: { revert: false, ci_rerun: true, correction: null, junk: 'dropped' },
      started_at: '2026-11-01T10:00:00.000Z',
      private_note: 'a field the service must not serve',
      ...extra,
    });
  // An older selection day, to prove the newest file wins.
  writeFileSync(join(selectDir, 'candidates-2026-11-01.jsonl'), `${candidate(SID_B, null, { identifier: 'OLD' })}\n`);
  writeFileSync(
    join(selectDir, 'candidates-2026-11-02.jsonl'),
    [
      candidate(SID_A, null, { task_summary: { before: 'B'.repeat(400), expected: 'Fixture expected state.', outcome: 'Fixture outcome.' } }),
      candidate(SID_A, SUB_AGENT, { l2_class: 'fix', why: 'sample' }),
      candidate(SID_B, null, { l2_class: 'plan', mode: 'replay' }),
      candidate(SID_OUTSIDE, null),
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(selectDir, 'pins-2026-11-02.index.jsonl'),
    `${JSON.stringify({ session_id: SID_A, agent_id: null, pin_sha256: 'f'.repeat(64), complete: false, missing: ['repo', 'base_sha'], layer1: true })}\n`,
  );

  const span = (seq: number, ok: boolean, ts: string) => ({
    seq,
    turn_seq: 1,
    ts,
    ts_end: ts,
    dur_ms: 10,
    tool: 'Bash',
    shape: 'npm',
    intent: 'test-run',
    family: 'shell',
    target: null,
    target_kind: null,
    ok,
    retry_of: null,
    child_run: null,
    preview: `fixture step ${seq}`,
    bytes_out: 5,
    secret_like: 'not served',
  });
  const trajectory = (sid: string) =>
    [
      { kind: 'session_tree', session_id: sid, title: 'Fixture session', started_at: '2026-11-01T10:00:00.000Z', n_runs: 2, n_tool_calls: 3, errors: 1, models: ['fixture-model'] },
      { kind: 'run', session_id: sid, agent_id: null, is_subagent: false, started_at: '2026-11-01T10:00:00.000Z', errors: { n: 0 }, spans: [span(0, true, '2026-11-01T10:00:01.000Z'), span(1, true, '2026-11-01T10:00:09.000Z')] },
      { kind: 'run', session_id: sid, agent_id: SUB_AGENT, parent_agent_id: null, is_subagent: true, started_at: '2026-11-01T10:00:02.000Z', errors: { n: 1 }, spans: [span(0, false, '2026-11-01T10:00:03.000Z')] },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n';
  const fileA = join(trajectoryRoot, '2026-11', `${SID_A}.jsonl`);
  writeFileSync(fileA, trajectory(SID_A));
  const fileOutside = join(outside, `${SID_OUTSIDE}.jsonl`);
  writeFileSync(fileOutside, trajectory(SID_OUTSIDE));

  const indexPath = join(root, 'trace-index.sqlite');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (p: string) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): void }; close(): void };
  };
  const db = new DatabaseSync(indexPath);
  db.exec(
    'CREATE TABLE sessions (host TEXT NOT NULL, harness TEXT NOT NULL, tree TEXT NOT NULL, session_id TEXT, agent_id TEXT, kind TEXT, first_ts TEXT, last_ts TEXT, message_count INTEGER, models TEXT, path TEXT NOT NULL, state TEXT NOT NULL, trajectory_ref TEXT, indexed_at TEXT NOT NULL, PRIMARY KEY (host, harness, path))',
  );
  const ins = db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  ins.run('fixture-host', 'claude-code', 'root', SID_A, null, 'main', '2026-11-01T10:00:00Z', '2026-11-01T10:05:00Z', 12, '["fixture-model"]', `/x/${SID_A}.jsonl`, 'live', fileA, '2026-11-02T00:00:00Z');
  ins.run('fixture-host', 'claude-code', 'root', SID_A, SUB_AGENT, 'subagent', '2026-11-01T10:00:02Z', '2026-11-01T10:01:00Z', 3, '["fixture-model"]', `/x/${SID_A}/sub.jsonl`, 'live', null, '2026-11-02T00:00:00Z');
  ins.run('fixture-host', 'claude-code', 'root', SID_B, null, 'main', '2026-11-01T11:00:00Z', '2026-11-01T11:05:00Z', 4, '[]', `/x/${SID_B}.jsonl`, 'live', null, '2026-11-02T00:00:00Z');
  // A trajectory_ref outside the trajectory root must never be served.
  ins.run('fixture-host', 'claude-code', 'root', SID_OUTSIDE, null, 'main', '2026-11-01T12:00:00Z', '2026-11-01T12:05:00Z', 4, '[]', `/x/${SID_OUTSIDE}.jsonl`, 'live', fileOutside, '2026-11-02T00:00:00Z');
  db.close();
  return { root, indexPath, selectDir, trajectoryRoot };
}

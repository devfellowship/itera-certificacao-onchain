// The synthetic fixture tree of `tma studio serve` (task S2S3-FIXTURE-PRINCIPAL, plan
// 20261112-tma-c5-studio-area-web2). All synthetic: no real trace, task, repo or host text.
//
// Two users:
//   - the tests build it in a temp dir (fixture.test-helpers.ts re-exports it);
//   - `tma studio fixture --out <dir>` writes it on the content host, and `tma studio serve --fixture-root <dir>`
//     serves it to the FIXTURE principals only (for example the CLAUDE_SMOKE login of the prod checks).
//
// The serve accepts a fixture root only when `fixtureSourcesAt()` passes: the marker file of this builder is
// there, the tree holds no symbolic link, and the tree does not overlap a real source. So a fixture principal
// can never read a real file through the fixture tree.
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { StudioSources } from './content.js';

/** The marker file that `buildFixture()` writes at the root of a fixture tree. */
export const FIXTURE_MARKER = '.tma-studio-fixture';
export const FIXTURE_SCHEMA = 'tma-studio-fixture/1';

/** The ids and texts of one synthetic tree. The tests build a second variant to stand in for the real tree. */
export interface FixtureVariant {
  sidA: string;
  sidB: string;
  sidOutside: string;
  subAgent: string;
  /** The candidate `identifier` and the task id. */
  identifier: string;
  taskId: string;
  /** A word put in every text field (title, preview, task summary), so a test can see which tree answered. */
  label: string;
}

export const FIXTURE_VARIANT: FixtureVariant = {
  sidA: 'aaaaaaaa-0000-4000-8000-00000000000a',
  sidB: 'bbbbbbbb-0000-4000-8000-00000000000b',
  sidOutside: 'cccccccc-0000-4000-8000-00000000000c',
  subAgent: 'a0fixture0sub',
  identifier: 'FIXTURE-00001',
  taskId: '11111111-0000-4000-8000-000000000001',
  label: 'Fixture',
};

/** The sources of a fixture tree, by their fixed names under its root. */
export function fixtureSources(root: string): StudioSources {
  return { indexPath: join(root, 'trace-index.sqlite'), selectDir: join(root, 'trace-select'), trajectoryRoot: join(root, 'session-trajectories') };
}

/**
 * Build a fixture tree: trace-select output, a SQLite index, layer-1 files, and the marker. `root` must not exist
 * or be empty. Without `root`, a new temp dir (the tests).
 */
export function buildFixture(root?: string, v: FixtureVariant = FIXTURE_VARIANT): StudioSources & { root: string } {
  if (root === undefined) root = mkdtempSync(join(tmpdir(), 'tma-studio-'));
  else {
    mkdirSync(root, { recursive: true });
    if (readdirSync(root).length > 0) throw new Error(`fixture root is not empty: ${root}`);
  }
  const src = fixtureSources(root);
  const { selectDir, trajectoryRoot, indexPath } = src;
  const outside = join(root, 'elsewhere');
  for (const d of [selectDir, join(trajectoryRoot, '2026-11'), outside]) mkdirSync(d, { recursive: true });

  const candidate = (sid: string, agentId: string | null, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema: 'tma-trace-select/1',
      session_id: sid,
      agent_id: agentId,
      run_kind: agentId ? 'subagent' : 'main',
      identifier: v.identifier,
      task_id: v.taskId,
      task_name: `${v.label} task name`,
      external_id: v.identifier,
      external_url: `https://example.invalid/tasks/${v.taskId}`,
      harness: 'claude-code',
      host: `${v.label.toLowerCase()}-host`,
      model: `${v.label.toLowerCase()}-model`,
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
  writeFileSync(join(selectDir, 'candidates-2026-11-01.jsonl'), `${candidate(v.sidB, null, { identifier: 'OLD' })}\n`);
  writeFileSync(
    join(selectDir, 'candidates-2026-11-02.jsonl'),
    [
      candidate(v.sidA, null, { task_summary: { before: 'B'.repeat(400), expected: `${v.label} expected state.`, outcome: `${v.label} outcome.` } }),
      candidate(v.sidA, v.subAgent, { l2_class: 'fix', why: 'sample' }),
      candidate(v.sidB, null, { l2_class: 'plan', mode: 'replay' }),
      candidate(v.sidOutside, null),
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(selectDir, 'pins-2026-11-02.index.jsonl'),
    `${JSON.stringify({ session_id: v.sidA, agent_id: null, pin_sha256: 'f'.repeat(64), complete: false, missing: ['repo', 'base_sha'], layer1: true })}\n`,
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
    preview: `${v.label.toLowerCase()} step ${seq}`,
    bytes_out: 5,
    secret_like: 'not served',
  });
  const trajectory = (sid: string) =>
    [
      { kind: 'session_tree', session_id: sid, title: `${v.label} session`, started_at: '2026-11-01T10:00:00.000Z', n_runs: 2, n_tool_calls: 3, errors: 1, models: [`${v.label.toLowerCase()}-model`] },
      { kind: 'run', session_id: sid, agent_id: null, is_subagent: false, started_at: '2026-11-01T10:00:00.000Z', errors: { n: 0 }, spans: [span(0, true, '2026-11-01T10:00:01.000Z'), span(1, true, '2026-11-01T10:00:09.000Z')] },
      { kind: 'run', session_id: sid, agent_id: v.subAgent, parent_agent_id: null, is_subagent: true, started_at: '2026-11-01T10:00:02.000Z', errors: { n: 1 }, spans: [span(0, false, '2026-11-01T10:00:03.000Z')] },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n';
  const fileA = join(trajectoryRoot, '2026-11', `${v.sidA}.jsonl`);
  writeFileSync(fileA, trajectory(v.sidA));
  const fileOutside = join(outside, `${v.sidOutside}.jsonl`);
  writeFileSync(fileOutside, trajectory(v.sidOutside));

  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (p: string) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): void }; close(): void };
  };
  const db = new DatabaseSync(indexPath);
  db.exec(
    'CREATE TABLE sessions (host TEXT NOT NULL, harness TEXT NOT NULL, tree TEXT NOT NULL, session_id TEXT, agent_id TEXT, kind TEXT, first_ts TEXT, last_ts TEXT, message_count INTEGER, models TEXT, path TEXT NOT NULL, state TEXT NOT NULL, trajectory_ref TEXT, indexed_at TEXT NOT NULL, PRIMARY KEY (host, harness, path))',
  );
  const host = `${v.label.toLowerCase()}-host`;
  const models = JSON.stringify([`${v.label.toLowerCase()}-model`]);
  const ins = db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  ins.run(host, 'claude-code', 'root', v.sidA, null, 'main', '2026-11-01T10:00:00Z', '2026-11-01T10:05:00Z', 12, models, `/x/${v.sidA}.jsonl`, 'live', fileA, '2026-11-02T00:00:00Z');
  ins.run(host, 'claude-code', 'root', v.sidA, v.subAgent, 'subagent', '2026-11-01T10:00:02Z', '2026-11-01T10:01:00Z', 3, models, `/x/${v.sidA}/sub.jsonl`, 'live', null, '2026-11-02T00:00:00Z');
  ins.run(host, 'claude-code', 'root', v.sidB, null, 'main', '2026-11-01T11:00:00Z', '2026-11-01T11:05:00Z', 4, '[]', `/x/${v.sidB}.jsonl`, 'live', null, '2026-11-02T00:00:00Z');
  // A trajectory_ref outside the trajectory root must never be served.
  ins.run(host, 'claude-code', 'root', v.sidOutside, null, 'main', '2026-11-01T12:00:00Z', '2026-11-01T12:05:00Z', 4, '[]', `/x/${v.sidOutside}.jsonl`, 'live', fileOutside, '2026-11-02T00:00:00Z');
  db.close();

  writeFileSync(join(root, FIXTURE_MARKER), `${JSON.stringify({ schema: FIXTURE_SCHEMA, synthetic: true })}\n`);
  return { root, ...src };
}

/** A path made absolute and, when it exists, with its symbolic links resolved. */
function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Every symbolic link under `dir` (lstat, not followed). */
function symlinksUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out.push(p);
      else if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * The sources of the fixture tree at `root`, after the checks; throws with a reason otherwise:
 *   - the root exists and holds the marker of `buildFixture()` (schema tma-studio-fixture/1, synthetic: true);
 *   - no symbolic link anywhere in the tree (a link could point at a real file);
 *   - the tree does not overlap a real source: it is not inside the real select dir, trajectory root or the folder
 *     of the real index, and no real source is inside it.
 * The layer-1 path guard of content.ts then serves a fixture trajectory only from inside the fixture root.
 */
export function fixtureSourcesAt(root: string, real: StudioSources): StudioSources {
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    throw new Error(`fixture root does not exist: ${root}`);
  }
  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(join(rootReal, FIXTURE_MARKER), 'utf8'));
  } catch {
    throw new Error(`fixture root has no ${FIXTURE_MARKER} marker (build it with: tma studio fixture --out <dir>): ${root}`);
  }
  const m = marker as { schema?: unknown; synthetic?: unknown } | null;
  if (!m || m.schema !== FIXTURE_SCHEMA || m.synthetic !== true) throw new Error(`fixture root marker is not ${FIXTURE_SCHEMA}: ${root}`);
  const links = symlinksUnder(rootReal);
  if (links.length > 0) throw new Error(`fixture root holds a symbolic link (${links.length}): ${links[0]}`);
  const realDirs = [real.selectDir, real.trajectoryRoot, dirname(real.indexPath)].map(realOrResolved);
  for (const d of realDirs) {
    if (inside(rootReal, d) || inside(d, rootReal)) throw new Error(`fixture root overlaps a real source (${d}): ${root}`);
  }
  const fx = fixtureSources(rootReal);
  assertDisjointSources(real, fx);
  return fx;
}

/**
 * Throws when a fixture source and a real source share a path: the same index file, or a fixture folder inside a
 * real folder (or the reverse). `startStudioServer` calls it too, for a caller that does not use fixtureSourcesAt.
 */
export function assertDisjointSources(real: StudioSources, fixture: StudioSources): void {
  const r = { index: realOrResolved(real.indexPath), dirs: [real.selectDir, real.trajectoryRoot].map(realOrResolved) };
  const f = { index: realOrResolved(fixture.indexPath), dirs: [fixture.selectDir, fixture.trajectoryRoot].map(realOrResolved) };
  if (r.index === f.index) throw new Error('fixture index is the real index');
  for (const a of r.dirs) {
    if (inside(f.index, a)) throw new Error(`fixture index is inside a real source: ${a}`);
    for (const b of f.dirs) if (inside(a, b) || inside(b, a)) throw new Error(`fixture source overlaps a real source: ${b} / ${a}`);
  }
  for (const b of f.dirs) if (inside(r.index, b)) throw new Error(`real index is inside a fixture source: ${b}`);
}

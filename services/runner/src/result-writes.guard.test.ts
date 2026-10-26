/**
 * CI GUARD: results enter the TMA database through ONE door, the API (POST /self-declared-results for a result
 * the hosted worker did not produce; the worker's own finish for a hosted run). Plan
 * 20261026-tma-local-runner-and-self-declared-results, ADR-3 (task L8).
 *
 * Before this plan an operator CLI in this folder (`bench-import.ts`, `bench-adopt.ts`) wrote
 * `public.evaluations` and `public.runs` direct, as the `itera_api_service` role. Both files are deleted.
 * This test keeps that door shut. It runs in `npm run test` (the `validate` job of .github/workflows/ci.yml).
 *
 * THE RULES (each is checked on every non-test source file of the repo; see SCAN_* below for what is scanned):
 *   R1  Under services/runner, SQL writes (insert into / update / delete from / merge into / truncate / copy of a
 *       table that a migration creates) happen only in the files of RUNNER_WRITERS, and only on the tables listed
 *       for that file. A new file with a write, or a listed file with a write on a new table, fails.
 *   R2  `public.evaluations`, `public.runs` and `public.run_actions` (the result tables) are written only by the
 *       API's own store layer (apps/api/src/**, files named *.pg.ts, *store.ts or *repository.ts). The only
 *       other writers are the runner files of RUNNER_WRITERS, and only on `runs` and `run_actions` (the worker's
 *       job queue; the operator's `bench-enqueue`, which only inserts a `queued` run that the worker then grades).
 *       `evaluations` is API only. Any other file in the repo fails.
 *   R3  No source file names the DB role `itera_api_service`. The role belongs to the API and the worker through
 *       DATABASE_URL, never to code. Exempt: the hermetic CI bootstrap that CREATES the role (ROLE_NAME_EXEMPT).
 *   R4  Under services/runner, a DB client is imported only by the files of RUNNER_DB_CLIENT_FILES (`pg`), and
 *       no other DB client or ORM (`postgres`, `knex`, `kysely`, `drizzle-orm`, `@supabase/supabase-js`,
 *       `typeorm`, `@prisma/client`, `slonik`) is imported at all.
 *
 * NOT covered, on purpose: test files (*.test.*, *.spec.*; they seed fixtures and are never shipped), the SQL
 * migrations (db/migrations has its own human review, and 0021 relabels the old bench rows), markdown, and an
 * operator with a shell on the host (the plan's Risks section: that is not a CLI door). Comments are not
 * executed, so a full-line comment is skipped; a trailing comment is still scanned.
 *
 * A new legitimate writer is a deliberate act: add the file to the lists below in the same PR, with the reason.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

export type Violation = { rule: 'R1' | 'R2' | 'R3' | 'R4'; file: string; detail: string };
export type SourceFile = { path: string; text: string };
type Write = { file: string; verb: string; table: string };

/** Files under services/runner that may write SQL, and the tables each may write. */
export const RUNNER_WRITERS: Record<string, readonly string[]> = {
  // the worker: claim a queued run, phase, trace actions, patch artifact, final result of a HOSTED run
  'services/runner/src/jobs.pg.ts': ['runs', 'run_actions', 'observations'],
  // operator CLI: queues a hosted run (vendor -> agent -> version -> release -> queued run -> campaign cap). No result.
  'services/runner/src/bench-enqueue.ts': ['vendors', 'agents', 'agent_versions', 'release_declarations', 'runs', 'bench_campaigns'],
  // user-task validation (U19): task status and the validation record
  'services/runner/src/user-tasks.pg.ts': ['task_validations', 'task_versions', 'task_packs', 'tasks'],
  'services/runner/src/curated-packs.ts': ['task_packs'],
  'services/runner/src/heartbeat.ts': ['runner_heartbeats'],
};
/** The result tables a runner file of RUNNER_WRITERS may write (R2). `evaluations` is never one of them: API only. */
export const RUNNER_RESULT_TABLES = ['runs', 'run_actions'];
export const RESULT_TABLES = ['evaluations', 'runs', 'run_actions'] as const;
/** Runner files that may import the `pg` client (R4). */
export const RUNNER_DB_CLIENT_FILES = [
  'services/runner/src/worker.ts',
  'services/runner/src/jobs.pg.ts',
  'services/runner/src/user-tasks.pg.ts',
  'services/runner/src/curated-packs.ts',
  'services/runner/src/bench-enqueue.ts',
  'services/runner/src/score-v2-preview.ts', // read-only: select from public.runs
  'services/runner/src/heartbeat.ts',
];
export const ROLE_NAME = 'itera_api_service';
export const ROLE_NAME_EXEMPT = ['scripts/e2e/hermetic/db-pre.sql', '.github/workflows/web3-e2e-guard.yml'];
const API_LAYER = /^apps\/api\/src\/.*(\.pg|store|repository)\.ts$/;
const OTHER_DB_CLIENTS = ['postgres', 'knex', 'kysely', 'drizzle-orm', '@supabase/supabase-js', 'typeorm', '@prisma/client', 'slonik'];

const SCAN_ROOTS = ['apps', 'packages', 'services', 'scripts', 'tools', 'mcp', 'benchmarks', 'graders', 'db', '.github'];
const SCAN_EXT = /\.(?:[cm]?[jt]sx?|sh|bash|py|sql|ya?ml)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo', '.next', '.git', 'test-tasks']);
const SKIP_PATHS = ['db/migrations/']; // reviewed by a human code owner; 0021 relabels the old bench rows (plan ADR-8, L12)
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const THIS_FILE = 'services/runner/src/result-writes.guard.test.ts';

const posix = (p: string) => p.split(sep).join('/');

/** The SQL write verbs, followed by the table. `for update` and `do update set` never match (no table follows). */
const WRITE_RE = /\b(insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?|copy)\s+(?:only\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;

/** Drop full-line comments (`//`, `*`, `/*`, `#`, `--`). A trailing comment stays: the guard must not be hideable. */
function withoutCommentLines(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*(?:\/\/|\/\*|\*|#|--)/.test(l))
    .join('\n');
}

/** Every table that a migration creates. A write verb followed by any other word (prose) is not a write. */
export function tablesFromMigrations(sqlTexts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of sqlTexts) for (const m of t.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi)) out.add(m[1]!.toLowerCase());
  return out;
}

export function findWrites(file: SourceFile, tables: Set<string>): Write[] {
  const out: Write[] = [];
  for (const m of withoutCommentLines(file.text).matchAll(WRITE_RE)) {
    const table = m[2]!.toLowerCase();
    if (tables.has(table)) out.push({ file: file.path, verb: m[1]!.toLowerCase().replace(/\s+/g, ' '), table });
  }
  return out;
}

function importsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of withoutCommentLines(text).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)) out.push(m[1]!);
  return out;
}

export function scanFiles(files: SourceFile[], tables: Set<string>): Violation[] {
  const v: Violation[] = [];
  for (const f of files) {
    const isTest = TEST_FILE.test(f.path);
    const inRunner = f.path.startsWith('services/runner/');

    // R3: the role name, in code, config and scripts (tests included; this guard file is the one exception).
    if (f.path !== THIS_FILE && !ROLE_NAME_EXEMPT.includes(f.path) && f.text.includes(ROLE_NAME)) {
      v.push({ rule: 'R3', file: f.path, detail: `names the DB role ${ROLE_NAME}; the role is reached through DATABASE_URL only` });
    }
    if (isTest) continue;

    const writes = findWrites(f, tables);
    // R1: the runner.
    if (inRunner) {
      const allowed = RUNNER_WRITERS[f.path];
      for (const w of writes) {
        if (!allowed) v.push({ rule: 'R1', file: f.path, detail: `direct SQL write "${w.verb} ${w.table}" in a runner file that is not a worker file` });
        else if (!allowed.includes(w.table)) v.push({ rule: 'R1', file: f.path, detail: `"${w.verb} ${w.table}": this file may write only ${allowed.join(', ')}` });
      }
      // R4: the DB client.
      for (const spec of importsOf(f.text)) {
        if (OTHER_DB_CLIENTS.includes(spec) || OTHER_DB_CLIENTS.some((c) => spec.startsWith(c + '/'))) {
          v.push({ rule: 'R4', file: f.path, detail: `imports the DB client "${spec}"; the runner uses \`pg\` in its worker files only` });
        } else if (spec === 'pg' && !RUNNER_DB_CLIENT_FILES.includes(f.path)) {
          v.push({ rule: 'R4', file: f.path, detail: 'imports `pg` in a runner file that is not a worker file' });
        }
      }
    }
    // R2: the result tables, everywhere.
    for (const w of writes) {
      if (!(RESULT_TABLES as readonly string[]).includes(w.table)) continue;
      if (API_LAYER.test(f.path)) continue;
      if (RUNNER_RESULT_TABLES.includes(w.table) && RUNNER_WRITERS[f.path]?.includes(w.table)) continue;
      v.push({ rule: 'R2', file: f.path, detail: `"${w.verb} ${w.table}" outside the API store layer and the worker; results enter through POST /self-declared-results` });
    }
  }
  return v;
}

export function collectFiles(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      const rel = posix(relative(root, full));
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!SKIP_PATHS.some((p) => (rel + '/').startsWith(p))) walk(full);
      } else if (SCAN_EXT.test(name) && st.size < 2_000_000) {
        out.push({ path: rel, text: readFileSync(full, 'utf-8') });
      }
    }
  };
  for (const r of SCAN_ROOTS) {
    try {
      if (statSync(join(root, r)).isDirectory()) walk(join(root, r));
    } catch {
      /* a root that does not exist in this checkout */
    }
  }
  return out;
}

export function migrationTables(root: string): Set<string> {
  const dir = join(root, 'db', 'migrations');
  return tablesFromMigrations(readdirSync(dir).filter((n) => n.endsWith('.sql')).map((n) => readFileSync(join(dir, n), 'utf-8')));
}

export function scanRepo(root: string): { violations: Violation[]; files: SourceFile[]; tables: Set<string> } {
  const files = collectFiles(root);
  const tables = migrationTables(root);
  return { violations: scanFiles(files, tables), files, tables };
}

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const TABLES = new Set(['evaluations', 'runs', 'run_actions', 'vendors', 'agents', 'tasks', 'users']);
const f = (path: string, text: string): SourceFile => ({ path, text });
const rules = (files: SourceFile[]) => scanFiles(files, TABLES).map((x) => x.rule).sort();

// The insert that bench-import.ts ran (services/runner/src/bench-import.ts, deleted), as it was.
const OLD_BENCH_IMPORT_INSERT =
  "await c.query(`insert into public.evaluations (id, slug, short_id, owner_wallet, agent_id, agent_version_id, model_id, tasks, status, task_count, payment_kind) values ($1,$2,$3,$4,$5,$6,$7,$8,'graded',1,'free_byok')`, []);";

describe('result-writes guard: the repository today', () => {
  const { violations, files, tables } = scanRepo(REPO_ROOT);

  it('has no violation', () => {
    expect(violations.map((v) => `${v.rule} ${v.file}: ${v.detail}`)).toEqual([]);
  });

  it('is not vacuous: it reads the repo, knows the result tables, and sees the worker write them', () => {
    expect(files.length).toBeGreaterThan(100);
    for (const t of RESULT_TABLES) expect(tables.has(t)).toBe(true);
    const seen = files.flatMap((x) => findWrites(x, tables)).filter((w) => w.file.startsWith('services/runner/'));
    expect(seen.some((w) => w.file === 'services/runner/src/jobs.pg.ts' && w.table === 'runs')).toBe(true);
    expect(seen.some((w) => w.file === 'services/runner/src/bench-enqueue.ts' && w.table === 'runs')).toBe(true);
    // every file named in the lists still exists, so a rename cannot leave a stale allowance
    const paths = new Set(files.map((x) => x.path));
    for (const p of [...Object.keys(RUNNER_WRITERS), ...RUNNER_DB_CLIENT_FILES]) expect(paths.has(p), p).toBe(true);
  });

  it('the two deleted doors stay deleted', () => {
    const paths = new Set(files.map((x) => x.path));
    for (const p of ['services/runner/src/bench-import.ts', 'services/runner/src/bench-adopt.ts']) expect(paths.has(p), p).toBe(false);
  });
});

describe('result-writes guard: negative tests (the guard fires)', () => {
  it('R1+R2: the old bench-import insert, put back in a runner file', () => {
    expect(rules([f('services/runner/src/bench-import.ts', OLD_BENCH_IMPORT_INSERT)])).toEqual(['R1', 'R2']);
  });
  it('R1+R2: a new runner CLI that updates the outcome of runs and evaluations (the bench-adopt shape)', () => {
    const adopt = "await c.query(`update public.runs set owner_wallet=$2, evaluation_id=$1 where id=$1`, []); await c.query(`update public.evaluations set status = 'graded'`);";
    expect(rules([f('services/runner/src/adopt-again.ts', adopt)])).toEqual(['R1', 'R1', 'R2', 'R2']);
  });
  it('R1+R2: a worker file that starts to write evaluations', () => {
    expect(rules([f('services/runner/src/jobs.pg.ts', OLD_BENCH_IMPORT_INSERT)])).toEqual(['R1', 'R2'].sort());
  });
  it('R1: a worker file that writes a table that is not on its list', () => {
    expect(rules([f('services/runner/src/heartbeat.ts', 'insert into users (id) values ($1)')])).toEqual(['R1']);
  });
  it('R1: a write in a runner shell script or SQL file', () => {
    expect(rules([f('services/runner/scripts/fix.sh', 'psql "$DATABASE_URL" -c "delete from agents"')])).toEqual(['R1']);
    expect(rules([f('services/runner/seed.sql', 'insert into vendors (display_name) values (\'x\');')])).toEqual(['R1']);
  });
  it('R1: the write is on two lines, in upper case, or has a quoted schema', () => {
    expect(rules([f('services/runner/src/x.ts', 'q(`INSERT INTO\n   public.vendors (a) values (1)`)')])).toEqual(['R1']);
    expect(rules([f('services/runner/src/x.ts', 'q(`UPDATE "public"."agents" SET a = 1`)')])).toEqual(['R1']);
  });
  it('R2: an API route (not a store) that writes evaluations or runs', () => {
    expect(rules([f('apps/api/src/http/evaluations-router.ts', OLD_BENCH_IMPORT_INSERT)])).toEqual(['R2']);
    expect(rules([f('apps/api/src/http/x-router.ts', "pool.query('update public.runs set score_total = 1')")])).toEqual(['R2']);
  });
  it('R2: a script, a tool or a web app that writes a result table', () => {
    expect(rules([f('scripts/backfill.mts', OLD_BENCH_IMPORT_INSERT)])).toEqual(['R2']);
    expect(rules([f('tools/x/run.mjs', "q('delete from runs')")])).toEqual(['R2']);
    expect(rules([f('apps/web2/server/x.ts', OLD_BENCH_IMPORT_INSERT)])).toEqual(['R2']);
    expect(rules([f('.github/workflows/x.yml', '      - run: psql -c "update public.evaluations set is_public = true"')])).toEqual(['R2']);
  });
  it('R3: a source file names the API role', () => {
    expect(rules([f('services/runner/src/x.ts', "const url = 'postgresql://itera_api_service:pw@host/db';")])).toEqual(['R3']);
    expect(rules([f('scripts/x.sh', 'psql -U itera_api_service')])).toEqual(['R3']);
    expect(rules([f('apps/api/src/x.test.ts', "// SET ROLE itera_api_service")])).toEqual(['R3']);
  });
  it('R4: a new runner file imports pg, or another DB client', () => {
    expect(rules([f('services/runner/src/new-thing.ts', "import type { Pool } from 'pg';")])).toEqual(['R4']);
    expect(rules([f('services/runner/src/new-thing.ts', "const { default: pg } = await import('pg');")])).toEqual(['R4']);
    expect(rules([f('services/runner/src/new-thing.ts', "import postgres from 'postgres';")])).toEqual(['R4']);
    expect(rules([f('services/runner/src/new-thing.ts', "import { createClient } from '@supabase/supabase-js';")])).toEqual(['R4']);
    expect(rules([f('services/runner/src/new-thing.ts', "const knex = require('knex');")])).toEqual(['R4']);
  });
  it('the violation names the rule, the file and the statement', () => {
    const [v] = scanFiles([f('services/runner/src/bench-import.ts', OLD_BENCH_IMPORT_INSERT)], TABLES);
    expect(v).toMatchObject({ rule: 'R1', file: 'services/runner/src/bench-import.ts' });
    expect(v!.detail).toContain('insert into evaluations');
  });
});

describe('result-writes guard: what must NOT fire', () => {
  it('passes the allowed writers on their own tables', () => {
    expect(rules([f('services/runner/src/jobs.pg.ts', 'q(`update public.runs set status = $3`); q(`insert into public.run_actions (run_id) values ($1)`)')])).toEqual([]);
    expect(rules([f('services/runner/src/bench-enqueue.ts', 'q(`insert into public.runs (status) values (\'queued\')`)')])).toEqual([]);
    expect(rules([f('services/runner/src/worker.ts', "const { default: pg } = await import('pg');")])).toEqual([]);
  });
  it('passes the API store layer, and an API file that only reads', () => {
    expect(rules([f('apps/api/src/self-declared/store.pg.ts', OLD_BENCH_IMPORT_INSERT)])).toEqual([]);
    expect(rules([f('apps/api/src/evaluations/store.pg.ts', 'q(`update public.runs set status = $1`)')])).toEqual([]);
    expect(rules([f('apps/api/src/domain/repository.pg.ts', 'q(`insert into public.runs (a) values (1)`)')])).toEqual([]);
    expect(rules([f('apps/api/src/http/evaluations-router.ts', 'q(`select * from public.evaluations where id = $1`)')])).toEqual([]);
  });
  it('does not fire on a comment, on prose, on a read, or on a test fixture', () => {
    expect(rules([f('services/runner/src/x.ts', '// insert into public.evaluations is forbidden here\n/* update public.runs */\n * delete from evaluations')])).toEqual([]);
    expect(rules([f('services/runner/src/x.ts', "throw new Error('cannot update the record'); // for update skip locked")])).toEqual([]);
    expect(rules([f('services/runner/src/x.ts', 'q(`select id from public.runs where id = $1 for update`)')])).toEqual([]);
    expect(rules([f('services/runner/src/x.ts', 'q(`insert into t (a) values (1) on conflict (a) do update set a = 2`)')])).toEqual([]);
    expect(rules([f('services/runner/src/x.test.ts', "import { Pool } from 'pg'; q('insert into public.evaluations (id) values (1)')")])).toEqual([]);
  });
  it('lets the hermetic CI bootstrap create the role', () => {
    expect(rules([f('scripts/e2e/hermetic/db-pre.sql', 'create role itera_api_service login;')])).toEqual([]);
  });
});

describe('result-writes guard: on a real directory tree (the walk, the migrations, the skips)', () => {
  const build = (extra: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'result-writes-guard-'));
    const files: Record<string, string> = {
      'db/migrations/0000_baseline.sql': 'create table if not exists public.evaluations (id uuid); create table public.runs (id uuid); create table public.vendors (id uuid);',
      'services/runner/src/jobs.pg.ts': "import type { Pool } from 'pg';\nq(`update public.runs set status = $1`)",
      'apps/api/src/self-declared/store.pg.ts': 'q(`insert into public.evaluations (id) values ($1)`)',
      ...extra,
    };
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    return root;
  };
  it('a clean tree passes', () => {
    const root = build({});
    try {
      expect(scanRepo(root).violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('a copy of the bench-import insert in services/runner/src makes the scan red', () => {
    const root = build({ 'services/runner/src/bench-import.ts': OLD_BENCH_IMPORT_INSERT });
    try {
      const v = scanRepo(root).violations;
      expect(v.map((x) => x.rule).sort()).toEqual(['R1', 'R2']);
      expect(v.every((x) => x.file === 'services/runner/src/bench-import.ts')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('a write under db/migrations, node_modules or test-tasks is not scanned', () => {
    const root = build({
      'db/migrations/0021_x.sql': "update public.runs set result_origin = 'self_declared';",
      'services/runner/node_modules/p/i.js': OLD_BENCH_IMPORT_INSERT,
      'services/runner/test-tasks/t/seed.sql': OLD_BENCH_IMPORT_INSERT,
    });
    try {
      expect(scanRepo(root).violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

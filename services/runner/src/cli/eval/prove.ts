// `tma eval grader prove` (plan C3 T11): prove that a library grader catches its planted bugs.
//
// The eval repo keeps a grader at graders/<id>/<semver>/{grader.json, grade.py, fixtures/}. Each
// planted bug is one fixture folder fixtures/mutation-*/ (fixtures/code-mutations.json may list them).
// The kit runs the grader BY COMMAND (an argv, no shell) once per fixture: argv + [<fixture dir>], with
// cwd = the grader folder and TMA_FIXTURE_DIR = the fixture folder. The grader answers on the LAST
// non-empty stdout line with JSON {"pass": true|false}. The fixture says what the grader must answer
// (expect.json or the code-mutations.json entry); a planted bug must not pass, so the expected answer
// is {"pass": false}. A crash, a timeout or no JSON answer is NOT a catch (fail closed).
//
// proof.json holds ids, counts and digests only: no grader output, no fixture text.
// Exit 0 only when every planted bug is caught (caught == total, total > 0).
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { childEnv, CliError } from '../env.js';

export const PROOF_FORMAT = 'tma-grader-proof/1';
export const PROOF_FILE = 'proof.json';
export const MUTATIONS_FILE = 'code-mutations.json';
const DEFAULT_TIMEOUT_MS = 60_000;

export interface MutationProof {
  id: string;
  /** Digest of the fixture folder (sorted relative paths + bytes). */
  fixture_sha256: string;
  expected_pass: false;
  /** What the grader answered; null = no answer (crash, timeout, no JSON line). */
  answered_pass: boolean | null;
  caught: boolean;
  exit_code: number | null;
  timed_out: boolean;
}

export type LibStatus = 'pass' | 'fail' | 'infra_error';
export const LIBRARY_LAYOUT = 'tma-grader/1';

/** One mutation fixture of the tma-grader/1 library layout. */
export interface LibMutationProof {
  id: string;
  fixture_sha256: string;
  expected_status: 'fail' | 'infra_error';
  /** What the grader answered; null = no valid answer (crash, timeout, no JSON line). */
  observed_status: LibStatus | null;
  caught: boolean;
  exit_code: number | null;
  timed_out: boolean;
}

export interface GraderProof {
  format: typeof PROOF_FORMAT;
  /** Set for the tma-grader/1 library layout; absent for the generic convention. */
  layout?: typeof LIBRARY_LAYOUT;
  /** True when the proof is green (every planted bug caught and, for the library layout, the reference passes). */
  ok: boolean;
  /** Why the proof is red (library layout): reference_not_passing | mutation_missed. */
  reason?: string;
  reference?: { expected_status: 'pass'; observed_status: LibStatus | null; passing: boolean; fixture_sha256: string; exit_code: number | null; timed_out: boolean };
  library_mutations?: LibMutationProof[];
  grader: { id: string; version: string; code_sha256: string };
  /** Digest of the argv (JSON), so a proof names the command without its text. */
  command_sha256: string;
  caught: number;
  total: number;
  mutations: MutationProof[];
  proved_at: string;
}

interface Mutation {
  id: string;
  dir: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every file under `dir` (sorted, relative), skipping the relative paths in `skip`. */
async function filesOf(dir: string, skip: (rel: string) => boolean = () => false): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      const rel = relative(dir, abs).split('\\').join('/');
      if (skip(rel)) continue;
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) out.push(rel);
    }
  };
  await walk(dir);
  return out.sort();
}

/** sha256 over each file's relative path and bytes, in path order. */
export async function treeSha256(dir: string, skip?: (rel: string) => boolean): Promise<string> {
  const h = createHash('sha256');
  for (const rel of await filesOf(dir, skip)) {
    h.update(`${rel}\0`);
    h.update(await readFile(join(dir, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  const raw = await readFile(path, 'utf-8').catch(() => null);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError(`${path} is not JSON`);
  }
}

/** The expected answer of a fixture: must be {"pass": false} (a planted bug never passes). */
function checkExpect(v: unknown, where: string): void {
  if (v === undefined) return; // no expect file: the default answer of a planted bug is "must not pass"
  if (!isObj(v) || v.pass !== false) throw new CliError(`${where}: a planted bug must expect {"pass": false} (the grader must not pass it)`);
}

async function listMutations(graderDir: string): Promise<Mutation[]> {
  const fixtures = join(graderDir, 'fixtures');
  const listed = await readJsonFile(join(fixtures, MUTATIONS_FILE));
  const out: Mutation[] = [];
  if (listed !== undefined) {
    const entries = Array.isArray(listed) ? listed : isObj(listed) && Array.isArray(listed.mutations) ? listed.mutations : null;
    if (!entries) throw new CliError(`${join(fixtures, MUTATIONS_FILE)}: give an array of mutations or {"mutations": [...]}`);
    for (const [i, e] of entries.entries()) {
      if (!isObj(e) || typeof e.id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(e.id)) throw new CliError(`${MUTATIONS_FILE} entry ${i}: needs an id (letters, digits, _ . -)`);
      const fixture = typeof e.fixture === 'string' ? e.fixture : `mutation-${e.id}`;
      const dir = resolve(fixtures, fixture);
      if (relative(fixtures, dir).startsWith('..')) throw new CliError(`${MUTATIONS_FILE} entry ${e.id}: the fixture must be inside fixtures/`);
      checkExpect(e.expect, `${MUTATIONS_FILE} entry ${e.id}`);
      out.push({ id: e.id, dir });
    }
  } else {
    for (const e of await readdir(fixtures, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory() && e.name.startsWith('mutation-')) out.push({ id: e.name.slice('mutation-'.length), dir: join(fixtures, e.name) });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
  }
  const ids = new Set<string>();
  for (const m of out) {
    if (ids.has(m.id)) throw new CliError(`planted bug ${m.id} is listed twice`);
    ids.add(m.id);
    if (!(await stat(m.dir).catch(() => null))?.isDirectory()) throw new CliError(`planted bug ${m.id}: no fixture folder ${m.dir}`);
    checkExpect(await readJsonFile(join(m.dir, 'expect.json')), join(m.dir, 'expect.json'));
  }
  return out;
}

/** The grader id and version: grader.json {id, version}, else the folder names graders/<id>/<semver>. */
async function graderIdentity(graderDir: string): Promise<{ id: string; version: string; command: string[] | null }> {
  const g = await readJsonFile(join(graderDir, 'grader.json'));
  const rec = isObj(g) ? g : {};
  const id = typeof rec.id === 'string' ? rec.id : basename(dirname(graderDir));
  const version = typeof rec.version === 'string' ? rec.version : basename(graderDir);
  const cmd = rec.command;
  const command = Array.isArray(cmd) && cmd.length > 0 && cmd.every((x) => typeof x === 'string') ? (cmd as string[]) : null;
  return { id, version, command };
}

/** The grader answer: the last non-empty stdout line as JSON {"pass": boolean}, else null. */
export function parseAnswer(stdout: string): boolean | null {
  const last = stdout.split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
  if (!last) return null;
  try {
    const v = JSON.parse(last) as unknown;
    return isObj(v) && typeof v.pass === 'boolean' ? v.pass : null;
  } catch {
    return null;
  }
}

/**
 * The argv prefix that starts a grader in a new Linux user + network namespace: the child sees only a loopback
 * that is down, so it has no route out (Q-C5-2b = A, "no network"). Used by the studio dry run (C5-T10).
 */
export const NETWORK_SANDBOX_PREFIX: readonly string[] = ['unshare', '-rn', '--'];

/** The spawn function of a grader child (injectable for tests). */
export type GraderSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

function runOnce(
  argv: string[],
  extra: string[],
  cwd: string,
  fixtureDir: string,
  timeoutMs: number,
  spawnImpl: GraderSpawn = spawn,
): Promise<{ stdout: string; code: number | null; timedOut: boolean }> {
  return new Promise((res) => {
    // A minimal environment: no key of this host reaches the grader under test.
    const env: NodeJS.ProcessEnv = { ...childEnv(), PYTHONDONTWRITEBYTECODE: '1', TMA_FIXTURE_DIR: fixtureDir };
    let child: ChildProcess;
    try {
      child = spawnImpl(argv[0]!, [...argv.slice(1), ...extra], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      res({ stdout: '', code: null, timedOut: false });
      return;
    }
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < 1_000_000) stdout += d.toString('utf-8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      res({ stdout: '', code: null, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ stdout, code, timedOut });
    });
  });
}

export async function proveGrader(input: { graderDir: string; argv?: string[]; out?: string; timeoutMs?: number; now?: () => Date; log?: (line: string) => void }): Promise<{ proof: GraderProof; file: string }> {
  const graderDir = resolve(input.graderDir);
  if (!(await stat(graderDir).catch(() => null))?.isDirectory()) throw new CliError(`${input.graderDir} is not a folder`);
  const lib = await libraryManifest(graderDir);
  if (lib) return proveLibrary({ ...input, graderDir, lib });
  const ident = await graderIdentity(graderDir);
  let argv = input.argv && input.argv.length > 0 ? input.argv : ident.command;
  if (!argv && (await stat(join(graderDir, 'grade.py')).catch(() => null))) argv = ['python3', 'grade.py'];
  if (!argv) throw new CliError(`no grader command: give it after -- or as "command" in ${join(graderDir, 'grader.json')}`);
  const mutations = await listMutations(graderDir);
  if (mutations.length === 0) throw new CliError(`${graderDir}: no planted bug (fixtures/mutation-*/ or fixtures/${MUTATIONS_FILE})`);
  const codeSha = await treeSha256(graderDir, (rel) => rel === 'fixtures' || rel.startsWith('fixtures/') || rel === PROOF_FILE || rel === '__pycache__' || rel.includes('/__pycache__'));
  const rows: MutationProof[] = [];
  for (const m of mutations) {
    const fixtureSha = await treeSha256(m.dir);
    const r = await runOnce(argv, [m.dir], graderDir, m.dir, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const answered = r.timedOut ? null : parseAnswer(r.stdout);
    const caught = answered === false;
    rows.push({ id: m.id, fixture_sha256: fixtureSha, expected_pass: false, answered_pass: answered, caught, exit_code: r.code, timed_out: r.timedOut });
    input.log?.(`[tma eval] planted bug ${m.id}: ${caught ? 'caught' : answered === true ? 'MISSED (the grader passed it)' : 'MISSED (no answer)'}`);
  }
  const proof: GraderProof = {
    format: PROOF_FORMAT,
    grader: { id: ident.id, version: ident.version, code_sha256: codeSha },
    command_sha256: createHash('sha256').update(JSON.stringify(argv)).digest('hex'),
    ok: rows.length > 0 && rows.every((r) => r.caught),
    caught: rows.filter((r) => r.caught).length,
    total: rows.length,
    mutations: rows,
    proved_at: (input.now ?? (() => new Date()))().toISOString(),
  };
  const file = resolve(input.out ?? join(graderDir, PROOF_FILE));
  await writeFile(file, `${JSON.stringify(proof, null, 2)}\n`, 'utf-8');
  return { proof, file };
}

// ---- the tma-grader/1 library layout (graders/<id>/<semver>/) ----

export interface LibManifest { id: string; semver: string; entry: string }

/** grader.json of the library layout, or null when the folder uses the generic convention. */
export async function libraryManifest(graderDir: string): Promise<LibManifest | null> {
  const g = await readJsonFile(join(graderDir, 'grader.json'));
  if (!isObj(g) || g.schema !== LIBRARY_LAYOUT || typeof g.entry !== 'string' || g.entry === '') return null;
  const entry = g.entry;
  if (isAbsolute(entry) || relative(graderDir, resolve(graderDir, entry)).startsWith('..')) throw new CliError('grader.json: the entry must be inside the grader folder');
  return { id: typeof g.id === 'string' ? g.id : basename(dirname(graderDir)), semver: typeof g.semver === 'string' ? g.semver : basename(graderDir), entry };
}

const LIB_STATUSES: readonly string[] = ['pass', 'fail', 'infra_error'];

/** The status of the last non-empty stdout line, if it is a tma-grader-result/1 JSON object. */
export function parseLibraryStatus(stdout: string): LibStatus | null {
  const last = stdout.split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
  if (!last) return null;
  try {
    const v = JSON.parse(last) as unknown;
    return isObj(v) && v.schema === 'tma-grader-result/1' && typeof v.status === 'string' && LIB_STATUSES.includes(v.status) ? (v.status as LibStatus) : null;
  } catch {
    return null;
  }
}

async function libFixture(dir: string, kind: 'reference' | 'mutation'): Promise<{ expected: LibStatus }> {
  const where = join(dir, 'fixture.json');
  const f = await readJsonFile(where);
  if (!isObj(f) || f.kind !== kind) throw new CliError(`${where}: kind must be "${kind}"`);
  const status = isObj(f.expect) ? f.expect.status : undefined;
  if (kind === 'reference' ? status !== 'pass' : status !== 'fail' && status !== 'infra_error') {
    throw new CliError(`${where}: expect.status must be ${kind === 'reference' ? '"pass"' : '"fail" or "infra_error" (a planted bug must not pass)'}`);
  }
  for (const need of ['spec.json', 'workdir']) if (!(await stat(join(dir, need)).catch(() => null))) throw new CliError(`${dir}: missing ${need}`);
  return { expected: status as LibStatus };
}

/**
 * Run a tma-grader/1 library grader once: `argv --spec <tmp>/spec.json --workdir <tmp>/workdir [--trajectory <file>]`,
 * cwd = the grader folder, the minimal child environment (no key of this host), in a fresh temp dir that is
 * removed in `finally`. `setup` fills the temp dir (spec.json, workdir/ and optionally trajectory.json).
 * Shared by `tma eval grader prove` (a fixture copy) and the studio dry run (one output, C5-T10).
 */
export async function runLibraryGrader(input: {
  argv: string[];
  graderDir: string;
  setup: (tmp: string) => Promise<void>;
  timeoutMs: number;
  /** TMA_FIXTURE_DIR of the child; default: the temp workdir. */
  fixtureDir?: string;
  /** Parent of the temp dir (default os.tmpdir()). */
  tmpRoot?: string;
  /**
   * Start the child as `unshare -rn -- <argv...>` (a user + network namespace, no route out). Default false:
   * `tma eval grader prove` keeps its behaviour. The studio dry run always sets it (C5-T10, Q-C5-2b = A).
   */
  isolateNetwork?: boolean;
  /** The spawn function (tests capture the argv). Default node:child_process spawn. */
  spawnImpl?: GraderSpawn;
}): Promise<{ observed: LibStatus | null; exit_code: number | null; timed_out: boolean }> {
  const tmp = await mkdtemp(join(input.tmpRoot ?? tmpdir(), 'tma-grader-prove-'));
  try {
    await input.setup(tmp);
    const args = ['--spec', join(tmp, 'spec.json'), '--workdir', join(tmp, 'workdir')];
    // The library keeps the trajectory beside spec.json (fixtures/<name>/trajectory.json); a copy inside workdir also counts.
    if (await stat(join(tmp, 'trajectory.json')).catch(() => null)) args.push('--trajectory', join(tmp, 'trajectory.json'));
    else if (await stat(join(tmp, 'workdir', 'trajectory.json')).catch(() => null)) args.push('--trajectory', join(tmp, 'workdir', 'trajectory.json'));
    const argv = input.isolateNetwork ? [...NETWORK_SANDBOX_PREFIX, ...input.argv] : input.argv;
    const r = await runOnce(argv, args, input.graderDir, input.fixtureDir ?? join(tmp, 'workdir'), input.timeoutMs, input.spawnImpl);
    return { observed: r.timedOut ? null : parseLibraryStatus(r.stdout), exit_code: r.code, timed_out: r.timedOut };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Run the grader on a COPY of the fixture (spec + workdir) in a temp dir; the checkout is never written. */
function runLibraryFixture(argv: string[], graderDir: string, fixtureDir: string, timeoutMs: number) {
  return runLibraryGrader({
    argv,
    graderDir,
    timeoutMs,
    fixtureDir,
    setup: async (tmp) => {
      await cp(join(fixtureDir, 'spec.json'), join(tmp, 'spec.json'));
      await cp(join(fixtureDir, 'workdir'), join(tmp, 'workdir'), { recursive: true });
      if (await stat(join(fixtureDir, 'trajectory.json')).catch(() => null)) await cp(join(fixtureDir, 'trajectory.json'), join(tmp, 'trajectory.json'));
    },
  });
}

async function proveLibrary(input: { graderDir: string; lib: LibManifest; argv?: string[]; out?: string; timeoutMs?: number; now?: () => Date; log?: (line: string) => void }): Promise<{ proof: GraderProof; file: string }> {
  const { graderDir, lib } = input;
  const argv = input.argv && input.argv.length > 0 ? input.argv : ['python3', lib.entry];
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fixtures = join(graderDir, 'fixtures');
  const names = (await readdir(fixtures, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && e.name.startsWith('mutation-')).map((e) => e.name).sort();
  if (names.length === 0) throw new CliError(`${graderDir}: no planted bug (fixtures/mutation-*/)`);
  const refDir = join(fixtures, 'reference');
  if (!(await stat(refDir).catch(() => null))?.isDirectory()) throw new CliError(`${graderDir}: no fixtures/reference/ folder`);
  await libFixture(refDir, 'reference');
  const mutations = [];
  for (const n of names) mutations.push({ id: n.slice('mutation-'.length), dir: join(fixtures, n), expected: (await libFixture(join(fixtures, n), 'mutation')).expected as 'fail' | 'infra_error' });

  const codeSha = await treeSha256(graderDir, (rel) => rel === 'fixtures' || rel.startsWith('fixtures/') || rel === PROOF_FILE || rel.includes('__pycache__'));
  const ref = await runLibraryFixture(argv, graderDir, refDir, timeoutMs);
  const reference = { expected_status: 'pass' as const, observed_status: ref.observed, passing: ref.observed === 'pass', fixture_sha256: await treeSha256(refDir), exit_code: ref.exit_code, timed_out: ref.timed_out };
  input.log?.(`[tma eval] reference fixture: ${reference.passing ? 'pass' : 'NOT PASSING'}`);
  const rows: LibMutationProof[] = [];
  for (const m of mutations) {
    const r = await runLibraryFixture(argv, graderDir, m.dir, timeoutMs);
    const caught = r.observed !== null && r.observed !== 'pass' && r.observed === m.expected;
    rows.push({ id: m.id, fixture_sha256: await treeSha256(m.dir), expected_status: m.expected, observed_status: r.observed, caught, exit_code: r.exit_code, timed_out: r.timed_out });
    input.log?.(`[tma eval] planted bug ${m.id}: ${caught ? 'caught' : r.observed === null ? 'MISSED (no answer)' : `MISSED (observed ${r.observed}, expected ${m.expected})`}`);
  }
  const caughtN = rows.filter((r) => r.caught).length;
  const reason = !reference.passing ? 'reference_not_passing' : caughtN < rows.length ? 'mutation_missed' : undefined;
  const proof: GraderProof = {
    format: PROOF_FORMAT,
    layout: LIBRARY_LAYOUT,
    ok: reason === undefined,
    ...(reason ? { reason } : {}),
    grader: { id: lib.id, version: lib.semver, code_sha256: codeSha },
    command_sha256: createHash('sha256').update(JSON.stringify(argv)).digest('hex'),
    reference,
    caught: caughtN,
    total: rows.length,
    mutations: [],
    library_mutations: rows,
    proved_at: (input.now ?? (() => new Date()))().toISOString(),
  };
  const file = resolve(input.out ?? join(graderDir, PROOF_FILE));
  await writeFile(file, `${JSON.stringify(proof, null, 2)}\n`, 'utf-8');
  return { proof, file };
}

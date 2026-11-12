// `tma eval case|run|grade|diff|trajectory|upload` (plan 20261112-tma-c3-eval-repo-kit-docs T3, T4, ADR-4): the eval kit.
// A case manifest (tma-case/1, from the private eval repo) becomes a case folder on the host; a variant
// runs N times in the TMA sandbox; the case graders grade each run by id@version; diff compares a
// variant with the baseline. Everything stays on the host until `tma eval upload` (T4) sends the numbers,
// the digests and the structural trajectory (tma-local-result/2). `tma eval trajectory` reads a harness
// trace into a tma-trajectory/1 record with redacted targets.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { flag, flagList, has, numberFlag, parseArgs, required } from '../args.js';
import type { Command, Io } from '../command.js';
import { apiUrl, CliError } from '../env.js';
import { checkAgentId } from '../result.js';
import { loadSessionFile, requireSession } from '../session.js';
import { postResult } from './upload.js';
import { agentSha, baseAgentFrom, buildEvalUpload, variantFolders } from '../eval/upload.js';
import { readClaudeCodeSession, trajectoryFromActions, trajectoryLine } from '../eval/trajectory.js';
import type { RunAction } from '../../types.js';
import { buildCaseFolder, CASE_RUNS_DIR, loadCaseFolder } from '../eval/case.js';
import { evalDiff } from '../eval/diff.js';
import { gradeRecorded, regrade, runDirs, runVariant, summaryTable, type EvalDeps } from '../eval/runs.js';
import { readVariant } from '../eval/variant.js';

const CASE_USAGE = `usage: tma eval case --case <case.json> --dest <dir> [--task-dir <bundle>] [--recorded <patch>] [--clone]
  Builds a case folder on this host from a tma-case/1 manifest (dfl-evals cases/<type>/<subtype>/<key>/case.json):
  case.json (byte copy), case.lock.json (every digest), input/ (what the agent sees), runs/.
  --task-dir  the task bundle of the case (default: benchmarks/<slug> of a tma-task <slug>@<version>)
  --recorded  trace_review: the recorded output (a patch file); linked, not copied
  --clone     replay from the pin: clone pin.repo at pin.base_sha into input/ with your own git`;

const RUN_USAGE = `usage: tma eval run --case <case dir> --variant <variant.json> [--repeat 1-10]
  Runs the variant N times in the TMA sandbox and grades each run with the case graders.
  Output: <case dir>/${CASE_RUNS_DIR}/<variant sha256[:12]>/ (prediction.md, summary.json, one folder per run).
  A variant file (tma-variant/1):
    {"schema":"tma-variant/1","label":"...","kind":"patch","patch":"solution.patch","change_kind":"none","is_baseline":true,"prediction":null}
    {"schema":"tma-variant/1","label":"...","kind":"agent","agent":{"agent_dir":"./agent","model":"<model id>"},
     "change_kind":"rules","is_baseline":false,"prediction":"what you expect against the baseline"}
  kind patch needs no key ("patch": null = no change). kind agent needs your key, as tma run.`;

const GRADE_USAGE = `usage: tma eval grade --case <case dir> [--run <run dir>]... [--variant-dir <dir>]
  Grades again with the case graders and ADDS a grading to each run (the old ones stay).
  No --run and no --variant-dir: a trace_review case grades its recorded output; a replay case re-grades every run.`;

const DIFF_USAGE = `usage: tma eval diff <baseline> <variant>
  Two variant folders (<case>/${CASE_RUNS_DIR}/<sha12>), two run folders, or two files.
  Files diff by type: .diff/.patch code, .json tree, .md sections + lines, other text lines.`;

const TRAJECTORY_USAGE = `usage: tma eval trajectory --from claude-code <session.jsonl> [--out <file>] [--root <dir>]...
       tma eval trajectory --from opencode <run dir | run.json> [--out <file>]
  Reads a harness trace into tma-trajectory/1: one step per tool call, with the family, status, error class,
  duration, target kind, a REDACTED target (at most 120 characters) and the sha256 of the arguments and the
  result. No prompt, argument, output or file body is kept. --out <run dir>/trajectory.json attaches it to a run.
  --root  a folder whose prefix is dropped from paths (the session cwd is one by default)`;

const UPLOAD_USAGE = `usage: tma eval upload --case <case dir> --variant-dir <dir> --agent <agent id> [--base-agent <file>] [--dry-run]
  Sends the runs of ONE variant as one tma-local-result/2 body (numbers, digests, grader rows, trajectory)
  to POST /self-declared-results. --dry-run prints the body and asks the API with ?dry_run=1 when logged in.
  --base-agent  the base agent version (the 8 fields of variant.agent, or a tma-pin/1). Default: the case pin,
                else the agent folder of an agent variant.`;

const USAGE = [
  'usage: tma eval <case|run|grade|diff|trajectory|upload> ...   (the eval kit: plan C3)',
  '',
  CASE_USAGE,
  '',
  RUN_USAGE,
  '',
  GRADE_USAGE,
  '',
  DIFF_USAGE,
  '',
  TRAJECTORY_USAGE,
  '',
  UPLOAD_USAGE,
].join('\n');

/** The copy command of the next step, as the studio shows it (umbrella ADR-30, ADR-31). */
const next = (io: Io, cmd: string) => io.out(`next: ${cmd}`);

async function caseMain(argv: string[], io: Io): Promise<number> {
  const a = parseArgs(argv, { case: {}, dest: {}, 'task-dir': {}, recorded: {}, clone: { boolean: true } });
  const caseFile = required(a, 'case', CASE_USAGE);
  const dest = required(a, 'dest', CASE_USAGE);
  const lock = await buildCaseFolder({ caseFile, dest, taskDir: flag(a, 'task-dir'), recorded: flag(a, 'recorded'), clone: has(a, 'clone') });
  io.out(`case ${lock.case_key} (${lock.use_case}, ${lock.mode}) written to ${resolve(dest)}`);
  io.out(`manifest ${lock.manifest_sha256.slice(0, 12)}  task ${lock.task ? `${lock.task.ref} env ${lock.task.environment_sha256.slice(0, 12)}` : 'none on this host'}  pin ${lock.pin_sha256?.slice(0, 12) ?? 'none'}`);
  if (lock.mode === 'trace_review') next(io, `tma eval grade --case ${dest}`);
  else next(io, `tma eval run --case ${dest} --variant <variant.json> --repeat 3`);
  return 0;
}

async function runMain(argv: string[], io: Io, deps: EvalDeps): Promise<number> {
  const a = parseArgs(argv, { case: {}, variant: {}, repeat: {} });
  const c = await loadCaseFolder(required(a, 'case', RUN_USAGE));
  const v = await readVariant(required(a, 'variant', RUN_USAGE));
  const repeat = numberFlag(a, 'repeat', { min: 1, max: 10, integer: true }) ?? 1;
  const { variantDir, summary } = await runVariant({ c, v, repeat, deps, log: (l) => io.err(l) });
  io.out(summaryTable(summary));
  io.out(`runs: ${variantDir} (outputs and evidence stay on this host)`);
  return summary.runs.slice(-repeat).every((r) => r.infra_ok) ? 0 : 1;
}

async function gradeMain(argv: string[], io: Io, deps: EvalDeps): Promise<number> {
  const a = parseArgs(argv, { case: {}, run: { repeat: true }, 'variant-dir': {} });
  const c = await loadCaseFolder(required(a, 'case', GRADE_USAGE));
  const log = (l: string) => io.err(l);
  let runs = flagList(a, 'run').map((r) => resolve(r));
  const variantDir = flag(a, 'variant-dir');
  if (variantDir) runs.push(...(await runDirs(resolve(variantDir))));
  if (runs.length === 0 && c.manifest.mode === 'trace_review') {
    const { summary } = await gradeRecorded({ c, deps, log });
    io.out(summaryTable(summary));
    return summary.runs.at(-1)?.infra_ok ? 0 : 1;
  }
  if (runs.length === 0) {
    for (const e of await readdir(resolve(c.dir, CASE_RUNS_DIR), { withFileTypes: true })) if (e.isDirectory()) runs.push(...(await runDirs(resolve(c.dir, CASE_RUNS_DIR, e.name))));
  }
  if (runs.length === 0) throw new CliError(`no run to grade in ${c.dir}: run a variant first (tma eval run)`);
  runs = [...new Set(runs)];
  const summaries = await regrade({ c, runs, deps, log });
  for (const s of summaries) io.out(summaryTable(s));
  return summaries.every((s) => s.runs.every((r) => r.infra_ok)) ? 0 : 1;
}

async function trajectoryMain(argv: string[], io: Io): Promise<number> {
  const a = parseArgs(argv, { from: {}, out: {}, root: { repeat: true } });
  const from = required(a, 'from', TRAJECTORY_USAGE);
  if (a.positionals.length !== 1) throw new CliError(TRAJECTORY_USAGE);
  const input = resolve(a.positionals[0]!);
  let trajectory;
  if (from === 'claude-code') {
    const text = await readFile(input, 'utf-8').catch(() => null);
    if (text === null) throw new CliError(`cannot read ${input}`);
    const r = readClaudeCodeSession(text, { redact: { roots: flagList(a, 'root').map((x) => resolve(x)) } });
    trajectory = r.trajectory;
    if (r.skipped > 0) io.err(`[tma eval] ${r.skipped} line(s) were not JSON and were skipped`);
  } else if (from === 'opencode') {
    const file = input.endsWith('.json') ? input : resolve(input, 'run.json');
    const run = JSON.parse((await readFile(file, 'utf-8').catch(() => 'null')) ?? 'null') as { agent?: { actions?: RunAction[] } } | null;
    if (!run?.agent?.actions) throw new CliError(`${file} is not the run.json of an agent run (no agent.actions)`);
    trajectory = trajectoryFromActions(run.agent.actions);
    if (!trajectory) throw new CliError(`${file}: the actions have no structural fields (a run of an older runner)`);
  } else throw new CliError(`--from must be claude-code or opencode\n${TRAJECTORY_USAGE}`);
  const out = flag(a, 'out');
  const text = `${JSON.stringify(trajectory, null, 2)}\n`;
  if (out) {
    await writeFile(resolve(out), text, 'utf-8');
    io.out(`${trajectoryLine(trajectory)}\nwritten to ${resolve(out)}`);
  } else io.out(text.trimEnd());
  return 0;
}

async function uploadMain(argv: string[], io: Io, deps: EvalDeps): Promise<number> {
  const a = parseArgs(argv, { case: {}, 'variant-dir': {}, agent: {}, 'base-agent': {}, 'dry-run': { boolean: true } });
  const c = await loadCaseFolder(required(a, 'case', UPLOAD_USAGE));
  const agentId = checkAgentId(required(a, 'agent', UPLOAD_USAGE));
  let dirs = flag(a, 'variant-dir') ? [resolve(flag(a, 'variant-dir')!)] : [];
  if (dirs.length === 0) {
    dirs = await variantFolders(c.dir);
    if (dirs.length !== 1) throw new CliError(`give --variant-dir: the case has ${dirs.length} variant folders\n${UPLOAD_USAGE}`);
  }
  let baseAgent;
  const baseFile = flag(a, 'base-agent');
  if (baseFile) {
    const raw = await readFile(resolve(baseFile), 'utf-8').catch(() => null);
    if (raw === null) throw new CliError(`cannot read ${baseFile}`);
    try {
      baseAgent = baseAgentFrom(JSON.parse(raw), baseFile);
    } catch (e) {
      if (e instanceof SyntaxError) throw new CliError(`${baseFile} is not JSON`);
      throw e;
    }
  }
  const body = await buildEvalUpload({ c, variantDir: dirs[0]!, agentId, baseAgent });
  const env = deps.env ?? process.env;
  const base = apiUrl(env);
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const dryRun = has(a, 'dry-run');
  let token: string | undefined;
  if (dryRun) {
    const s = loadSessionFile(env);
    token = s && s.api_url === base && Date.parse(s.expires_at) > nowMs ? s.session_token : undefined;
  } else token = requireSession(base, nowMs, env).session_token;
  const label = `${body.case.case_key} / ${body.variant.label}`;
  io.err(`[tma eval] ${label}: ${body.runs.length} run(s), mean score ${body.summary.score}, agent ${agentSha(body).slice(0, 12)}, variant ${body.variant.variant_sha256.slice(0, 12)}`);
  if (dryRun) {
    io.err('dry run: this is exactly what tma eval upload sends:');
    io.out(JSON.stringify(body, null, 2));
    if (!token) {
      io.err('You are not logged in, so the API checks are skipped. Run tma login, then tma eval upload --dry-run again.');
      return 0;
    }
  }
  const r = await postResult({ base, body, label, dryRun, token, fetchImpl: deps.fetchImpl, io });
  return r.ok ? 0 : 1;
}

async function diffMain(argv: string[], io: Io): Promise<number> {
  const a = parseArgs(argv, {});
  if (a.positionals.length !== 2) throw new CliError(DIFF_USAGE);
  io.out(await evalDiff(resolve(a.positionals[0]!), resolve(a.positionals[1]!)));
  return 0;
}

export function makeEvalCommand(deps: EvalDeps = {}): Command {
  return {
    name: 'eval',
    summary: 'The eval kit: case folder, run a variant N times, grade by id@version, diff, trajectory, upload',
    usage: USAGE,
    async main(argv, io) {
      const [sub, ...rest] = argv;
      switch (sub) {
        case 'case':
          return caseMain(rest, io);
        case 'run':
          return runMain(rest, io, deps);
        case 'grade':
          return gradeMain(rest, io, deps);
        case 'diff':
          return diffMain(rest, io);
        case 'trajectory':
          return trajectoryMain(rest, io);
        case 'upload':
          return uploadMain(rest, io, deps);
        default:
          throw new CliError(`${sub ? `unknown eval command: ${sub}` : 'give an eval command'}\n${USAGE}`);
      }
    },
  };
}

export const evalCommand: Command = makeEvalCommand();

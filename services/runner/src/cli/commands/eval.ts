// `tma eval case|run|grade|diff|trajectory|upload|grader prove|judge calibrate` (plan 20261112-tma-c3-eval-repo-kit-docs T3, T4, ADR-4): the eval kit.
// A case manifest (tma-case/1, from the private eval repo) becomes a case folder on the host; a variant
// runs N times in the TMA sandbox; the case graders grade each run by id@version; diff compares a
// variant with the baseline. Everything stays on the host until `tma eval upload` (T4) sends the numbers,
// the digests and the structural trajectory (tma-local-result/2). `tma eval trajectory` reads a harness
// trace into a tma-trajectory/1 record with redacted targets.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { flag, flagList, has, numberFlag, parseArgs, required, type ParsedArgs } from '../args.js';
import type { Command, Io } from '../command.js';
import { apiUrl, CliError } from '../env.js';
import { checkAgentId } from '../result.js';
import { loadSessionFile, requireSession } from '../session.js';
import { postResult } from './upload.js';
import { agentSha, baseAgentFrom, buildEvalUpload, variantFolders } from '../eval/upload.js';
import { buildTraceReviewUpload, claudeCodeSessionFacts, readHumanLabel } from '../eval/trace-review.js';
import { readClaudeCodeSession, trajectoryFromActions, trajectoryLine } from '../eval/trajectory.js';
import type { LocalResultV2Plus } from '@itera/contracts';
import type { RunAction } from '../../types.js';
import { buildCaseFolder, CASE_RUNS_DIR, loadCaseFolder } from '../eval/case.js';
import { evalDiff } from '../eval/diff.js';
import { gradeRecorded, regrade, runDirs, runVariant, summaryTable, type EvalDeps } from '../eval/runs.js';
import { readVariant } from '../eval/variant.js';
import { dryRunGrade } from '../eval/dry-run.js';
import { proveGrader } from '../eval/prove.js';
import { calibrateJudge } from '../eval/calibrate.js';
import type { JudgeFn } from '../eval/judge.js';

/** The deps of the eval command: the run deps plus the judge of `tma eval judge calibrate`. */
export interface EvalCommandDeps extends EvalDeps {
  /** The JudgeFn of `tma eval judge calibrate` (a test passes a fake; the default does not measure). */
  judgeFn?: JudgeFn;
}

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

const GRADE_USAGE = `usage: tma eval grade --case <case dir> [--run <run dir>]... [--variant-dir <dir>] [--dry-run [--trace <file>]]
  Grades again with the case graders and ADDS a grading to each run (the old ones stay).
  No --run and no --variant-dir: a trace_review case grades its recorded output; a replay case re-grades every run.
  --dry-run  prints the verdict as JSON (tma-eval-dry-run/1) and writes nothing: no file in the case folder,
             no network call. --trace <file> grades one output file instead of the recorded output or the runs.`;

const GRADER_PROVE_USAGE = `usage: tma eval grader prove <grader dir> [--out <proof.json>] [--timeout <seconds>] [-- <grader argv>...]
  Proves that a library grader (graders/<id>/<semver>/) catches its planted bugs: runs the grader command once per
  fixture (fixtures/mutation-*/, or the list in fixtures/code-mutations.json) as <argv> <fixture dir>, no shell,
  cwd = the grader folder. The grader prints {"pass": true|false} on its last stdout line; a planted bug must not
  pass. A crash, a timeout or no answer is a miss. Writes proof.json (ids, counts, digests): caught, total.
  The command: the argv after --, else "command" in grader.json, else python3 grade.py. Exit 0 only when caught = total.`;

const JUDGE_CALIBRATE_USAGE = `usage: tma eval judge calibrate --judge <id> --version <semver> --model <model id> [--repo <eval repo>]
                                [--labels-dir <dir>] [--judges-dir <dir>] [--public-set]
  Measures the judge against the human labels sets/calibration/<id>/{train,dev,test}.jsonl ({"id","label"} lines)
  and writes judges/<id>/<semver>/calibration.json {n_labels, n_test, tp, fn, tn, fp, realigned_at}.
  The judge answers the test split; the rubric is judges/<id>/<semver>/rubric.md. The case set is private by
  default: a judge model outside the private-text list (A11 Q1 = B) is refused. --public-set lifts that.`;

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
       tma eval upload --mode trace_review --case <case dir> --session <session.jsonl> --agent <agent id>
                       [--base-agent <file>] [--label-file <label.json>] [--label-only] [--variant-label <text>] [--root <dir>]... [--dry-run]
  Sends the runs of ONE variant as one tma-local-result/2 body (numbers, digests, grader rows, trajectory)
  to POST /self-declared-results. --dry-run prints the body and asks the API with ?dry_run=1 when logged in.
  --base-agent  the base agent version (the 8 fields of variant.agent, or a tma-pin/1). Default: the case pin,
                else the agent folder of an agent variant (trace_review: else the harness and model of the session).
  --mode trace_review  a RECORDED Claude Code session of a trace_review case: no agent runs. ONE run (repeat 1) of the
                variant "recorded session" (the baseline: change_kind none, no prediction), with the redacted
                trajectory of the session and the latest tma eval grade of the recorded output, if any.
  --label-file  a human label {grader_id, version, pass, score?, labeler?, reason_code?, code_sha256?}: one grader
                result of kind human (decisive only when the case lists that grader at that version). labeler or
                reason_code makes the body tma-local-result/3.
  --label-only  send the human grader only (add a label to a run already uploaded: the API adds one grader row).`;

const USAGE = [
  'usage: tma eval <case|run|grade|diff|trajectory|upload|grader prove|judge calibrate> ...   (the eval kit: plan C3)',
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
  '',
  GRADER_PROVE_USAGE,
  '',
  JUDGE_CALIBRATE_USAGE,
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
  if (lock.mode === 'trace_review') {
    next(io, `tma eval grade --case ${dest}`);
    next(io, `tma eval upload --mode trace_review --case ${dest} --session <session.jsonl> --agent <agent id> [--label-file <label.json>]`);
  }
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
  const a = parseArgs(argv, { case: {}, run: { repeat: true }, 'variant-dir': {}, 'dry-run': { boolean: true }, trace: {} });
  const c = await loadCaseFolder(required(a, 'case', GRADE_USAGE));
  const log = (l: string) => io.err(l);
  let runs = flagList(a, 'run').map((r) => resolve(r));
  const variantDir = flag(a, 'variant-dir');
  if (variantDir) runs.push(...(await runDirs(resolve(variantDir))));
  const trace = flag(a, 'trace');
  if (trace && !has(a, 'dry-run')) throw new CliError(`--trace needs --dry-run\n${GRADE_USAGE}`);
  if (has(a, 'dry-run')) {
    if (trace && runs.length > 0) throw new CliError(`give --trace or --run/--variant-dir, not both\n${GRADE_USAGE}`);
    io.err('[tma eval] dry run: nothing is written and nothing is sent');
    const verdict = await dryRunGrade({ c, runs, trace, deps, log });
    io.out(JSON.stringify(verdict, null, 2));
    return verdict.outputs.every((o) => o.case.infra_ok) ? 0 : 1;
  }
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

async function readJsonFile(file: string): Promise<unknown> {
  const raw = await readFile(resolve(file), 'utf-8').catch(() => null);
  if (raw === null) throw new CliError(`cannot read ${file}`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError(`${file} is not JSON`);
  }
}

/** The body of a recorded session on a trace_review case (C3-T9). */
async function traceReviewBody(a: ParsedArgs, c: Awaited<ReturnType<typeof loadCaseFolder>>, agentId: string, io: Io): Promise<LocalResultV2Plus> {
  if (flag(a, 'variant-dir')) throw new CliError('--variant-dir is for a replay case; --mode trace_review uploads --session <session.jsonl>');
  const sessionFile = required(a, 'session', UPLOAD_USAGE);
  const text = await readFile(resolve(sessionFile), 'utf-8').catch(() => null);
  if (text === null) throw new CliError(`cannot read ${sessionFile}`);
  const r = readClaudeCodeSession(text, { redact: { roots: flagList(a, 'root').map((x) => resolve(x)) } });
  if (r.skipped > 0) io.err(`[tma eval] ${r.skipped} line(s) of the session were not JSON and were skipped`);
  const baseFile = flag(a, 'base-agent');
  const labelFile = flag(a, 'label-file');
  const { body, notes } = await buildTraceReviewUpload({
    c,
    agentId,
    trajectory: r.trajectory,
    session: claudeCodeSessionFacts(text),
    baseAgent: baseFile ? baseAgentFrom(await readJsonFile(baseFile), baseFile) : undefined,
    label: labelFile ? readHumanLabel(await readJsonFile(labelFile), labelFile) : undefined,
    labelOnly: has(a, 'label-only'),
    variantLabel: flag(a, 'variant-label'),
  });
  for (const n of notes) io.err(`[tma eval] ${n}`);
  io.err(`[tma eval] trajectory: ${trajectoryLine(r.trajectory)}`);
  return body;
}

async function uploadMain(argv: string[], io: Io, deps: EvalDeps): Promise<number> {
  const a = parseArgs(argv, {
    case: {}, 'variant-dir': {}, agent: {}, 'base-agent': {}, 'dry-run': { boolean: true },
    mode: {}, session: {}, 'label-file': {}, 'label-only': { boolean: true }, 'variant-label': {}, root: { repeat: true },
  });
  const c = await loadCaseFolder(required(a, 'case', UPLOAD_USAGE));
  const agentId = checkAgentId(required(a, 'agent', UPLOAD_USAGE));
  const mode = flag(a, 'mode') ?? 'replay';
  if (mode !== 'replay' && mode !== 'trace_review') throw new CliError(`--mode must be replay or trace_review\n${UPLOAD_USAGE}`);
  if (mode !== c.manifest.mode) throw new CliError(`case ${c.manifest.case_key} is a ${c.manifest.mode} case: give --mode ${c.manifest.mode}`);
  let body: LocalResultV2Plus;
  if (mode === 'trace_review') body = await traceReviewBody(a, c, agentId, io);
  else {
    for (const k of ['session', 'label-file', 'label-only', 'variant-label']) if (has(a, k)) throw new CliError(`--${k} is for --mode trace_review`);
    let dirs = flag(a, 'variant-dir') ? [resolve(flag(a, 'variant-dir')!)] : [];
    if (dirs.length === 0) {
      dirs = await variantFolders(c.dir);
      if (dirs.length !== 1) throw new CliError(`give --variant-dir: the case has ${dirs.length} variant folders\n${UPLOAD_USAGE}`);
    }
    const baseFile = flag(a, 'base-agent');
    const baseAgent = baseFile ? baseAgentFrom(await readJsonFile(baseFile), baseFile) : undefined;
    body = await buildEvalUpload({ c, variantDir: dirs[0]!, agentId, baseAgent });
  }
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
  io.err(`[tma eval] ${label}: ${body.format}, ${body.runs.length} run(s), mean score ${body.summary.score}, agent ${agentSha(body).slice(0, 12)}, variant ${body.variant.variant_sha256.slice(0, 12)}`);
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

async function graderMain(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'prove') throw new CliError(`${sub ? `unknown eval grader command: ${sub}` : 'give an eval grader command'}\n${GRADER_PROVE_USAGE}`);
  const a = parseArgs(rest, { out: {}, timeout: {} });
  const [dir, ...cmd] = a.positionals;
  if (!dir) throw new CliError(GRADER_PROVE_USAGE);
  const timeout = numberFlag(a, 'timeout', { min: 1, max: 3600 });
  const { proof, file } = await proveGrader({ graderDir: dir, argv: cmd, out: flag(a, 'out'), timeoutMs: timeout === undefined ? undefined : timeout * 1000, log: (l) => io.err(l) });
  io.out(`grader ${proof.grader.id}@${proof.grader.version} (code ${proof.grader.code_sha256.slice(0, 12)}): caught ${proof.caught} of ${proof.total} planted bugs`);
  io.out(`proof: ${file}`);
  if (proof.reason) io.out(`proof is red: ${proof.reason}`);
  return proof.ok ? 0 : 1;
}

async function judgeMain(argv: string[], io: Io, deps: EvalCommandDeps): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'calibrate') throw new CliError(`${sub ? `unknown eval judge command: ${sub}` : 'give an eval judge command'}\n${JUDGE_CALIBRATE_USAGE}`);
  const a = parseArgs(rest, { judge: {}, version: {}, model: {}, repo: {}, 'labels-dir': {}, 'judges-dir': {}, 'public-set': { boolean: true } });
  const r = await calibrateJudge({
    repo: flag(a, 'repo') ?? process.cwd(),
    judgeId: required(a, 'judge', JUDGE_CALIBRATE_USAGE),
    version: required(a, 'version', JUDGE_CALIBRATE_USAGE),
    model: required(a, 'model', JUDGE_CALIBRATE_USAGE),
    publicSet: has(a, 'public-set'),
    labelsDir: flag(a, 'labels-dir'),
    judgesDir: flag(a, 'judges-dir'),
    judgeFn: deps.judgeFn,
    now: deps.now,
  });
  const k = r.calibration;
  io.out(`judge calibration: n_labels ${k.n_labels}, n_test ${k.n_test}, tp ${k.tp} fn ${k.fn} tn ${k.tn} fp ${k.fp}`);
  io.out(r.gate === null ? 'gate: decisive allowed (TPR and TNR >= 0.90)' : `gate: side signal only (${r.gate})`);
  io.out(`written to ${r.file}`);
  return 0;
}

async function diffMain(argv: string[], io: Io): Promise<number> {
  const a = parseArgs(argv, {});
  if (a.positionals.length !== 2) throw new CliError(DIFF_USAGE);
  io.out(await evalDiff(resolve(a.positionals[0]!), resolve(a.positionals[1]!)));
  return 0;
}

export function makeEvalCommand(deps: EvalCommandDeps = {}): Command {
  return {
    name: 'eval',
    summary: 'The eval kit: case folder, run a variant N times, grade by id@version, diff, trajectory, upload, grader prove, judge calibrate',
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
        case 'grader':
          return graderMain(rest, io);
        case 'judge':
          return judgeMain(rest, io, deps);
        default:
          throw new CliError(`${sub ? `unknown eval command: ${sub}` : 'give an eval command'}\n${USAGE}`);
      }
    },
  };
}

export const evalCommand: Command = makeEvalCommand();

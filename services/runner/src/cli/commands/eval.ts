// `tma eval case|run|grade|diff` (plan 20261112-tma-c3-eval-repo-kit-docs T3, ADR-4): the eval kit.
// A case manifest (tma-case/1, from the private eval repo) becomes a case folder on the host; a variant
// runs N times in the TMA sandbox; the case graders grade each run by id@version; diff compares a
// variant with the baseline. Everything stays on the host; `tma eval upload` (T4) sends the numbers.
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { flag, flagList, has, numberFlag, parseArgs, required } from '../args.js';
import type { Command, Io } from '../command.js';
import { CliError } from '../env.js';
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

const USAGE = [
  'usage: tma eval <case|run|grade|diff> ...   (the eval kit: plan C3)',
  '',
  CASE_USAGE,
  '',
  RUN_USAGE,
  '',
  GRADE_USAGE,
  '',
  DIFF_USAGE,
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

async function diffMain(argv: string[], io: Io): Promise<number> {
  const a = parseArgs(argv, {});
  if (a.positionals.length !== 2) throw new CliError(DIFF_USAGE);
  io.out(await evalDiff(resolve(a.positionals[0]!), resolve(a.positionals[1]!)));
  return 0;
}

export function makeEvalCommand(deps: EvalDeps = {}): Command {
  return {
    name: 'eval',
    summary: 'The eval kit: build a case folder, run a variant N times, grade by grader id@version, diff vs the baseline',
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
        default:
          throw new CliError(`${sub ? `unknown eval command: ${sub}` : 'give an eval command'}\n${USAGE}`);
      }
    },
  };
}

export const evalCommand: Command = makeEvalCommand();

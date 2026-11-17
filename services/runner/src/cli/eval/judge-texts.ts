// `tma eval judge texts` (plan 20261112-tma-c6-judge-calibration, task C6-FOLD): build the texts that
// `tma eval judge calibrate --texts-dir` reads, on the host that holds the sessions.
//
// Per review-batch row it streams the Claude Code session (a session file can be hundreds of MB), folds it with the
// profile of the judge (judge-text.ts) to the alien01 budget of that judge version (the relay limit of 12,288 bytes minus
// the system text and the judge prompt with its rubric, at most ALIEN01_MAX_TEXT_CHARS), and writes <out>/<name>.txt
// (folder mode 700, file mode 600). The name is the run id of the labels file when one is given (calibrate reads the
// label ids), else the case key. The command prints counts and digests only: no text of a run reaches the output.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { flag, parseArgs, required } from '../args.js';
import type { Io } from '../command.js';
import { CliError } from '../env.js';
import { judgeInstruction } from './calibrate.js';
import { alien01TextBudget, ALIEN01_RELAY_PROMPT_MAX_BYTES, judgePromptBytes } from './judge-runner.js';
import { FOLD_JUDGES, FOLD_MIN_BUDGET, foldSession, isFoldJudge, sessionReader, type FoldResult } from './judge-text.js';
import { parseReviewBatch, type ReviewBatchRow } from './review-batch.js';

export const JUDGE_TEXTS_USAGE = `usage: tma eval judge texts --judge <id> --version <semver> --batch <rows.jsonl> --out <dir>
                            [--repo <eval repo> | --judges-dir <dir>] [--labels <labels.jsonl>] [--budget <bytes>]
  Folds the Claude Code session of each tma-review-batch/1 row into the text that "tma eval judge calibrate
  --texts-dir" reads. The fold keeps the task prompt, the final report and the timeline events that the judge rubric
  names (${FOLD_JUDGES.join(', ')}); it elides the rest with markers and counts per kind.
  Same session and judge version => the same bytes. The budget is the alien01 relay limit (${ALIEN01_RELAY_PROMPT_MAX_BYTES} bytes
  per prompt) minus the judge prompt and its rubric (judges/<id>/<semver>/prompt.md + rubric.md); --budget may lower it.
  --labels  the output of "tma eval judge labels": each labeled run is written as <run_id>.txt (the label id that
            calibrate reads); rows with no labeled run are skipped. Without it, <case_key>.txt.
  The texts are private: the folder is mode 700, each file mode 600. Prints counts and digests only.`;

/** Stream a session file into the fold reader, line by line. */
export async function foldSessionFile(file: string, judge: (typeof FOLD_JUDGES)[number], budget: number, summary: ReviewBatchRow['task_summary']): Promise<FoldResult> {
  const reader = sessionReader();
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) if (line.length > 0) reader.push(line);
  return foldSession(reader.finish(), judge, budget, summary);
}

/** case key -> the run ids of the labels file (rows of tma eval judge labels: {run_id, case_key, judge_id, ...}). */
function runIdsByCase(text: string, source: string, judge: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line);
    } catch {
      throw new CliError(`${source}:${i + 1} is not JSON`);
    }
    if (typeof r.run_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.run_id) || typeof r.case_key !== 'string') {
      throw new CliError(`${source}:${i + 1}: a labels row needs run_id (a uuid) and case_key`);
    }
    if (r.judge_id !== undefined && r.judge_id !== judge) throw new CliError(`${source}:${i + 1}: judge_id ${String(r.judge_id).slice(0, 64)} is not ${judge}`);
    const ids = out.get(r.case_key) ?? [];
    if (!ids.includes(r.run_id)) ids.push(r.run_id);
    out.set(r.case_key, ids);
  });
  return out;
}

export async function judgeTextsMain(argv: string[], io: Io): Promise<number> {
  const a = parseArgs(argv, { judge: {}, version: {}, batch: {}, out: {}, repo: {}, 'judges-dir': {}, labels: {}, budget: {} });
  const judge = required(a, 'judge', JUDGE_TEXTS_USAGE);
  const version = required(a, 'version', JUDGE_TEXTS_USAGE);
  if (!isFoldJudge(judge)) throw new CliError(`judge ${judge.slice(0, 80)} has no fold profile (one of: ${FOLD_JUDGES.join(', ')})`);
  if (!/^[A-Za-z0-9_.+-]{1,40}$/.test(version) || version.startsWith('.')) throw new CliError(`bad judge version: ${version.slice(0, 40)}`);
  const batchFile = resolve(required(a, 'batch', JUDGE_TEXTS_USAGE));
  const outDir = resolve(required(a, 'out', JUDGE_TEXTS_USAGE));
  const judgesDir = resolve(flag(a, 'judges-dir') ?? join(resolve(flag(a, 'repo') ?? process.cwd()), 'judges'));
  const dir = join(judgesDir, judge, version);
  const rubric = await readFile(join(dir, 'rubric.md'), 'utf-8').catch(() => null);
  if (rubric === null) throw new CliError(`no rubric: ${join(dir, 'rubric.md')}`);
  const prompt = await readFile(join(dir, 'prompt.md'), 'utf-8').catch(() => null);
  const instruction = judgeInstruction(prompt, rubric);
  let budget = alien01TextBudget(instruction);
  const asked = flag(a, 'budget');
  if (asked !== undefined) {
    const n = Number(asked);
    if (!/^\d{1,6}$/.test(asked) || n < FOLD_MIN_BUDGET || n > budget) throw new CliError(`--budget must be an integer from ${FOLD_MIN_BUDGET} to ${budget} (the relay limit minus this judge's prompt)`);
    budget = n;
  }
  if (budget < FOLD_MIN_BUDGET) throw new CliError(`the judge prompt leaves ${budget} bytes of the ${ALIEN01_RELAY_PROMPT_MAX_BYTES}-byte relay limit: under ${FOLD_MIN_BUDGET}`);

  const batchText = await readFile(batchFile, 'utf-8').catch(() => null);
  if (batchText === null) throw new CliError(`cannot read ${batchFile}`);
  const rows = parseReviewBatch(batchText, batchFile);
  const labelsFile = flag(a, 'labels');
  let names: Map<string, string[]> | null = null;
  if (labelsFile) {
    const t = await readFile(resolve(labelsFile), 'utf-8').catch(() => null);
    if (t === null) throw new CliError(`cannot read ${resolve(labelsFile)}`);
    names = runIdsByCase(t, resolve(labelsFile), judge);
  }

  await mkdir(outDir, { recursive: true, mode: 0o700 });
  await chmod(outDir, 0o700);
  let written = 0, skipped = 0, failed = 0, maxBytes = 0, maxPrompt = 0, rubricEvents = 0, rubricKept = 0, allKept = 0;
  const digests: string[] = [];
  for (const row of rows) {
    const targets = names ? (names.get(row.case_key) ?? []) : [row.case_key];
    if (targets.length === 0) {
      skipped++;
      continue;
    }
    let f: FoldResult;
    try {
      f = await foldSessionFile(row.session_file, judge, budget, row.task_summary);
    } catch {
      failed++;
      io.err(`unreadable session: case ${row.case_key}`);
      continue;
    }
    maxBytes = Math.max(maxBytes, f.bytes);
    maxPrompt = Math.max(maxPrompt, judgePromptBytes(instruction, '', f.text));
    rubricEvents += f.rubricEvents;
    rubricKept += f.rubricKept;
    if (f.rubricKept === f.rubricEvents) allKept++;
    for (const name of targets) {
      await writeFile(join(outDir, `${name}.txt`), f.text, { encoding: 'utf-8', mode: 0o600 });
      await chmod(join(outDir, `${name}.txt`), 0o600);
      digests.push(`${name} ${f.sha256}`);
      written++;
    }
  }
  digests.sort();
  const setDigest = createHash('sha256').update(`${digests.join('\n')}\n`).digest('hex');
  io.out(`judge texts (${judge}@${version}): ${written} written, ${skipped} row(s) with no labeled run, ${failed} unreadable session(s)`);
  io.out(`budget ${budget} bytes per text; largest text ${maxBytes} bytes; largest prompt ${maxPrompt} of ${ALIEN01_RELAY_PROMPT_MAX_BYTES} bytes`);
  io.out(`rubric events kept as a line: ${rubricKept} of ${rubricEvents}; runs with every rubric event kept: ${allKept} of ${rows.length - skipped - failed}`);
  io.out(`set digest: ${setDigest}`);
  return failed > 0 ? 1 : 0;
}

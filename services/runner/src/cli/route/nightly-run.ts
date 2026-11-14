// The default run path of `tma route nightly` (plan 20261112-tma-c8-routing-from-evals, T6): for each golden case,
// build the case folder (as `tma eval case`), run ONE agent variant --repeat times in the TMA sandbox (as
// `tma eval run`), and upload the runs (as `tma eval upload`) so that they become TMA run rows that the budget
// counter reads. The tests replace this whole function with a fake (RunGolden): it is the only part that runs a model.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Route } from '@itera/contracts';
import type { Fetch } from '../api.js';
import type { Io } from '../command.js';
import { postResult } from '../commands/upload.js';
import { buildCaseFolder, loadCaseFolder } from '../eval/case.js';
import { runVariant } from '../eval/runs.js';
import { buildEvalUpload } from '../eval/upload.js';
import { readVariant } from '../eval/variant.js';
import type { GoldenCase, GoldenRun } from './nightly.js';

export interface RunGoldenInput {
  route: Route;
  cases: readonly GoldenCase[];
  repeat: number;
  /** <work-dir>/<route id8>/<night stamp>: a new folder per night (a case folder must be new). */
  routeDir: string;
  agentDir: string;
  taskDir?: string;
  /** The TMA agent of the upload (`tma eval upload --agent`). */
  agentId: string;
  base: string;
  token: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: Fetch;
  log: (line: string) => void;
}

export interface RunGoldenResult {
  runs: GoldenRun[];
  /** Runs that ran (or may have run) and did not upload. */
  unuploadedRuns: number;
  /** True when the API refused (or the kit could not send) an upload: exit 3. */
  uploadFailed: boolean;
  /** Per-case failures: a route with an error gets no verdict. */
  errors: string[];
}

export type RunGolden = (input: RunGoldenInput) => Promise<RunGoldenResult>;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 200);

export const defaultRunGolden: RunGolden = async (input) => {
  const out: RunGoldenResult = { runs: [], unuploadedRuns: 0, uploadFailed: false, errors: [] };
  await mkdir(input.routeDir, { recursive: true });
  const variantFile = join(input.routeDir, 'variant.json');
  await writeFile(
    variantFile,
    `${JSON.stringify({
      schema: 'tma-variant/1',
      label: `nightly ${input.route.id.slice(0, 8)}`,
      kind: 'agent',
      agent: { agent_dir: input.agentDir, model: input.route.model_id },
      change_kind: 'none',
      is_baseline: true,
      prediction: null,
    }, null, 2)}\n`,
    'utf-8',
  );
  const io: Io = { out: (t) => input.log(t), err: (t) => input.log(t) };
  // Fixed order: the order of the golden file. The kit takes no seed.
  for (const g of input.cases) {
    const dest = join(input.routeDir, g.case_key);
    let c;
    let v;
    try {
      await buildCaseFolder({ caseFile: g.file, dest, taskDir: input.taskDir });
      c = await loadCaseFolder(dest);
      v = await readVariant(variantFile);
    } catch (e) {
      out.errors.push(`${g.case_key}: ${msg(e)}`);
      continue; // nothing ran for this case
    }
    let variantDir: string;
    try {
      const r = await runVariant({ c, v, repeat: input.repeat, deps: { env: input.env }, log: input.log });
      variantDir = r.variantDir;
      for (const row of r.summary.runs.slice(-input.repeat)) {
        const hard = new Set(c.manifest.graders.filter((x) => x.hard_gate).map((x) => x.id));
        out.runs.push({ case_key: g.case_key, score: row.score, infraOk: row.infra_ok, hardGatesOk: row.graders.filter((x) => hard.has(x.id)).every((x) => x.pass) });
      }
    } catch (e) {
      // A failure inside the run: some runs may have spent money. Fail closed: count them as not uploaded.
      out.errors.push(`${g.case_key}: ${msg(e)}`);
      out.unuploadedRuns += input.repeat;
      continue;
    }
    try {
      const body = await buildEvalUpload({ c, variantDir, agentId: input.agentId });
      const label = `${g.case_key} / ${body.variant.label}`;
      const r = await postResult({ base: input.base, body, label, dryRun: false, token: input.token, fetchImpl: input.fetchImpl, io });
      if (!r.ok) {
        out.unuploadedRuns += input.repeat;
        out.uploadFailed = true;
      }
    } catch (e) {
      input.log(`[tma route nightly] ${g.case_key}: upload failed: ${msg(e)}`);
      out.unuploadedRuns += input.repeat;
      out.uploadFailed = true;
    }
  }
  return out;
};

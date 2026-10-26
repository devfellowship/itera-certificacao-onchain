// `tma grade --task|--task-dir ... --workspace <dir> --agent <id> --model <id> [--wall-s N] [--cost-usd N] --out result.json`
// Grade a workspace that YOUR harness edited. The patch is the diff of the workspace against a fresh
// baseline of the task (built here, never read from the workspace). The grader is the hosted one (the
// same sandbox containers). Wall time and cost are what you report. Needs Docker.
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { flag, numberFlag, parseArgs, required } from '../args.js';
import type { Command } from '../command.js';
import { CliError } from '../env.js';
import { DEFAULT_RUNS_DIR, defaultGrade, gradeWorkspace, prepareSandbox, type LocalDeps } from '../local.js';
import { buildLocalResult, checkAgentId, executorOf, resultTable, RUNNER_VERSION, writeResultFile } from '../result.js';
import { selectTasks, TASK_FLAGS } from '../tasks.js';
import { checkModelId } from './run.js';

const USAGE = `usage: tma grade --task <slug> | --task-dir <folder>  --workspace <dir>  --agent <id>  --model <id>
                 [--wall-s N] [--cost-usd N] [--harness <name>] [--out result.json] [--runs-dir ${DEFAULT_RUNS_DIR}]
  Grades the folder that "tma workspace" wrote and your harness edited. Writes result.json
  (tma-local-result/1: numbers only). The patch stays in ${DEFAULT_RUNS_DIR}/<run-id>/ on this machine.
  --wall-s and --cost-usd are what your harness spent; they are self-declared. Without them the result says null.`;

export function makeGradeCommand(deps: LocalDeps = {}): Command {
  return {
    name: 'grade',
    summary: 'Grade a workspace that your own harness edited (sandboxed grader, patch from a fresh baseline)',
    usage: USAGE,
    async main(argv, io) {
      const a = parseArgs(argv, { ...TASK_FLAGS, workspace: {}, agent: {}, model: {}, 'wall-s': {}, 'cost-usd': {}, harness: {}, out: {}, 'runs-dir': {} });
      const { items, ref } = await selectTasks(a, { warn: io.err });
      if (items.length !== 1) throw new CliError('tma grade takes ONE task folder (one workspace)');
      const agentId = checkAgentId(required(a, 'agent', USAGE));
      const model = checkModelId(required(a, 'model', USAGE));
      const workspace = resolve(required(a, 'workspace', USAGE));
      if (!(await stat(workspace).catch(() => null))?.isDirectory()) throw new CliError(`no workspace folder at ${workspace}`);
      const wallS = numberFlag(a, 'wall-s', { min: 0, max: 86_400 });
      const costUsd = numberFlag(a, 'cost-usd', { min: 0, max: 1000 });
      const harness = flag(a, 'harness') ?? 'external';
      const out = flag(a, 'out') ?? 'result.json';
      const log = (line: string) => io.err(line);

      const { config, imageId } = await prepareSandbox(deps, 'opencode', log);
      const now = deps.now ?? (() => new Date());
      const from = now();
      const outcome = await gradeWorkspace({
        r: items[0]!,
        workspaceDir: workspace,
        grade: deps.grade ?? defaultGrade,
        config,
        runsDir: flag(a, 'runs-dir') ?? DEFAULT_RUNS_DIR,
        reported: { wallS: wallS ?? null, costUsd: costUsd ?? null },
        log,
      });
      const result = buildLocalResult({
        agentId,
        task: ref,
        runner: { version: RUNNER_VERSION, execution: 'external', profile: null, sandbox_image_id: imageId },
        executor: executorOf({ modelId: model, harness, costSource: costUsd === undefined ? 'none' : 'reported' }),
        ranFrom: from,
        ranTo: now(),
        rows: [outcome.row],
      });
      await writeResultFile(out, result);
      io.out(resultTable(result));
      io.out(`result: ${out} (numbers only)   evidence for you: ${outcome.runDir}`);
      return outcome.row.status === 'infra_error' ? 1 : 0;
    },
  };
}

export const gradeCommand: Command = makeGradeCommand();

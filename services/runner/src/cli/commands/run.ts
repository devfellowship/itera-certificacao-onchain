// `tma run --task|--task-dir ... --agent <id> --agent-dir <dir> --model <id> [--profile opencode] [--repeat N] --out result.json`
// Run opencode in the TMA sandbox with YOUR model key, then grade, N times. The same sandbox, gateway
// and grader as the hosted worker. Needs Docker. Your key (OPENROUTER_API_KEY, or OPENCODE_GO_API_KEY
// for an opencode-go/<model>) goes only to the gateway container of the run.
import { readdirSync } from 'node:fs';
import { flag, numberFlag, parseArgs, required } from '../args.js';
import type { Command } from '../command.js';
import { CliError, userModelKey } from '../env.js';
import { checkAgentDir, combineCostSources, DEFAULT_RUNS_DIR, defaultGrade, prepareSandbox, redact, runItem, type LocalDeps } from '../local.js';
import { buildLocalResult, checkAgentId, costSourceOf, executorOf, resultTable, RUNNER_VERSION, writeResultFile, type ResultRow } from '../result.js';
import { selectTasks, refuseMcp, TASK_FLAGS } from '../tasks.js';
import { PROFILES_DIR } from '../../run-profile.js';
import { routeOfModel } from '../../model-route.js';
import { runAgent } from '../../agent-run.js';

const USAGE = `usage: tma run --task <slug> | --task-dir <folder> [--task-dir <folder> --slug <name>]
               --agent <id>  --agent-dir <dir>  --model <id>  [--profile opencode]  [--repeat 1-10]
               [--out result.json] [--runs-dir ${DEFAULT_RUNS_DIR}]
  Runs opencode in the sandbox with YOUR key, grades the patch, and writes result.json
  (tma-local-result/1: numbers only). The patch and the actions stay in ${DEFAULT_RUNS_DIR}/<run-id>/.
  --model   an OpenRouter id (anthropic/claude-sonnet-4.5) or opencode-go/<model>
  --agent-dir  holds AGENTS.md, CLAUDE.md and/or skills/ (the sandbox copies only those)
  Key: export OPENROUTER_API_KEY=...   (or OPENCODE_GO_API_KEY=... for opencode-go/<model>)`;

/** The model id pattern of the result contract (schemas/local-result.schema.json executor.model_id). */
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,31}(\/[a-z0-9][a-z0-9.-]{0,31})?\/[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export function checkModelId(model: string): string {
  if (!MODEL_ID.test(model)) throw new CliError(`--model "${model.slice(0, 80)}" is not a model id like anthropic/claude-sonnet-4.5 or opencode-go/<model>`);
  return model;
}

/** The built-in run profiles (profiles/*.json). v1 has `opencode`. */
export function builtinProfiles(): string[] {
  return readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

export function makeRunCommand(deps: LocalDeps = {}): Command {
  return {
    name: 'run',
    summary: 'Run opencode in the sandbox with your own model key, grade it, N times; writes result.json',
    usage: USAGE,
    async main(argv, io) {
      const a = parseArgs(argv, { ...TASK_FLAGS, agent: {}, 'agent-dir': {}, model: {}, profile: {}, repeat: {}, out: {}, 'runs-dir': {} });
      const { items, ref } = await selectTasks(a);
      const agentId = checkAgentId(required(a, 'agent', USAGE));
      const agentDir = await checkAgentDir(required(a, 'agent-dir', USAGE));
      const model = checkModelId(required(a, 'model', USAGE));
      const profile = flag(a, 'profile') ?? 'opencode';
      if (!builtinProfiles().includes(profile)) {
        throw new CliError(`unknown profile "${profile.slice(0, 40)}": the built-in profiles are ${builtinProfiles().join(', ')}`);
      }
      const repeat = numberFlag(a, 'repeat', { min: 1, max: 10, integer: true }) ?? 1;
      const out = flag(a, 'out') ?? 'result.json';
      for (const r of items) refuseMcp(r);

      // The key comes before Docker: a missing key is the first thing the user must fix.
      const route = routeOfModel(model, { openrouterUpstream: '', opencodeGoUpstream: '' }).route;
      const modelKey = userModelKey(route, deps.env);
      const log = (line: string) => io.err(redact(line, modelKey));

      const { config, imageId } = await prepareSandbox(deps, profile, log);
      const now = deps.now ?? (() => new Date());
      const from = now();
      const rows: ResultRow[] = [];
      const sources: Array<ReturnType<typeof costSourceOf> | null> = [];
      const runsDir = flag(a, 'runs-dir') ?? DEFAULT_RUNS_DIR;
      for (const r of items) {
        for (let n = 1; n <= repeat; n++) {
          const o = await runItem({ r, agentDir, model, modelKey, config, runAgent: deps.runAgent ?? runAgent, grade: deps.grade ?? defaultGrade, runsDir, repeat: n, log });
          rows.push(o.row);
          sources.push(o.costSource);
        }
      }
      const result = buildLocalResult({
        agentId,
        task: ref,
        runner: { version: RUNNER_VERSION, execution: 'tma-sandbox', profile, sandbox_image_id: imageId },
        executor: executorOf({ modelId: model, route, harness: profile, costSource: combineCostSources(sources) }),
        ranFrom: from,
        ranTo: now(),
        rows,
      });
      await writeResultFile(out, result);
      io.out(resultTable(result));
      io.out(`result: ${out} (numbers only)   evidence for you: ${runsDir}/<run-id>/`);
      return rows.some((r) => r.status === 'infra_error') ? 1 : 0;
    },
  };
}

export const runCommand: Command = makeRunCommand();

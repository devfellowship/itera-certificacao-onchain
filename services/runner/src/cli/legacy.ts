// Converts an old operator import file (`tma-bench-import/1`, `tma-bench-import/trajectory-1`, the
// format of the retired services/runner/src/bench-import.ts, deleted in plan ADR-3) into
// tma-local-result/1 bodies, one per executor (task L7). The per-run numbers and the summary are the
// `transcript-mining/1` and `trajectory/1` shapes of the contract, unchanged: only the envelope changes.
// The result goes through the same API door as every other local result.
import { isProviderKey, providerOf } from '@itera/contracts/model-catalog';
import type { LocalResult } from '@itera/contracts';
import { CliError } from './env.js';
import { CLI_VERSION } from './version.js';

export const LEGACY_FORMATS = { 'tma-bench-import/1': 'transcript-mining/1', 'tma-bench-import/trajectory-1': 'trajectory/1' } as const;
export type LegacyFormat = keyof typeof LEGACY_FORMATS;

/** The task version that the retired bench-import.ts always wrote (`insert into public.task_versions (..., version, ...) values (..., 1, ...)`). */
export const LEGACY_TASK_VERSION = 1;

export function isLegacyFormat(v: unknown): v is LegacyFormat {
  return typeof v === 'string' && Object.hasOwn(LEGACY_FORMATS, v);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface LegacyOptions {
  agentId: string;
  /**
   * The TMA task version (`task_versions.version`); default 1. The old importer wrote every task at
   * version 1 and kept the pack version in its own column (`task_versions.pack_version`), so the
   * file's `task.pack_version` is NOT the task version (L9: the trajectory file has pack_version 2
   * and its task has only version 1).
   */
  taskVersion?: number;
  /** Only this executor (`model_id`, or `model_id#variant`). */
  executor?: string;
}

export interface LegacyBody {
  /** `model_id`, plus `#variant` when there is one. */
  executor: string;
  body: LocalResult;
}

/**
 * One body per executor. The bodies are NOT validated here (the caller runs validateLocalResult on
 * each), so a key that the old parser allowed and the contract does not is still refused.
 */
export function legacyToLocalResults(raw: unknown, opts: LegacyOptions): LegacyBody[] {
  if (!isObj(raw) || !isLegacyFormat(raw.format)) throw new CliError('not an old tma-bench-import file');
  const task = raw.task;
  if (!isObj(task) || typeof task.slug !== 'string') throw new CliError('the old file has no task.slug');
  const version = opts.taskVersion ?? LEGACY_TASK_VERSION;
  if (!Number.isInteger(version) || version < 1) throw new CliError('the task version must be an integer >= 1 (--task-version <n>)');
  if (typeof raw.grader_version !== 'string') throw new CliError('the old file has no grader_version');
  if (!Array.isArray(raw.executors) || raw.executors.length === 0) throw new CliError('the old file has no executors');

  const out: LegacyBody[] = [];
  for (const [i, e] of raw.executors.entries()) {
    if (!isObj(e) || typeof e.model_id !== 'string') throw new CliError(`executors[${i}] has no model_id`);
    const variant = e.variant === 'structured-output' ? 'structured-output' : null;
    const key = variant ? `${e.model_id}#${variant}` : e.model_id;
    if (opts.executor && opts.executor !== key && opts.executor !== e.model_id) continue;
    const provider = providerOf({ id: e.model_id });
    const executor: Record<string, unknown> = {
      model_id: e.model_id,
      provider: isProviderKey(provider) ? provider : null,
      route: e.route,
      harness: e.harness,
      variant,
      cost_source: e.cost_source,
    };
    if (typeof e.model_effective === 'string') executor.model_effective = e.model_effective;
    out.push({
      executor: key,
      body: {
        format: 'tma-local-result/1',
        agent_id: opts.agentId,
        task: { catalog: { slug: task.slug, version } },
        metrics_shape: LEGACY_FORMATS[raw.format],
        grader_version: raw.grader_version,
        runner: { version: CLI_VERSION, execution: 'external', profile: null, sandbox_image_id: null },
        executor,
        ran_from: e.ran_from,
        ran_to: e.ran_to,
        summary: e.summary,
        runs: e.runs,
      } as unknown as LocalResult,
    });
  }
  if (out.length === 0) throw new CliError(`no executor ${opts.executor} in the old file`);
  return out;
}

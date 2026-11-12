import { createHash } from 'node:crypto';
import type { ParsedTrace, RunAction, StepErrorClass, StepStatus, StepTrajectory, TargetKind, ToolFamily } from './types.js';

export const WORKSPACE_IN_SANDBOX = '/workspace';
const MAX_TARGET = 300;

function truncate(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_TARGET ? `${oneLine.slice(0, MAX_TARGET - 1)}…` : oneLine;
}

/** Make sandbox paths relative to the workspace root, so no container path leaks. */
export function relativize(value: string): string {
  return value.split(`${WORKSPACE_IN_SANDBOX}/`).join('').split(WORKSPACE_IN_SANDBOX).join('.');
}

function targetOf(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  for (const key of ['filePath', 'path', 'command', 'pattern', 'url', 'name', 'description']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return truncate(relativize(value));
  }
  return null;
}

/**
 * Parse the output of `opencode run --format json` (one JSON event per line).
 * A `tool_use` event is emitted once per tool call, when the call finishes
 * (state.status = completed | error). Lines that are not JSON are ignored.
 */
/**
 * The target of an MCP tool call (`<server>_<tool>` in opencode): the compact arguments, so the run
 * log shows which ticket, order or entity the agent touched.
 */
function mcpTarget(input: Record<string, unknown> | undefined): string | null {
  if (!input || Object.keys(input).length === 0) return null;
  return truncate(JSON.stringify(input));
}

// ---------------------------------------------------------------------------------------------
// tma-trajectory/1 step fields (plan 20261112-tma-c4-result-store-trajectory-upload, T4). The hosted worker
// writes the same structural record as a self-host upload: family, status, error class, duration, target
// kind, two digests and a retry link. No text is kept: the error text only picks the class, and the
// arguments and the result are stored as sha256 digests.
// ---------------------------------------------------------------------------------------------

const MAX_STEP_MS = 86_400_000;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** sha256 of the canonical JSON of a value (object keys sorted), the same rule as the evaluator's canonicalDigest. */
export function argsDigest(value: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return sha256(JSON.stringify(canon(value ?? {})));
}

const BUILTIN_TOOLS = new Set(['read', 'write', 'edit', 'patch', 'multiedit', 'glob', 'grep', 'list', 'ls', 'todowrite', 'todoread']);
const WEB_TOOLS = new Set(['webfetch', 'websearch', 'codesearch']);
const SHELL_PREFIX = /^(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(git|gh|ssh)(?:\s|$)/;

export function toolFamilyOf(tool: string, command: string | null, isMcp: boolean): ToolFamily {
  if (isMcp) return 'mcp';
  const name = tool.toLowerCase();
  if (name === 'bash') {
    const m = command ? SHELL_PREFIX.exec(command.trim()) : null;
    return m ? (m[1] as 'git' | 'gh' | 'ssh') : 'shell';
  }
  if (BUILTIN_TOOLS.has(name)) return 'builtin';
  if (WEB_TOOLS.has(name)) return 'web';
  if (name === 'task') return 'agent';
  return 'other';
}

export function targetKindOf(tool: string, target: string | null, isMcp: boolean): TargetKind {
  if (target === null) return 'none';
  if (isMcp) return 'mcp';
  switch (tool.toLowerCase()) {
    case 'read': case 'write': case 'edit': case 'patch': case 'multiedit': return 'file';
    case 'list': case 'ls': return 'dir';
    case 'glob': case 'grep': return 'pattern';
    case 'webfetch': case 'websearch': case 'codesearch': return 'url';
    case 'bash': return 'command';
    case 'task': return 'agent';
    case 'skill': return 'skill';
    default: return 'command';
  }
}

/**
 * The failure of a tool call as a status and a class. Only the CLASS is kept: the matched text is dropped.
 * An order that puts the most specific signal first (a permission refusal that also says "not found" is a
 * refusal).
 */
export function classifyFailure(errorText: string | null, state: string | undefined): { status: StepStatus; errorClass: StepErrorClass } {
  const t = (errorText ?? '').toLowerCase();
  if (/permission|denied|not allowed|forbidden|eacces|eperm|rejected/.test(t)) return { status: 'denied', errorClass: 'permission' };
  if (/timed? ?out|timeout|etimedout|deadline/.test(t)) return { status: 'timeout', errorClass: 'timeout' };
  if (/rate.?limit|\b429\b|too many requests/.test(t)) return { status: 'error', errorClass: 'rate_limited' };
  if (/enoent|no such file|not found|does not exist|\b404\b/.test(t)) return { status: 'error', errorClass: 'not_found' };
  if (/econn|enotfound|network|fetch failed|socket|dns|unreachable/.test(t)) return { status: 'error', errorClass: 'network' };
  if (/invalid|schema|required|expected|unexpected|malformed|must be/.test(t)) return { status: 'error', errorClass: 'invalid_args' };
  if (/abort|interrupt|cancel/.test(t) || (state !== undefined && state !== 'error')) return { status: 'error', errorClass: 'interrupted' };
  return { status: 'error', errorClass: 'tool_error' };
}

function stepTrajectory(opts: {
  tool: string;
  target: string | null;
  command: string | null;
  input: Record<string, unknown> | undefined;
  state: Record<string, any>;
  isMcp: boolean;
  turn: number;
  seq: number;
  earlier: ReadonlyArray<{ seq: number; tool: string; argsSha256: string; failed: boolean }>;
}): StepTrajectory {
  const { state } = opts;
  const completed = state.status === 'completed';
  const errorText = typeof state.error === 'string' ? state.error : null;
  const fail = completed ? null : classifyFailure(errorText, typeof state.status === 'string' ? state.status : undefined);
  const start = typeof state.time?.start === 'number' ? state.time.start : null;
  const end = typeof state.time?.end === 'number' ? state.time.end : null;
  const durationMs = start !== null && end !== null && end >= start ? Math.min(Math.round(end - start), MAX_STEP_MS) : null;
  const output = typeof state.output === 'string' ? state.output : null;
  const resultText = completed ? output : (errorText ?? output);
  const argsSha256 = argsDigest(opts.input);
  // A retry: the most recent earlier call of the same tool with the same arguments, when that call failed.
  let retryOf: number | null = null;
  for (let i = opts.earlier.length - 1; i >= 0; i -= 1) {
    const e = opts.earlier[i]!;
    if (e.tool === opts.tool && e.argsSha256 === argsSha256) {
      retryOf = e.failed ? e.seq : null;
      break;
    }
  }
  return {
    parentSeq: null,
    turn: opts.turn,
    toolFamily: toolFamilyOf(opts.tool, opts.command, opts.isMcp),
    status: fail ? fail.status : 'ok',
    errorClass: fail ? fail.errorClass : null,
    durationMs,
    tokensIn: null,
    tokensOut: null,
    targetKind: targetKindOf(opts.tool, opts.target, opts.isMcp),
    argsSha256,
    resultSha256: resultText && resultText.length > 0 ? sha256(resultText) : null,
    retryOf,
  };
}

export function parseOpencodeEvents(text: string, mcpServers: readonly string[] = []): ParsedTrace {
  const actions: RunAction[] = [];
  const errors: string[] = [];
  const usage = { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let turn = 0;
  const earlier: Array<{ seq: number; tool: string; argsSha256: string; failed: boolean }> = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event?.type === 'tool_use' && event.part?.type === 'tool') {
      const state = event.part.state ?? {};
      const started = typeof state.time?.start === 'number' ? state.time.start : event.timestamp;
      const tool = String(event.part.tool ?? 'unknown');
      const isMcp = mcpServers.some((m) => tool.startsWith(`${m}_`));
      const target = isMcp ? mcpTarget(state.input) : targetOf(state.input);
      const seq = actions.length + 1;
      const command = typeof state.input?.command === 'string' ? state.input.command : null;
      const trajectory = stepTrajectory({
        tool, target, command, input: state.input, state, isMcp, turn: Math.max(turn, 1), seq, earlier,
      });
      earlier.push({ seq, tool, argsSha256: trajectory.argsSha256, failed: trajectory.status !== 'ok' });
      actions.push({
        seq,
        tool,
        target,
        ok: state.status === 'completed',
        occurredAt: new Date(typeof started === 'number' ? started : Date.now()).toISOString(),
        trajectory,
      });
    } else if (event?.type === 'step_start') {
      turn += 1;
    } else if (event?.type === 'step_finish') {
      usage.steps += 1;
      usage.inputTokens += Number(event.part?.tokens?.input ?? 0);
      usage.outputTokens += Number(event.part?.tokens?.output ?? 0);
      usage.costUsd += Number(event.part?.cost ?? 0);
    } else if (event?.type === 'error') {
      const data = event.error?.data ?? {};
      errors.push(truncate(`${event.error?.name ?? 'Error'}: ${data.message ?? JSON.stringify(data)}`));
    }
  }
  usage.costUsd = Math.round(usage.costUsd * 1e6) / 1e6;
  return { actions, usage, errors };
}

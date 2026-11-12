// Structural trajectory readers of the eval kit (plan 20261112-tma-c3-eval-repo-kit-docs T4; parent ADR-4):
// a harness trace on the host becomes a `tma-trajectory/1` record. One step per tool call: tool, family,
// status, error class, duration, target kind, the redacted target, and the sha256 of the arguments and of
// the result. The arguments, the result, the prompt and every model message stay on the host.
//
//   claude-code  a Claude Code session file (~/.claude/projects/<project>/<session>.jsonl)
//   opencode     the actions of a `tma eval run` / `tma run` agent run (run.json), as parsed from the
//                opencode JSON events by trace.ts (the hosted worker's parser)
//
// The readers read a PATH, not a fleet service, so a third party uses them as they are (ADR-4).
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { TRAJECTORY_FORMAT, TRAJECTORY_MAX_STEPS, validateTrajectory, type Trajectory, type TrajectoryStep } from '@itera/contracts';
import { argsDigest, classifyFailure } from '../../trace.js';
import type { RunAction, StepErrorClass, StepStatus, ToolFamily } from '../../types.js';
import { CliError } from '../env.js';
import { redactTarget, type RedactContext, type TargetKind } from './redact.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const MAX_STEP_MS = 86_400_000;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** The tool name as the contract allows it; anything else is `other-tool`. */
function toolName(name: string): string {
  return TOOL_NAME.test(name) ? name : 'other-tool';
}

// --- Claude Code ------------------------------------------------------------------------------------

const CC_BUILTIN = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'LS', 'TodoWrite', 'TodoRead', 'ExitPlanMode', 'BashOutput', 'KillShell', 'KillBash', 'ToolSearch']);
const CC_WEB = new Set(['WebFetch', 'WebSearch']);
const CC_AGENT = new Set(['Task', 'Agent']);
const SHELL_PREFIX = /^(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(git|gh|ssh)(?:\s|$)/;
/** A shell call that runs a skill script (`bash ~/.claude/skills/<name>/run.sh`). */
const SKILL_SCRIPT = /(^|\s|\/)\.claude\/skills\/[^/\s]+\//;

export function claudeCodeFamily(tool: string, command: string | null): ToolFamily {
  if (tool.startsWith('mcp__')) return 'mcp';
  if (tool === 'Bash') {
    if (command && SKILL_SCRIPT.test(command)) return 'skill-bash';
    const m = command ? SHELL_PREFIX.exec(command.trim()) : null;
    return m ? (m[1] as ToolFamily) : 'shell';
  }
  if (CC_BUILTIN.has(tool)) return 'builtin';
  if (CC_WEB.has(tool)) return 'web';
  if (CC_AGENT.has(tool)) return 'agent';
  return 'other';
}

/** The raw target and its kind of one Claude Code tool call (before redaction). */
export function claudeCodeTarget(tool: string, input: Record<string, unknown>): { kind: TargetKind; raw: string | null } {
  const s = (k: string) => (typeof input[k] === 'string' && (input[k] as string).length > 0 ? (input[k] as string) : null);
  if (tool.startsWith('mcp__')) return { kind: 'mcp', raw: tool.split('__')[1] ?? null };
  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookRead':
      return { kind: 'file', raw: s('file_path') ?? s('path') };
    case 'NotebookEdit':
      return { kind: 'file', raw: s('notebook_path') };
    case 'LS':
      return { kind: 'dir', raw: s('path') };
    case 'Glob':
    case 'Grep':
      return { kind: 'pattern', raw: s('pattern') };
    case 'Bash':
      return { kind: 'command', raw: s('command') };
    case 'WebFetch':
      return { kind: 'url', raw: s('url') };
    case 'WebSearch':
      return { kind: 'pattern', raw: s('query') };
    case 'Task':
    case 'Agent':
      // The sub-agent type only. Its description and prompt are prompt text.
      return { kind: 'agent', raw: s('subagent_type') };
    case 'Skill':
      return { kind: 'skill', raw: s('skill') ?? s('command') ?? s('name') };
    default:
      return { kind: 'none', raw: null };
  }
}

/** The text of a tool_result content (a string, or a list of blocks). Digested, never kept. */
function resultText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : JSON.stringify(b)));
    return parts.join('\n');
  }
  return content === undefined || content === null ? null : JSON.stringify(content);
}

interface PendingCall {
  seq: number;
  tool: string;
  argsSha256: string;
  startedMs: number | null;
  step: TrajectoryStep;
}

/**
 * Read a Claude Code session (JSONL) into a tma-trajectory/1 record. A model turn = one assistant message
 * id. A call without a result (the session stopped) is `error / interrupted`. Calls in a side chain
 * (a sub-agent) point to the one open Task/Agent call as parent, when exactly one is open.
 */
export function readClaudeCodeSession(text: string, opts: { redact?: RedactContext } = {}): { trajectory: Trajectory; cwd: string | null; skipped: number } {
  const steps: TrajectoryStep[] = [];
  const pending = new Map<string, PendingCall>();
  const earlier: Array<{ seq: number; tool: string; argsSha256: string; failed: boolean }> = [];
  const turns = new Map<string, number>();
  let cwd: string | null = null;
  let skipped = 0;
  const ctx = (): RedactContext => ({ home: opts.redact?.home ?? homedir(), roots: [...(opts.redact?.roots ?? []), ...(cwd ? [cwd] : [])] });

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      skipped++;
      continue;
    }
    if (typeof ev?.cwd === 'string' && cwd === null) cwd = ev.cwd;
    const atMs = typeof ev?.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN;
    const content = ev?.message?.content;
    if (ev?.type === 'assistant' && Array.isArray(content)) {
      const msgId = typeof ev.message.id === 'string' ? ev.message.id : `line-${steps.length}`;
      if (!turns.has(msgId)) turns.set(msgId, turns.size + 1);
      const turn = turns.get(msgId)!;
      for (const block of content) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
        if (steps.length >= TRAJECTORY_MAX_STEPS) throw new CliError(`the session has more than ${TRAJECTORY_MAX_STEPS} tool calls: tma-trajectory/1 holds at most ${TRAJECTORY_MAX_STEPS}`);
        const tool = String(block.name ?? 'unknown');
        const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
        const seq = steps.length + 1;
        const argsSha256 = argsDigest(input);
        const target = claudeCodeTarget(tool, input);
        const redacted = redactTarget(target.kind, target.raw, ctx());
        let parentSeq: number | null = null;
        if (ev.isSidechain === true) {
          const open = [...pending.values()].filter((p) => CC_AGENT.has(p.tool));
          if (open.length === 1) parentSeq = open[0]!.seq;
        }
        let retryOf: number | null = null;
        for (let i = earlier.length - 1; i >= 0; i--) {
          const e = earlier[i]!;
          if (e.tool === tool && e.argsSha256 === argsSha256) {
            retryOf = e.failed ? e.seq : null;
            break;
          }
        }
        const step: TrajectoryStep = {
          seq,
          parent_seq: parentSeq,
          turn,
          tool: toolName(tool),
          tool_family: claudeCodeFamily(tool, typeof input.command === 'string' ? input.command : null),
          // Until its result arrives, a call counts as interrupted.
          status: 'error',
          error_class: 'interrupted',
          duration_ms: null,
          tokens_in: null,
          tokens_out: null,
          target_kind: redacted === null ? 'none' : target.kind,
          target_redacted: redacted,
          args_sha256: argsSha256,
          result_sha256: null,
          retry_of: retryOf,
        } as TrajectoryStep;
        steps.push(step);
        pending.set(block.id, { seq, tool, argsSha256, startedMs: Number.isFinite(atMs) ? atMs : null, step });
        earlier.push({ seq, tool, argsSha256, failed: true });
      }
    } else if (ev?.type === 'user' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const call = pending.get(block.tool_use_id);
        if (!call) continue;
        pending.delete(block.tool_use_id);
        const body = resultText(block.content);
        const isError = block.is_error === true;
        const s = call.step as { status: StepStatus; error_class: StepErrorClass | null; duration_ms: number | null; result_sha256: string | null };
        if (isError) {
          const f = classifyFailure(body, 'error');
          s.status = f.status;
          s.error_class = f.errorClass;
        } else {
          s.status = 'ok';
          s.error_class = null;
        }
        s.result_sha256 = body && body.length > 0 ? sha256(body) : null;
        if (call.startedMs !== null && Number.isFinite(atMs) && atMs >= call.startedMs) s.duration_ms = Math.min(Math.round(atMs - call.startedMs), MAX_STEP_MS);
        const e = earlier.find((x) => x.seq === call.seq);
        if (e) e.failed = isError;
      }
    }
  }
  return { trajectory: checked({ format: TRAJECTORY_FORMAT, steps } as Trajectory), cwd, skipped };
}

// --- opencode (the TMA sandbox) --------------------------------------------------------------------

/**
 * The trajectory of an agent run from its actions (trace.ts parsed the opencode events; each action has
 * its structural fields). The raw target of an action is redacted here; it never leaves as it is.
 */
export function trajectoryFromActions(actions: RunAction[], opts: { redact?: RedactContext } = {}): Trajectory | null {
  if (actions.length === 0) return { format: TRAJECTORY_FORMAT, steps: [] } as Trajectory;
  if (actions.some((a) => !a.trajectory)) return null;
  if (actions.length > TRAJECTORY_MAX_STEPS) throw new CliError(`the run has more than ${TRAJECTORY_MAX_STEPS} tool calls`);
  const steps = actions.map((a, i) => {
    const t = a.trajectory!;
    const redacted = redactTarget(t.targetKind, a.target, { roots: ['.', '/workspace'], ...opts.redact });
    return {
      seq: i + 1,
      parent_seq: t.parentSeq,
      turn: t.turn,
      tool: toolName(a.tool),
      tool_family: t.toolFamily,
      status: t.status,
      error_class: t.errorClass,
      duration_ms: t.durationMs,
      tokens_in: t.tokensIn,
      tokens_out: t.tokensOut,
      target_kind: redacted === null ? 'none' : t.targetKind,
      target_redacted: redacted,
      args_sha256: t.argsSha256,
      result_sha256: t.resultSha256,
      retry_of: t.retryOf,
    } as TrajectoryStep;
  });
  return checked({ format: TRAJECTORY_FORMAT, steps } as Trajectory);
}

/** Validate with the API's own validator. A reader bug is a CliError, never a bad upload. */
export function checked(t: Trajectory): Trajectory {
  const v = validateTrajectory(t);
  if (!v.ok) throw new CliError(`the trajectory does not match ${TRAJECTORY_FORMAT}: ${v.errors.slice(0, 5).join('; ')}`);
  // validateTrajectory also takes tma-trajectory/2; this reader writes /1 only.
  if (v.value.format !== TRAJECTORY_FORMAT) throw new CliError(`the trajectory is ${v.value.format}, not ${TRAJECTORY_FORMAT}`);
  return v.value;
}

/** Counts per family and status, for a human line. */
export function trajectoryLine(t: Trajectory): string {
  const by = (k: 'tool_family' | 'status') => {
    const m = new Map<string, number>();
    for (const s of t.steps) m.set(s[k] as string, (m.get(s[k] as string) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(', ');
  };
  return `${t.steps.length} steps, turns ${t.steps.length ? Math.max(...t.steps.map((s) => s.turn)) : 0}; family: ${by('tool_family') || '-'}; status: ${by('status') || '-'}`;
}

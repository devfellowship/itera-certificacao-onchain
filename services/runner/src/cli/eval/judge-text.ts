// The judge text builder of the eval kit (plan 20261112-tma-c6-judge-calibration, task C6-FOLD).
//
// `tma eval judge calibrate --texts-dir` reads one text per run. The ALIEN01 relay takes a prompt of at most
// 12,288 bytes (context 4096 tokens), and the median real run is about 40,000 characters. This module FOLDS a Claude
// Code session into a text that fits a byte budget, per judge rubric:
//   - it keeps the task prompt (the first user text), the final report (the last agent text) and the timeline events
//     that the rubric names (async-wait-lifecycle: waits, polls, background starts, wakes, ends of turn, merges and
//     deploys; external-block-handling: failed steps, block signals, retries, gate and CI steps);
//   - it elides the rest, and each elision is an explicit marker with counts per kind: `[… 12 elided: read 9, wait* 3 …]`.
//     A kind with `*` is a kind that the rubric names, so a folded poll loop still shows how many polls it held.
// The fold is a pure function of the session lines, the judge id and the budget: the same input gives the same bytes.
// It reads no clock, no environment variable and no network. The text stays on the host (parent ADR-1).
import { createHash } from 'node:crypto';
import { stepKindOf } from '@itera/contracts';
import { argsDigest } from '../../trace.js';
import { SECRET_PATTERNS } from './redact.js';

export const JUDGE_TEXT_FORMAT = 'tma-judge-text/1';
/** The judges that have a fold profile. An unknown judge is refused (fail closed): its rubric names no events here. */
export const FOLD_JUDGES = ['async-wait-lifecycle', 'external-block-handling'] as const;
export type FoldJudge = (typeof FOLD_JUDGES)[number];
export const isFoldJudge = (id: string): id is FoldJudge => (FOLD_JUDGES as readonly string[]).includes(id);
/** The smallest budget the fold accepts: the header, two short sections and one marker. */
export const FOLD_MIN_BUDGET = 600;

const CMD_MAX = 150;
const EXCERPT_MAX = 90;
const MSG_MAX = 100;
const TARGET_COMPACT = 64;
/** The classifiers read at most this many characters of a command (a heredoc can be very long). */
const COMMAND_SCAN_MAX = 4000;
const TASK_SHARE = 0.22;
const TASK_MAX = 1500;
const FINAL_SHARE = 0.2;
const FINAL_MAX = 1300;
/** The tighter sections of the second attempt, when the first one cannot keep every rubric event. */
const TASK_TIGHT = 800;
const FINAL_TIGHT = 800;

// --- the events of a session -----------------------------------------------------------------------------------------

export type EventKind = 'step' | 'wake' | 'msg' | 'end';

export interface FoldStep {
  kind: 'step';
  seq: number;
  at: number | null;
  tool: string;
  /** The command of a shell step, or the short target of another tool (normalized, cut). */
  target: string;
  /** The full command of a shell step (normalized, not cut): the classifiers read it. */
  command: string;
  background: boolean;
  status: 'ok' | 'error' | 'open';
  exit: number | null;
  movedToBackground: boolean;
  retryOf: number | null;
  /** A short line of the result: the first line with a signal, else the first line. */
  excerpt: string | null;
  /** The result holds a sign of an outside block (out of memory, rate limit, a red check, a stuck queue …). */
  blockSignal: boolean;
}
export interface FoldWake {
  kind: 'wake';
  at: number | null;
  /** The step that the wake reports, when the notification names its tool call. */
  ofSeq: number | null;
  what: string;
  failed: boolean;
}
export interface FoldMsg {
  kind: 'msg';
  at: number | null;
  origin: 'human' | 'agent' | 'system';
  excerpt: string;
}
export interface FoldEnd {
  kind: 'end';
  at: number | null;
}
export type FoldEvent = FoldStep | FoldWake | FoldMsg | FoldEnd;

export interface ParsedSession {
  task: string;
  final: string;
  events: FoldEvent[];
  steps: number;
  turns: number;
  spanMs: number | null;
  skipped: number;
}

/** Collapse white space, drop a credential shape, and shorten a deep absolute path to its last two segments. */
export function normalizeText(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim();
  t = t.replace(/\b(password|passwd|secret|token|api[_-]?key|apikey)\s*[=:]\s*\S+/gi, '<redacted>');
  for (const re of SECRET_PATTERNS) t = t.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), '<redacted>');
  t = t.replace(/(^|[\s"'=(:])((?:\/[A-Za-z0-9._@+~-]+){4,})(?=$|[\s"'),;:|&<>])/g, (_m, pre: string, path: string) => {
    const parts = path.split('/').filter(Boolean);
    return `${pre}…/${parts.slice(-2).join('/')}`;
  });
  t = t.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>');
  t = t.replace(/[A-Za-z0-9_-]{32,}/g, (w) => ((w.match(/[0-9]/g) ?? []).length >= 4 && /[A-Za-z]/.test(w) ? '<id>' : w));
  return t;
}

/** Cut to at most `max` characters, with an ellipsis. */
export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n');
  }
  return '';
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => (b as { text: string }).text)
      .join('\n');
  }
  return '';
}

const BLOCK_SIGNAL = /\b(?:out of memory|OOM|Killed|No space left|rate limit|429|502|503|504|ETIMEDOUT|ECONNREFUSED|ECONNRESET|timed out|timeout|maintenance|stuck|queued|unreachable|FAILURE|failing|red\b|denied|forbidden|403|404 Not Found|could not resolve|lock(?:ed)?\b|conflict)/i;
const SIGNAL_LINE = /\b(?:error|fail|failed|failure|killed|oom|denied|timeout|timed out|rate limit|429|50[234]|exit|merged|pass(?:ed)?|green|red|pending|queued|in_progress|completed|success|conclusion|status|stuck|maintenance)\b/i;
const EXIT_CODE = /^\s*Exit code (\d{1,3})\b/;
const BG_STARTED = /Command running in background with ID: ?([A-Za-z0-9_-]{3,40})/;
const BG_MOVED = /moved to the background \(ID: ?([A-Za-z0-9_-]{3,40})\)/;

function excerptOf(body: string): string | null {
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !EXIT_CODE.test(l));
  if (lines.length === 0) return null;
  const pick = lines.find((l) => SIGNAL_LINE.test(l)) ?? lines[0]!;
  return cut(normalizeText(pick), EXCERPT_MAX);
}

function shortTarget(tool: string, input: Record<string, unknown>): { target: string; command: string } {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const base = (p: string) => p.split('/').filter(Boolean).slice(-1)[0] ?? '';
  if (tool === 'Bash' || tool === 'bash') {
    const command = normalizeText(s('command').slice(0, COMMAND_SCAN_MAX));
    return { target: cut(command, CMD_MAX), command };
  }
  if (tool === 'Monitor') {
    const command = normalizeText(s('command') || s('description'));
    return { target: cut(command, CMD_MAX), command };
  }
  if (tool.startsWith('mcp__')) return { target: tool.split('__').slice(-1)[0] ?? 'mcp', command: '' };
  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return { target: cut(base(s('file_path')), 60), command: '' };
    case 'Grep':
    case 'Glob':
      return { target: cut(normalizeText(s('pattern')), 60), command: '' };
    case 'Agent':
    case 'Task':
      return { target: cut(normalizeText(`${s('subagent_type') || 'agent'}: ${s('description')}`), 80), command: '' };
    case 'Skill': {
      const name = s('skill') || s('command') || s('name');
      return { target: cut(normalizeText(`${name} ${s('args')}`), CMD_MAX), command: normalizeText(name) };
    }
    case 'SendMessage':
      return { target: cut(normalizeText(s('to') || s('recipient')), 40), command: '' };
    case 'TaskOutput':
    case 'BashOutput':
    case 'TaskStop':
    case 'KillShell':
      return { target: cut(normalizeText(s('task_id') || s('bash_id') || s('shell_id')), 40), command: '' };
    case 'WebFetch':
      return { target: cut(normalizeText(s('url')), 80), command: '' };
    default:
      return { target: '', command: '' };
  }
}

const SKIP_USER = /^(?:Base directory for this skill|<command-name>|<local-command|Caveat:)/;
const AGENT_MSG = /^(?:The coordinator sent a message|Another Claude session sent|<teammate-message|\[from )/;
const SYSTEM_MSG = /^(?:\[SYSTEM NOTIFICATION|This session is being continued|<system-reminder>)/;

function wakeOf(text: string, seqOfTool: Map<string, number>, seqOfBg: Map<string, number>): { ofSeq: number | null; what: string; failed: boolean; key: string } | null {
  const i = text.indexOf('<task-notification>');
  if (i < 0) return null;
  const body = text.slice(i);
  const tag = (name: string) => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
    return m ? m[1]!.trim() : '';
  };
  const toolId = tag('tool-use-id');
  const taskId = tag('task-id');
  const status = tag('status');
  const summary = tag('summary').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const ofSeq = seqOfTool.get(toolId) ?? seqOfBg.get(taskId) ?? null;
  let what: string;
  const exit = /exit code (\d{1,3})/i.exec(summary);
  if (/^Monitor event/i.test(summary)) what = `monitor event: ${cut(normalizeText(summary.replace(/^Monitor event:\s*/i, '').replace(/^"|"$/g, '')), 60)}`;
  else if (/^Monitor .* stream ended/i.test(summary)) what = 'monitor stream ended';
  else if (/^Agent .* finished/i.test(summary) || /agent/i.test(tag('task-type'))) what = `agent ${status || 'finished'}`;
  else if (/^Background command/i.test(summary)) {
    if (/stopped after reaching its background time/i.test(summary)) what = 'background command stopped at its time limit';
    else what = `background command ${/failed/i.test(summary) ? 'failed' : status || 'done'}${exit ? ` (exit ${exit[1]})` : ''}`;
  } else what = cut(normalizeText(`${status} ${summary}`.trim()) || 'task notification', 70);
  const failed = /failed|killed|error|stopped after/i.test(`${status} ${summary}`) || (exit !== null && exit[1] !== '0');
  return { ofSeq, what, failed, key: `${taskId}|${toolId}|${status}|${summary.length}` };
}

/**
 * Read a Claude Code session (its JSONL lines) into the fold events. One step per tool call (seq = the order of the
 * calls, as in tma-trajectory), a wake per task notification (once per notification), a message per later user text,
 * and an end of turn when the agent stops with no open call before a wake or a message (or at the end of the file).
 */
export interface SessionReader {
  /** One JSONL line of the session file. */
  push(line: string): void;
  finish(): ParsedSession;
}

export function sessionReader(): SessionReader {
  const events: FoldEvent[] = [];
  const open = new Map<string, FoldStep>();
  const seqOfTool = new Map<string, number>();
  const seqOfBg = new Map<string, number>();
  const wakeKeys = new Set<string>();
  const earlier: Array<{ key: string; seq: number; failed: boolean }> = [];
  let task = '';
  let final = '';
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  let seq = 0;
  let skipped = 0;
  let agentIdle = false; // the last agent message held text and no call is open
  const rel = (ms: number) => (firstMs === null || !Number.isFinite(ms) ? null : Math.max(0, ms - firstMs));
  const endIfIdle = (at: number | null) => {
    if (agentIdle && open.size === 0) events.push({ kind: 'end', at });
    agentIdle = false;
  };
  const addWake = (text: string, at: number | null): boolean => {
    const w = wakeOf(text, seqOfTool, seqOfBg);
    if (!w) return false;
    if (wakeKeys.has(w.key)) return true;
    wakeKeys.add(w.key);
    events.push({ kind: 'wake', at, ofSeq: w.ofSeq, what: w.what, failed: w.failed });
    return true;
  };

  const push = (line: string): void => {
    const t = line.trim();
    if (!t.startsWith('{')) return;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      skipped++;
      return;
    }
    const ms = typeof ev?.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN;
    if (Number.isFinite(ms)) {
      if (firstMs === null) firstMs = ms;
      lastMs = ms;
    }
    const at = rel(ms);
    const content = ev?.message?.content;
    if (ev?.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          final = block.text;
          agentIdle = true;
        } else if (block?.type === 'tool_use' && typeof block.id === 'string') {
          agentIdle = false;
          seq += 1;
          const tool = String(block.name ?? 'unknown');
          const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
          const { target, command } = shortTarget(tool, input);
          const key = `${tool}|${argsDigest(input)}`;
          let retryOf: number | null = null;
          for (let i = earlier.length - 1; i >= 0; i--) {
            if (earlier[i]!.key === key) {
              retryOf = earlier[i]!.failed ? earlier[i]!.seq : null;
              break;
            }
          }
          const step: FoldStep = {
            kind: 'step', seq, at, tool, target, command,
            background: input.run_in_background === true,
            status: 'open', exit: null, movedToBackground: false, retryOf, excerpt: null, blockSignal: false,
          };
          events.push(step);
          open.set(block.id, step);
          seqOfTool.set(block.id, seq);
          earlier.push({ key, seq, failed: true });
        }
      }
    } else if (ev?.type === 'user' && Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result')) {
      for (const block of content) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const step = open.get(block.tool_use_id);
        if (!step) continue;
        open.delete(block.tool_use_id);
        const body = resultText(block.content);
        const exit = EXIT_CODE.exec(body);
        step.exit = exit ? Number(exit[1]) : null;
        step.status = block.is_error === true || (step.exit !== null && step.exit !== 0) ? 'error' : 'ok';
        const started = BG_STARTED.exec(body);
        const moved = BG_MOVED.exec(body);
        if (started) seqOfBg.set(started[1]!, step.seq);
        if (moved) {
          seqOfBg.set(moved[1]!, step.seq);
          step.movedToBackground = true;
        }
        step.excerpt = excerptOf(body.slice(0, 20_000));
        step.blockSignal = BLOCK_SIGNAL.test(body.slice(0, 20_000));
        const e = earlier.find((x) => x.seq === step.seq);
        if (e) e.failed = step.status === 'error';
      }
    } else if (ev?.type === 'user') {
      const text = userText(content);
      if (text.trim() === '') return;
      if (text.includes('<task-notification>')) {
        endIfIdle(at);
        addWake(text, at);
        return;
      }
      const head = text.trimStart();
      if (SKIP_USER.test(head)) return;
      if (task === '') {
        task = text;
        return;
      }
      endIfIdle(at);
      const origin = AGENT_MSG.test(head) ? 'agent' : SYSTEM_MSG.test(head) ? 'system' : 'human';
      events.push({ kind: 'msg', at, origin, excerpt: cut(normalizeText(head), MSG_MAX) });
    } else if (ev?.type === 'attachment' && ev.attachment && typeof ev.attachment === 'object') {
      const a = ev.attachment as Record<string, unknown>;
      if (a.type === 'queued_command' && typeof a.prompt === 'string' && a.prompt.includes('<task-notification>')) {
        endIfIdle(at);
        addWake(a.prompt, at);
      }
    }
  };
  const finish = (): ParsedSession => {
    if (agentIdle && open.size === 0) events.push({ kind: 'end', at: lastMs === null ? null : rel(lastMs) });
    agentIdle = false;
    const turns = events.filter((e) => e.kind === 'end').length;
    return { task, final, events, steps: seq, turns, spanMs: firstMs !== null && lastMs !== null ? lastMs - firstMs : null, skipped };
  };
  return { push, finish };
}

/** Read the lines of a session in one call (sessionReader for a stream). */
export function parseSessionLines(lines: Iterable<string>): ParsedSession {
  const r = sessionReader();
  for (const line of lines) r.push(line);
  return r.finish();
}

// --- the rubric profiles ---------------------------------------------------------------------------------------------

const POLL = /\bsleep\s+\d|\buntil\b|\bwhile\b[^;]*;\s*do\b|\bgh\s+(?:pr\s+(?:checks|view|status)|run\s+(?:watch|view|list))\b|statusCheckRollup|check-runs|\/actions\/runs|check-pr\.sh|watch-pr\.sh|pr-watch\.sh|fleet-ci-check|fleet-health|--watch\b|\bwait-for\b|\btimeout\s+\d|systemctl\s+is-active|docker\s+service\s+ps/;
const CI_READ = /\bgh\s+(?:pr\s+(?:checks|view)|run\s+(?:watch|view|list))\b|statusCheckRollup|check-runs|\/actions\/runs|check-pr\.sh|fleet-ci-check|fleet-health/;
const GATE = /\bgh\s+pr\s+merge\b|safe-admin-merge|--admin\b|\bdokploy\b|\bdeploy\b|\bgit\s+push\b|--no-verify|allow-stuck-runner|ALLOW_STUCK_RUNNER|\s--force\b|ubuntu-latest|\bgh\s+workflow\s+run\b|\bgh\s+run\s+rerun\b/;
const WAIT_TOOLS = new Set(['Monitor', 'TaskOutput', 'BashOutput', 'TaskStop', 'KillShell', 'KillBash', 'ScheduleWakeup']);

/** The rubric kind of one event for a judge, or null when the rubric does not name it. */
export function rubricKind(judge: FoldJudge, e: FoldEvent): string | null {
  if (e.kind === 'msg') return 'msg';
  if (e.kind === 'end') return judge === 'async-wait-lifecycle' ? 'turn-end' : null;
  if (e.kind === 'wake') return judge === 'async-wait-lifecycle' || e.failed ? 'wake' : null;
  const text = `${e.command} ${e.tool === 'Skill' ? e.target : ''}`;
  if (judge === 'async-wait-lifecycle') {
    if (e.background || e.movedToBackground) return 'bg-start';
    if (WAIT_TOOLS.has(e.tool) || ((e.tool === 'Agent' || e.tool === 'Task') && e.background)) return 'wait';
    if (POLL.test(text)) return 'wait';
    if (GATE.test(text)) return 'gate';
    return null;
  }
  if (e.retryOf !== null) return 'retry';
  if (GATE.test(text)) return 'gate';
  if (e.status === 'error') return 'failed';
  if (e.blockSignal && (e.tool === 'Bash' || e.tool === 'bash' || e.tool === 'Monitor' || e.tool === 'Skill' || e.tool.startsWith('mcp__'))) return 'block';
  if (CI_READ.test(text)) return 'ci-read';
  return null;
}

/** Kinds that a reader of the rubric needs every instance of (all others: the first, the last, then spread). */
const CORE_KINDS = new Set(['bg-start', 'wake', 'turn-end', 'gate', 'msg', 'retry']);

function plainKind(e: FoldEvent): string {
  if (e.kind !== 'step') return e.kind;
  if (e.tool === 'Agent' || e.tool === 'Task') return 'agent';
  return stepKindOf(e.tool === 'bash' ? 'Bash' : e.tool, e.command || null, e.tool.startsWith('mcp__'));
}

// --- rendering -------------------------------------------------------------------------------------------------------

export function clock(ms: number | null): string {
  if (ms === null) return '+?';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `+${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** One timeline line. Level 0: the target cut to TARGET_COMPACT; 1: the whole short target; 2: also the result excerpt. */
function renderEvent(e: FoldEvent, level: 0 | 1 | 2): string {
  switch (e.kind) {
    case 'end':
      return `${clock(e.at)} -- the agent ends its turn --`;
    case 'msg':
      return `${clock(e.at)} message (${e.origin}): ${level === 0 ? cut(e.excerpt, TARGET_COMPACT) : e.excerpt}`;
    case 'wake':
      return `${clock(e.at)} wake${e.ofSeq !== null ? ` of #${e.ofSeq}` : ''}: ${e.what}`;
    case 'step': {
      const tool = `${e.tool}${e.background ? '[bg]' : ''}`;
      let res: string;
      if (e.status === 'open') res = 'no result';
      else if (e.movedToBackground) res = 'moved to the background';
      else if (e.status === 'error') res = e.exit !== null ? `exit ${e.exit}` : 'error';
      else res = 'ok';
      const target = level === 0 ? cut(e.target, TARGET_COMPACT) : e.target;
      const ex = level === 2 && e.excerpt ? `: ${e.excerpt}` : '';
      return `#${e.seq} ${clock(e.at)} ${tool}${target ? ` ${target}` : ''} => ${res}${ex}${e.retryOf !== null ? ` (retry of #${e.retryOf})` : ''}`;
    }
  }
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** Head and tail of a text inside `max` bytes, with an explicit marker of the elided characters. */
export function headTail(text: string, maxBytes: number, headShare: number): string {
  const t = text.trim();
  if (bytes(t) <= maxBytes) return t;
  const marker = (n: number) => ` [… ${n} chars elided …] `;
  const room = Math.max(0, maxBytes - bytes(marker(t.length)));
  const headB = Math.floor(room * headShare);
  const tailB = room - headB;
  const head = sliceBytes(t, headB, 'head');
  const tail = sliceBytes(t, tailB, 'tail');
  const elided = t.length - head.length - tail.length;
  return `${head}${marker(Math.max(0, elided))}${tail}`;
}

/** The longest head (or tail) of `text` within `max` UTF-8 bytes, never cutting a code point. */
function sliceBytes(text: string, max: number, side: 'head' | 'tail'): string {
  if (max <= 0) return '';
  const cps = Array.from(text);
  let b = 0;
  let n = 0;
  if (side === 'head') {
    for (const c of cps) {
      const cb = bytes(c);
      if (b + cb > max) break;
      b += cb;
      n++;
    }
    return cps.slice(0, n).join('');
  }
  for (let i = cps.length - 1; i >= 0; i--) {
    const cb = bytes(cps[i]!);
    if (b + cb > max) break;
    b += cb;
    n++;
  }
  return cps.slice(cps.length - n).join('');
}

/** A deterministic spread order of the indexes 0..n-1: first, last, then the middles of the open gaps. */
export function spreadOrder(n: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const out = [0, n - 1];
  let gaps: Array<[number, number]> = [[0, n - 1]];
  while (gaps.length > 0) {
    const next: Array<[number, number]> = [];
    for (const [a, b] of gaps) {
      if (b - a < 2) continue;
      const m = Math.floor((a + b) / 2);
      out.push(m);
      next.push([a, m], [m, b]);
    }
    gaps = next;
  }
  return out;
}

export interface FoldResult {
  text: string;
  bytes: number;
  sha256: string;
  /** The events of the session (steps, wakes, messages, ends of turn). */
  events: number;
  kept: number;
  /** The events that the rubric names, and how many of them are kept as a line. */
  rubricEvents: number;
  rubricKept: number;
  /** The seqs of the steps whose line is in the text. */
  keptSeqs: number[];
}

/**
 * Fold a parsed session into a judge text of at most `budgetBytes` UTF-8 bytes. Selection order: the rubric events of
 * the core kinds, then the other rubric events (each kind first, last, then spread), then the result excerpts of the
 * rubric events, then failed steps, then the rest. Every gap is one marker with the count per kind.
 */
export function foldSession(s: ParsedSession, judge: FoldJudge, budgetBytes: number, summary?: { before: string; expected: string } | null): FoldResult {
  if (!isFoldJudge(judge)) throw new Error(`no fold profile for judge ${String(judge).slice(0, 80)}`);
  if (!Number.isInteger(budgetBytes) || budgetBytes < FOLD_MIN_BUDGET) throw new Error(`the fold budget must be an integer of at least ${FOLD_MIN_BUDGET} bytes`);
  const first = foldAttempt(s, judge, budgetBytes, summary ?? null, Math.min(TASK_MAX, Math.floor(budgetBytes * TASK_SHARE)), Math.min(FINAL_MAX, Math.floor(budgetBytes * FINAL_SHARE)));
  if (first.rubricKept === first.rubricEvents) return first;
  // Not every rubric event fits: give the task and the final report less room, and keep the attempt with more of them.
  const tight = foldAttempt(s, judge, budgetBytes, summary ?? null, Math.min(TASK_TIGHT, Math.floor(budgetBytes * TASK_SHARE)), Math.min(FINAL_TIGHT, Math.floor(budgetBytes * FINAL_SHARE)));
  return tight.rubricKept > first.rubricKept ? tight : first;
}

function foldAttempt(s: ParsedSession, judge: FoldJudge, budgetBytes: number, summary: { before: string; expected: string } | null, taskMax: number, finalMax: number): FoldResult {
  const ev = s.events;
  const n = ev.length;
  const rk = ev.map((e) => rubricKind(judge, e));
  const kinds = ev.map((e, i) => (rk[i] !== null ? `${rk[i]}*` : plainKind(e)));
  const rubricEvents = rk.filter((k) => k !== null).length;

  const head = [
    `${JUDGE_TEXT_FORMAT} judge ${judge}: ${s.steps} steps, ${s.turns} turn ends, ${ev.filter((e) => e.kind === 'wake').length} wakes, span ${clock(s.spanMs)}.`,
    'Folded to fit the judge: "[… N elided: kind count …]" stands for N events that are not shown; a kind with * is one that the rubric names.',
  ].join('\n');
  const taskSrc = summary ? `before: ${summary.before}\nexpected: ${summary.expected}\n\n${s.task}` : s.task;
  const task = headTail(normalizeBlock(taskSrc) || '(no task text)', taskMax, 0.75);
  const final = headTail(normalizeBlock(s.final) || '(no final text)', finalMax, 0.5);
  const sections = (timeline: string) =>
    `${head}\n\n== task (the first prompt of the run) ==\n${task}\n\n== timeline (#seq, time from the start, tool, target => result) ==\n${timeline}\n\n== final report (the last agent text) ==\n${final}\n`;
  const fixed = bytes(sections(''));

  // Prefix counts per kind, so the marker of any gap costs O(kinds).
  const kindNames = [...new Set(kinds)].sort();
  const kindIdx = new Map(kindNames.map((k, i) => [k, i]));
  const prefix: Int32Array[] = kindNames.map(() => new Int32Array(n + 1));
  for (let i = 0; i < n; i++) {
    const ki = kindIdx.get(kinds[i]!)!;
    for (let k = 0; k < kindNames.length; k++) prefix[k]![i + 1] = prefix[k]![i]! + (k === ki ? 1 : 0);
  }
  /** The marker of the elided events a..b-1, or '' for an empty gap. */
  const marker = (a: number, b: number): string => {
    if (b <= a) return '';
    const parts = kindNames
      .map((k, i) => [k, prefix[i]![b]! - prefix[i]![a]!] as const)
      .filter(([, c]) => c > 0)
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
      .map(([k, c]) => `${k} ${c}`);
    return `[… ${b - a} elided: ${parts.join(', ')} …]`;
  };

  // The state: the chosen indexes (sorted), the level of each line, and the bytes of the timeline.
  const chosen: number[] = [];
  const level = new Int8Array(n).fill(-1);
  const room = budgetBytes - fixed;
  // Each line costs its bytes + 1 newline (one more than the join writes: the count stays on the safe side).
  const lineCost = (t: string) => (t === '' ? 0 : bytes(t) + 1);
  let total = n > 0 ? lineCost(marker(0, n)) : lineCost('(no tool call)');
  const insertAt = (i: number): number => {
    let lo = 0, hi = chosen.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (chosen[mid]! < i) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  /** Show event i at least at level `to`. False when the budget has no room for it. */
  const raise = (i: number, to: 0 | 1 | 2): boolean => {
    const now = level[i]!;
    if (now >= to) return true;
    let delta: number;
    let pos = -1;
    if (now < 0) {
      pos = insertAt(i);
      const prev = pos > 0 ? chosen[pos - 1]! : -1;
      const next = pos < chosen.length ? chosen[pos]! : n;
      delta = lineCost(marker(prev + 1, i)) + lineCost(renderEvent(ev[i]!, to)) + lineCost(marker(i + 1, next)) - lineCost(marker(prev + 1, next));
    } else {
      delta = lineCost(renderEvent(ev[i]!, to)) - lineCost(renderEvent(ev[i]!, now as 0 | 1 | 2));
    }
    if (total + delta > room) return false;
    total += delta;
    if (pos >= 0) chosen.splice(pos, 0, i);
    level[i] = to;
    return true;
  };
  // Groups: one list per kind; each list in spread order (first, last, middles), round-robin over the kinds.
  const byKind = (pred: (i: number) => boolean): number[][] => {
    const m = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      if (!pred(i)) continue;
      const k = kinds[i]!;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(i);
    }
    return [...m.keys()].sort().map((k) => m.get(k)!);
  };
  const interleave = (groups: number[][]): number[] => {
    const orders = groups.map((g) => spreadOrder(g.length).map((j) => g[j]!));
    const out: number[] = [];
    for (let r = 0; orders.some((o) => r < o.length); r++) for (const o of orders) if (r < o.length) out.push(o[r]!);
    return out;
  };
  const isFailedStep = (i: number) => ev[i]!.kind === 'step' && (ev[i] as FoldStep).status === 'error';
  const core = interleave(byKind((i) => rk[i] !== null && CORE_KINDS.has(rk[i]!)));
  const other = interleave(byKind((i) => rk[i] !== null && !CORE_KINDS.has(rk[i]!)));
  const failed = interleave(byKind((i) => rk[i] === null && isFailedStep(i)));
  const rest = interleave(byKind((i) => rk[i] === null && !isFailedStep(i)));
  const rubric = [...core, ...other];
  if (room > total) {
    for (const i of rubric) raise(i, 0);
    for (const i of rubric) raise(i, 1);
    for (const i of rubric) raise(i, 2);
    for (const i of failed) raise(i, 0);
    for (const i of rest) raise(i, 0);
    for (const i of failed) raise(i, 2);
    for (const i of rest) raise(i, 1);
  }

  const out: string[] = [];
  let prev = -1;
  for (const i of chosen) {
    const m = marker(prev + 1, i);
    if (m) out.push(m);
    out.push(renderEvent(ev[i]!, level[i] as 0 | 1 | 2));
    prev = i;
  }
  const tailMarker = marker(prev + 1, n);
  if (tailMarker) out.push(tailMarker);
  let text = sections(out.length > 0 ? out.join('\n') : '(no tool call)');
  // A hard stop: only a budget near FOLD_MIN_BUDGET with a long header can get here.
  if (bytes(text) > budgetBytes) text = `${sliceBytes(text, budgetBytes - bytes(' [… cut …]\n'), 'head')} [… cut …]\n`;
  return {
    text,
    bytes: bytes(text),
    sha256: createHash('sha256').update(text).digest('hex'),
    events: n,
    kept: chosen.length,
    rubricEvents,
    rubricKept: chosen.filter((i) => rk[i] !== null).length,
    keptSeqs: chosen.filter((i) => ev[i]!.kind === 'step').map((i) => (ev[i] as FoldStep).seq),
  };
}

/** A multi-line block: each line normalized, empty lines dropped. */
function normalizeBlock(text: string): string {
  return text
    .split('\n')
    .map((l) => normalizeText(l))
    .filter((l) => l !== '')
    .join('\n');
}

/** Parse and fold in one call. */
export function foldJudgeText(lines: Iterable<string>, judge: FoldJudge, budgetBytes: number, summary?: { before: string; expected: string } | null): FoldResult {
  return foldSession(parseSessionLines(lines), judge, budgetBytes, summary);
}

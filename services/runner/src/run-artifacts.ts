/**
 * Stored outputs of a hosted run (plan TMA L17, task L17a). The rules — the allowlist, the path rule, the
 * caps, the secret scan and the storage encoding — live in the shared module
 * `@itera/contracts/run-artifacts` (read its header). This file is the runner side: it walks the agent's
 * workspace, reads what the rules allow, and builds `result.json` from the final outcome.
 *
 * Collected per run, in the priority order of the run cap:
 *   result.json        (the worker adds it in front; `collectRunArtifacts` reserves room for it)
 *   agent/stderr.txt   sandbox.stderrTail, only when not empty
 *   agent/trace.jsonl  sandbox.events (the opencode stdout), cut at a line boundary over the file cap
 *   files/<path>       every file the agent ADDED or MODIFIED against the baseline, in path order
 *
 * The grader report (/out/report/report.json) is never read here: it can name hidden tests.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ARTIFACT_MAX_COUNT,
  ARTIFACT_MAX_FILE_BYTES,
  ARTIFACT_MAX_RUN_BYTES,
  RUN_RESULT_FORMAT,
  artifactType,
  isSafeArtifactPath,
  redactSecrets,
  type ArtifactSkipReason,
  type RunArtifact,
  type RunResultArtifact,
  type SkippedArtifact,
} from '@itera/contracts/run-artifacts';
import { changedAgainstBaseline } from './workspace.js';

export const STDERR_ARTIFACT_PATH = 'agent/stderr.txt';
export const TRACE_ARTIFACT_PATH = 'agent/trace.jsonl';
export const RESULT_ARTIFACT_PATH = 'result.json';
export const FILES_PREFIX = 'files/';

/** Room kept under the run cap for `result.json`, which the worker builds AFTER the agent artifacts. */
export const RESULT_RESERVE_BYTES = 64 * 1024;
export const RESULT_RESERVE_COUNT = 1;
/** `result.json.skipped` is bounded, so `result.json` always fits in its reserve. */
export const RESULT_SKIPPED_MAX = 200;

export interface CollectedArtifacts {
  artifacts: RunArtifact[];
  skipped: SkippedArtifact[];
}

export interface CollectOptions {
  /** The workspace that holds OUR baseline repository (prepareWorkspace().dir). */
  baselineDir: string;
  /** The tree the agent returned (runInSandbox outDir). */
  agentTree: string;
  /** opencode stdout: one JSON event per line. */
  events: string;
  stderrTail: string;
  /** The run's model key: redacted as a literal from every text artifact. */
  modelKey: string;
  /** Caps, overridable by a test. Defaults: the shared module's numbers and the result.json reserve. */
  maxFileBytes?: number;
  maxRunBytes?: number;
  maxCount?: number;
  reserveBytes?: number;
  reserveCount?: number;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** A text artifact from already-redacted text. */
export function textArtifact(path: string, text: string): RunArtifact {
  const buf = Buffer.from(text, 'utf8');
  return { path, content: text, encoding: 'utf-8', sha256: sha256(buf), bytes: buf.length };
}

/** A binary artifact (raster image): base64 content, sha256 and bytes of the raw file. */
export function binaryArtifact(path: string, raw: Buffer): RunArtifact {
  return { path, content: raw.toString('base64'), encoding: 'base64', sha256: sha256(raw), bytes: raw.length };
}

/** The marker line appended to a truncated trace. */
export function truncationMarker(droppedBytes: number): string {
  return JSON.stringify({ truncated: true, droppedBytes });
}

/**
 * Keep the FIRST bytes of `text` up to `maxBytes`, cut at a line boundary, and append one marker line
 * `{"truncated":true,"droppedBytes":N}`. The result (marker included) never exceeds `maxBytes`.
 * Returns `text` unchanged when it fits.
 */
export function truncateAtLine(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  // The marker's length depends on the dropped count: size it for the largest possible number.
  const markerRoom = truncationMarker(buf.length).length + 1;
  const room = Math.max(0, maxBytes - markerRoom);
  const window = buf.subarray(0, room);
  const cut = window.lastIndexOf(0x0a);
  const kept = cut >= 0 ? buf.subarray(0, cut + 1) : Buffer.alloc(0);
  return `${kept.toString('utf8')}${truncationMarker(buf.length - kept.length)}\n`;
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** Decode a buffer as UTF-8, or null when it is not valid UTF-8. */
export function decodeUtf8(buf: Buffer): string | null {
  try {
    return utf8Strict.decode(buf);
  } catch {
    return null;
  }
}

/** True for the paths the baseline ignores by design: a dot segment (.env, .git) or node_modules. They are not reported as skipped. */
function ignoredByDesign(path: string): boolean {
  return path.split('/').some((seg) => seg.startsWith('.') || seg === 'node_modules');
}

/**
 * Walk the agent's workspace for the files it added or modified and build the artifact list, with the
 * trace and the stderr tail in front. Applies the per-file cap, the UTF-8 rule, the secret scan and the
 * run cap (count and bytes, with room reserved for result.json). Never throws for a file it cannot read:
 * that file is skipped with reason `unreadable`.
 */
export async function collectRunArtifacts(opts: CollectOptions): Promise<CollectedArtifacts> {
  const maxFileBytes = opts.maxFileBytes ?? ARTIFACT_MAX_FILE_BYTES;
  const maxRunBytes = opts.maxRunBytes ?? ARTIFACT_MAX_RUN_BYTES;
  const maxCount = opts.maxCount ?? ARTIFACT_MAX_COUNT;
  const extra = opts.modelKey ? [opts.modelKey] : [];
  const skipped: SkippedArtifact[] = [];
  const candidates: RunArtifact[] = [];
  const skip = (path: string, reason: ArtifactSkipReason) => skipped.push({ path, reason });

  if (opts.stderrTail.trim() !== '') {
    candidates.push(textArtifact(STDERR_ARTIFACT_PATH, truncateAtLine(redactSecrets(opts.stderrTail, extra), maxFileBytes)));
  }
  if (opts.events.trim() !== '') {
    candidates.push(textArtifact(TRACE_ARTIFACT_PATH, truncateAtLine(redactSecrets(opts.events, extra), maxFileBytes)));
  }

  const changed = (await changedAgainstBaseline(opts.baselineDir, opts.agentTree)).map((c) => c.path).sort();
  for (const path of changed) {
    if (ignoredByDesign(path)) continue;
    const stored = FILES_PREFIX + path;
    if (!isSafeArtifactPath(stored)) {
      skip(stored, 'unsafe_path');
      continue;
    }
    const type = artifactType(path);
    if (!type) {
      skip(stored, 'not_allowed');
      continue;
    }
    const full = join(opts.agentTree, path);
    let st;
    try {
      st = await lstat(full);
    } catch {
      skip(stored, 'unreadable');
      continue;
    }
    if (st.isSymbolicLink()) {
      skip(stored, 'symlink');
      continue;
    }
    if (!st.isFile()) {
      skip(stored, 'not_file');
      continue;
    }
    if (st.size > maxFileBytes) {
      skip(stored, 'too_large');
      continue;
    }
    let raw: Buffer;
    try {
      raw = await readFile(full);
    } catch {
      skip(stored, 'unreadable');
      continue;
    }
    if (type.encoding === 'base64') {
      candidates.push(binaryArtifact(stored, raw));
      continue;
    }
    const text = decodeUtf8(raw);
    if (text === null) {
      skip(stored, 'not_utf8');
      continue;
    }
    const artifact = textArtifact(stored, redactSecrets(text, extra));
    if (artifact.bytes > maxFileBytes) {
      skip(stored, 'too_large');
      continue;
    }
    candidates.push(artifact);
  }

  // The run cap, in priority order (stderr, trace, files in path order), with room for result.json.
  const artifacts: RunArtifact[] = [];
  let bytes = opts.reserveBytes ?? RESULT_RESERVE_BYTES;
  let count = opts.reserveCount ?? RESULT_RESERVE_COUNT;
  for (const c of candidates) {
    if (count + 1 > maxCount || bytes + c.bytes > maxRunBytes) {
      skip(c.path, 'run_cap');
      continue;
    }
    artifacts.push(c);
    bytes += c.bytes;
    count += 1;
  }
  return { artifacts, skipped };
}

// --- result.json

// The same redaction as the API's public run view (apps/api/src/http/runs-router.ts redactText): no
// worker path and no hidden test name leaves the worker inside result.json.
const TMP_PATH_RE = /(?:\/private)?\/(?:tmp|var\/folders|var\/tmp|run\/user)\/[^\s'"`:,)]*/g;
const WORKSPACE_PATH_RE = /\/(?:workspace|work|home\/[^/\s]+|root)\/[^\s'"`:,)]*/g;
const HIDDEN_TEST_RE = /\b[\w./-]*hidden[\w./-]*/gi;

/** Scrub an error text for result.json: secrets (and the model key), tmp/workspace paths, hidden test names. */
export function scrubResultText(text: string, extra: readonly string[] = []): string {
  return redactSecrets(text, extra).replace(TMP_PATH_RE, '<tmp>').replace(WORKSPACE_PATH_RE, '<path>').replace(HIDDEN_TEST_RE, '<hidden-test>');
}

export interface ResultArtifactInput {
  status: string;
  phase: string;
  scoreTotal: number;
  error: string | null;
  model: string | null;
  route: string | null;
  agent: { exitCode: number; timedOut: boolean; durationMs: number; agentErrors: string[] } | null;
  cost: { costUsd: number; tokensIn: number; tokensOut: number } | null | undefined;
  skipped: SkippedArtifact[];
  /** Literals to redact (the run's model key). */
  secrets?: readonly string[];
}

/** Build `result.json` (format tma-run-result/1) from the final outcome. No key, no path, no hidden test name. */
export function buildResultArtifact(input: ResultArtifactInput): RunArtifact {
  const extra = input.secrets ?? [];
  const skipped = input.skipped.slice(0, RESULT_SKIPPED_MAX);
  const result: RunResultArtifact = {
    format: RUN_RESULT_FORMAT,
    status: input.status,
    phase: input.phase,
    scoreTotal: input.scoreTotal,
    error: input.error === null ? null : scrubResultText(input.error, extra),
    model: input.model,
    route: input.route,
    agent: input.agent
      ? { exitCode: input.agent.exitCode, timedOut: input.agent.timedOut, durationMs: input.agent.durationMs, errors: input.agent.agentErrors.map((e) => scrubResultText(e, extra)) }
      : null,
    cost: input.cost ? { usd: input.cost.costUsd, tokensIn: input.cost.tokensIn, tokensOut: input.cost.tokensOut } : null,
    skipped,
  };
  return textArtifact(RESULT_ARTIFACT_PATH, `${JSON.stringify(result, null, 2)}\n`);
}

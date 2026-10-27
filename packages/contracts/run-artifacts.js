// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// Stored outputs of a HOSTED run (plan TMA L17, task L17a; Tainan TG 24004: a detail page exists so that a
// human can LOOK at the real thing). The runner stores them; the API serves them to the run owner on
// GET /runs/:id/artifacts and GET /runs/:id/artifacts/file?path=. Both sides import THIS module: the
// allowlist, the path rule, the caps and the secret scan live here once. Pure functions, no I/O.
//
// What a hosted run stores (services/runner/src/run-artifacts.ts collects; worker.ts adds result.json):
//   result.json         built by the worker from the final outcome (format RUN_RESULT_FORMAT)
//   agent/stderr.txt    the sandbox stderr tail, only when not empty
//   agent/trace.jsonl   the opencode stdout (one JSON event per line), cut at a line boundary over the cap
//   files/<path>        each file the agent ADDED or MODIFIED in its workspace, allowlisted extensions only
// The grader report is NEVER stored: it can name hidden tests. A self-declared run stores nothing
// (contract tma-local-result/1 is numbers only, plan ADR-1).
//
// Storage encoding: ONE public.observations row per artifact —
//   mode = 'observed', output_artifact_ref = ARTIFACT_REF_PREFIX + path ('artifact:' + path),
//   output_artifact_content = the UTF-8 text (encoding 'utf-8') or the base64 text (encoding 'base64'),
//   response_digest = sha256 hex of the RAW bytes (the bytes the API serves after the base64 decode).
// Retention: the rows live as long as the run (observations.run_id references runs on delete cascade).
// The patch keeps its own row (output_artifact_ref = 'patch.diff'); it is listed first by the API.

export const RUN_RESULT_FORMAT = 'tma-run-result/1';
export const ARTIFACT_REF_PREFIX = 'artifact:';
/** The patch of the run: not a stored artifact row of this module, but the first entry of the API list. */
export const PATCH_ARTIFACT_PATH = 'patch.diff';
export const PATCH_CONTENT_TYPE = 'text/x-diff';

/** Raw bytes per artifact. */
export const ARTIFACT_MAX_FILE_BYTES = 512 * 1024;
/** Raw bytes per run, all artifacts together. */
export const ARTIFACT_MAX_RUN_BYTES = 2 * 1024 * 1024;
/** Artifacts per run. */
export const ARTIFACT_MAX_COUNT = 25;
/** The three caps as the API answers them in `limits`. */
export const ARTIFACT_LIMITS = Object.freeze({ maxFileBytes: ARTIFACT_MAX_FILE_BYTES, maxRunBytes: ARTIFACT_MAX_RUN_BYTES, maxCount: ARTIFACT_MAX_COUNT });
/** The longest stored path. */
export const ARTIFACT_MAX_PATH_LENGTH = 200;

/**
 * @typedef {'json' | 'markdown' | 'html' | 'text' | 'image' | 'diff'} ArtifactKind
 * @typedef {'utf-8' | 'base64'} ArtifactEncoding
 * @typedef {{ contentType: string, kind: ArtifactKind, encoding: ArtifactEncoding }} ArtifactTypeEntry
 */

/** @param {string} contentType @param {ArtifactKind} kind @returns {ArtifactTypeEntry} */
const text = (contentType, kind) => Object.freeze({ contentType, kind, encoding: /** @type {const} */ ('utf-8') });
/** @param {string} contentType @returns {ArtifactTypeEntry} */
const image = (contentType) => Object.freeze({ contentType, kind: /** @type {const} */ ('image'), encoding: /** @type {const} */ ('base64') });

/** The allowlist, by lower-case extension. Any other extension is not stored and not served. */
export const ARTIFACT_TYPES = Object.freeze({
  json: text('application/json', 'json'),
  jsonl: text('application/x-ndjson', 'text'),
  md: text('text/markdown', 'markdown'),
  markdown: text('text/markdown', 'markdown'),
  html: text('text/html', 'html'),
  htm: text('text/html', 'html'),
  txt: text('text/plain', 'text'),
  log: text('text/plain', 'text'),
  csv: text('text/csv', 'text'),
  svg: image('image/svg+xml'),
  png: image('image/png'),
  jpg: image('image/jpeg'),
  jpeg: image('image/jpeg'),
  gif: image('image/gif'),
  webp: image('image/webp'),
});

/**
 * The type entry of a path by its extension, or null when the extension is not allowlisted (no
 * extension included). The extension is the text after the LAST dot of the LAST segment.
 * @param {string} path
 * @returns {ArtifactTypeEntry | null}
 */
export function artifactType(path) {
  if (typeof path !== 'string') return null;
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(ARTIFACT_TYPES, ext) ? ARTIFACT_TYPES[/** @type {keyof typeof ARTIFACT_TYPES} */ (ext)] : null;
}

const SAFE_SEGMENT_CHARS = /^[A-Za-z0-9._-]+$/;

/**
 * A path the runner may store and the API may serve: relative, at most ARTIFACT_MAX_PATH_LENGTH
 * characters, only [A-Za-z0-9._/-], no empty segment (so no leading or double slash), no `.` or `..`
 * segment, no segment that starts with a dot (.env, .git), no node_modules segment.
 * @param {unknown} path
 * @returns {path is string}
 */
export function isSafeArtifactPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > ARTIFACT_MAX_PATH_LENGTH) return false;
  for (const seg of path.split('/')) {
    if (seg.length === 0) return false;
    if (!SAFE_SEGMENT_CHARS.test(seg)) return false;
    if (seg.startsWith('.')) return false;
    if (seg === 'node_modules') return false;
  }
  return true;
}

/** The observations.output_artifact_ref of a stored path. @param {string} path */
export function artifactRef(path) {
  return ARTIFACT_REF_PREFIX + path;
}

/** The stored path of an observations.output_artifact_ref, or null when the ref is not an artifact row. @param {unknown} ref */
export function artifactPathOfRef(ref) {
  return typeof ref === 'string' && ref.startsWith(ARTIFACT_REF_PREFIX) ? ref.slice(ARTIFACT_REF_PREFIX.length) : null;
}

// --- Secret scan. The same token shapes as apps/api/src/http/run-actions.ts (copied on purpose: the
// runner must not import the API). Every TEXT artifact passes through it before it is stored. A raster
// image is not scanned (a limitation: a PNG can hold text).

export const REDACTED = '[redacted]';

const KNOWN_TOKEN_RES = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g,
];
/** `Bearer <token>` / `Basic <token>`. */
const BEARER_RE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
/** `authorization: value`, `x-api-key=value` (a header line or a shell assignment). */
const AUTH_HEADER_RE = /\b(authorization|x-api-key|api-key|cookie|set-cookie)\s*[:=]\s*[^\s'"`]+(?:\s+[^\s'"`]+)?/gi;
/**
 * `NAME=value` where NAME ends in key/token/secret/password/passwd/pwd (an env assignment, a query
 * string, a CLI flag). `=` only: a JSON key is handled by JSON_SECRET_RE so the trace stays valid JSON.
 */
const SECRET_ASSIGN_RE = /\b([A-Za-z0-9_-]*(?:key|token|secret|passw(?:or)?d|pwd))=("[^"]*"|'[^']*'|[^\s'"`;|&,)]+)/gi;
/** `"apiKey": "value"` — a JSON string value under a secret-looking key. Only a STRING value is touched. */
const JSON_SECRET_RE = /("[A-Za-z0-9_.-]*(?:api[-_]?key|apikey|token|secret|passw(?:or)?d|credential)[A-Za-z0-9_.-]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every secret-looking token in `text` with REDACTED: each literal of `extra` (the worker passes
 * the run's model key), then the known token shapes. Returns the text unchanged when nothing matches.
 * @param {string} text
 * @param {readonly string[]} [extra]
 */
export function redactSecrets(text, extra = []) {
  let out = String(text);
  for (const literal of extra) {
    if (typeof literal !== 'string' || literal.length < 4) continue;
    out = out.replace(new RegExp(escapeRegExp(literal), 'g'), REDACTED);
  }
  out = out.replace(JSON_SECRET_RE, (_m, head) => `${head}"${REDACTED}"`);
  out = out.replace(AUTH_HEADER_RE, (_m, name) => `${name}: ${REDACTED}`);
  out = out.replace(BEARER_RE, (_m, scheme) => `${scheme} ${REDACTED}`);
  for (const re of KNOWN_TOKEN_RES) out = out.replace(re, REDACTED);
  out = out.replace(SECRET_ASSIGN_RE, (_m, name, value) => {
    const q = value[0] === '"' || value[0] === "'" ? value[0] : '';
    return `${name}=${q}${REDACTED}${q}`;
  });
  return out;
}

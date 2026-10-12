/**
 * Sanitizer for the public GET /runs/:id/actions read (screen 04 event log).
 *
 * run_actions.target holds what the agent touched: a workspace path, a shell command, a pattern or a
 * URL. The runner already makes sandbox paths workspace-relative and cuts to 300 characters, but a
 * shell command can still carry an absolute path, a token, an env assignment or a URL with
 * credentials. A public read must show none of these. This module is dependency free on purpose.
 */

export const ACTION_TARGET_MAX = 200;
/** Cut BEFORE the regexes run, so the work per row stays bounded whatever the table holds. */
const PRE_CUT = 1000;

const REDACTED = "<redacted>";

/** Parsed URL → scheme + host + path. Drops userinfo, query string and fragment (tokens live there). */
function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return "<url>";
  }
}

// Order matters: the URL step runs first so the absolute-path step never sees "//host/path".
const URL_RE = /\b(?:https?|wss?|ftp):\/\/[^\s'"`<>]+/gi;
const BEARER_RE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const AUTH_HEADER_RE = /\b(authorization|x-api-key|api-key|cookie|set-cookie)\s*[:=]\s*[^\s'"`]+(?:\s+[^\s'"`]+)?/gi;
const KNOWN_TOKEN_RES: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g,
];
/** NAME=value or NAME: value where NAME looks like a secret. */
const SECRET_ASSIGN_RE = /\b([A-Za-z_][A-Za-z0-9_]*(?:key|token|secret|passw(?:or)?d|pwd|credential|auth|private)[A-Za-z0-9_]*)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s'"`;|&]+)/gi;
const SECRET_FLAG_RE = /(--?(?:password|passwd|token|secret|api-key|apikey|key|auth)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s'"`;|&]+)/gi;
/** A long opaque run (hex, base64, base58 private key). A run with letters AND digits, no dot. */
const OPAQUE_RE = /[A-Za-z0-9+/_-]{40,}/g;
/** Absolute POSIX path: starts a token. A relative path, `a/b`, and the `//host` of a URL do not match. */
const ABS_PATH_RE = /(?<![\w:/.~$-])(?:\/[^\s'"`;|&<>()]*)+/g;
const HOME_PATH_RE = /(?<![\w:/.~$-])~(?:\/[^\s'"`;|&<>()]*)*/g;
const WIN_PATH_RE = /\b[A-Za-z]:\\[^\s'"`;|&<>()]*/g;
const FILE_URL_RE = /\bfile:\/\/[^\s'"`<>]*/gi;

function hasLetterAndDigit(s: string): boolean {
  return /[A-Za-z]/.test(s) && /\d/.test(s);
}

/**
 * Makes a run_actions.target safe for a public read. Returns null for null or empty input.
 * Output: one line, at most ACTION_TARGET_MAX characters, no absolute path, no secret-looking value.
 */
export function sanitizeActionTarget(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let s = String(raw).slice(0, PRE_CUT).replace(/\s+/g, " ").trim();
  if (!s) return null;

  s = s.replace(FILE_URL_RE, "<path>");
  s = s.replace(URL_RE, (m) => cleanUrl(m));
  s = s.replace(AUTH_HEADER_RE, (_m, name: string) => `${name}: ${REDACTED}`);
  s = s.replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  for (const re of KNOWN_TOKEN_RES) s = s.replace(re, REDACTED);
  s = s.replace(SECRET_ASSIGN_RE, (_m, name: string) => `${name}=${REDACTED}`);
  s = s.replace(SECRET_FLAG_RE, (_m, flag: string) => `${flag}${REDACTED}`);
  s = s.replace(OPAQUE_RE, (m) => (hasLetterAndDigit(m) ? REDACTED : m));
  s = s.replace(WIN_PATH_RE, "<path>").replace(HOME_PATH_RE, "<path>").replace(ABS_PATH_RE, "<path>");

  if (s.length > ACTION_TARGET_MAX) s = `${s.slice(0, ACTION_TARGET_MAX - 1)}…`;
  return s;
}

/** Tool names are short identifiers (`read`, `edit`, `bash`, `mcp_x`). Anything else is cut or replaced. */
export function sanitizeToolName(raw: string): string {
  const cleaned = String(raw).replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);
  return cleaned || "tool";
}

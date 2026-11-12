// The ONE redaction module of the eval kit (plan 20261112-tma-c3-eval-repo-kit-docs T4; parent Q-T9 = A:
// no text leaves the host). A trajectory step carries one free string, `target_redacted`: at most 120
// characters of the tma-trajectory/1 charset. This module is the only writer of that string.
//
// The rule is "keep the shape, drop the content":
//   file, dir   a path relative to the workspace (home → ~); a segment that looks like a secret → <redacted>
//   command     the program and up to two sub-command words of a known tool (git pr view, npm run test), or
//               the script path of any other program (bash x/run.sh set); never a flag, a value or free text
//   url         scheme, host and path; no query, no fragment, no user info
//   pattern     only a short pattern with no space (a sentence is a prompt): else <pattern>
//   agent, skill, mcp, host, repo   a short name in the safe charset, else <name>
// Then the whole string is scanned for a credential, cut to the charset and to 120 characters.
// Arguments, tool output and prompt text never reach this module's output: the readers digest them.
import { TRAJECTORY_MAX_TARGET } from '@itera/contracts';

export type TargetKind = 'file' | 'dir' | 'url' | 'host' | 'repo' | 'agent' | 'skill' | 'mcp' | 'command' | 'pattern' | 'none';

/** The tma-trajectory/1 charset of target_redacted (schemas/trajectory.schema.json). */
export const TARGET_CHARSET = /^[A-Za-z0-9 ._/:@#%+=,()<>[\]*~^!?-]+$/;
const NOT_CHARSET = /[^A-Za-z0-9 ._/:@#%+=,()<>[\]*~^!?-]/g;

/** Credential shapes. A match anywhere replaces the value (or the path segment) with <redacted>. */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}/, // not inside a word (task-fixture)
  /\bbearer\b/i,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\b(password|passwd|secret|token|api[_-]?key|apikey)\s*[=:]/i,
];

/** A long token with letters and at least 4 digits (a key, a hash, a session id). A path segment
 * such as `itera-certificacao-onchain` is not one. */
function highEntropy(piece: string): boolean {
  if (piece.length < 32) return false;
  const digits = (piece.match(/[0-9]/g) ?? []).length;
  return digits >= 4 && /[A-Za-z]/.test(piece);
}

export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text)) || text.split(/[\s/:@=,;()<>"'&?]+/).some(highEntropy);
}

export interface RedactContext {
  /** Folders whose prefix is dropped from a path (the workspace, the session cwd). Longest first wins. */
  roots?: string[];
  /** The home folder: its prefix becomes ~. */
  home?: string;
}

const SUBCOMMAND = /^[a-z][a-z0-9:_-]{0,24}$/;
/** Programs whose first words name a sub-command. For any other program the words after it are free text. */
const SUBCOMMAND_TOOLS = new Set(['git', 'gh', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'docker', 'kubectl', 'helm', 'cargo', 'go', 'pip', 'pip3', 'uv', 'poetry', 'make', 'systemctl', 'journalctl', 'tma', 'supabase', 'terraform', 'aws', 'gcloud', 'az', 'brew', 'apt', 'apt-get', 'dokploy', 'vercel', 'wrangler', 'flyctl', 'tailscale', 'infisical', 'opencode', 'claude', 'codex']);
/** A script or path argument: it has a slash and no space. */
const PATH_WORD = /^[^\s-][^\s]*\/[^\s]*$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$/;

function finish(text: string): string | null {
  const clean = text.replace(NOT_CHARSET, '_').replace(/\s+/g, ' ').trim();
  if (clean === '') return null;
  const cut = clean.length > TRAJECTORY_MAX_TARGET ? clean.slice(0, TRAJECTORY_MAX_TARGET) : clean;
  return TARGET_CHARSET.test(cut) ? cut : null;
}

/** A path: relative to a root, home as ~, a secret-looking segment replaced. */
export function redactPath(raw: string, ctx: RedactContext = {}): string {
  let p = raw.trim().replace(/\\/g, '/');
  const roots = [...(ctx.roots ?? [])].filter(Boolean).map((r) => r.replace(/\/+$/, '')).sort((a, b) => b.length - a.length);
  for (const r of roots) {
    if (p === r) {
      p = '.';
      break;
    }
    if (p.startsWith(`${r}/`)) {
      p = p.slice(r.length + 1);
      break;
    }
  }
  const home = ctx.home?.replace(/\/+$/, '');
  if (home && (p === home || p.startsWith(`${home}/`))) p = `~${p.slice(home.length)}`;
  p = p.replace(/^\/home\/[^/]+(?=\/|$)/, '~').replace(/^\/root(?=\/|$)/, '~').replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
  return p
    .split('/')
    .map((seg) => (looksSecret(seg) || seg.length > 80 ? '<redacted>' : seg))
    .join('/');
}

/** Shell words of a command line (quotes joined and removed, no expansion). `;`, `&&`, `||`, `|` and `&`
 * are words of their own, also when they touch a word (`cat x;`). */
function words(command: string): string[] {
  const out: string[] = [];
  const re = /(?:[^\s"';|&]+|"[^"]*"|'[^']*')+|&&|\|\||[;|&]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) out.push(m[0].replace(/"([^"]*)"|'([^']*)'/g, '$1$2'));
  return out;
}

const SEPARATORS = new Set(['&&', '||', ';', '|', '&']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The program and up to two sub-command or script-path words. No flag, no value, no free argument. */
export function redactCommand(raw: string, ctx: RedactContext = {}): string | null {
  // The first command of a chain; `cd x &&`, `VAR=value` prefixes and `VAR=value;` statements are skipped.
  let w = words(raw.split(/\n/)[0] ?? '');
  for (;;) {
    while (w.length && (ASSIGNMENT.test(w[0]!) || SEPARATORS.has(w[0]!))) w = w.slice(1);
    const sep = w.findIndex((x) => SEPARATORS.has(x));
    if (w[0] === 'cd' && sep > 0) {
      w = w.slice(sep + 1);
      continue;
    }
    if (sep >= 0) w = w.slice(0, sep);
    break;
  }
  if (w.length === 0) return null;
  const prog = w[0]!;
  const parts: string[] = [prog.includes('/') ? redactPath(prog, ctx) : prog.split('/').pop()!];
  if (!NAME.test(parts[0]!) && !parts[0]!.startsWith('~') && !parts[0]!.startsWith('.')) return '<command>';
  const name = parts[0]!.split('/').pop()!;
  if (SUBCOMMAND_TOOLS.has(name)) {
    // git pr view, npm run test, docker compose up: up to two sub-command words.
    for (const x of w.slice(1, 3)) {
      if (!SUBCOMMAND.test(x)) break;
      parts.push(x);
    }
  } else {
    // bash <script> [sub-command], python3 <script>: the script path and one sub-command word after it.
    // Any other argument is free text (echo please rewrite …) and is dropped.
    const arg = w[1];
    if (arg !== undefined && /^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
      parts.push(redactUrl(arg) ?? '<url>');
    } else if (arg !== undefined && PATH_WORD.test(arg)) {
      parts.push(redactPath(arg, ctx));
      if (w[2] !== undefined && SUBCOMMAND.test(w[2])) parts.push(w[2]);
    }
  }
  return parts.join(' ');
}

/** scheme://host/path, with no query, fragment or user info. */
export function redactUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return '<url>';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${u.protocol}<url>`;
  const path = u.pathname
    .split('/')
    .map((seg) => (looksSecret(seg) || seg.length > 60 ? '<redacted>' : seg))
    .join('/');
  return `${u.protocol}//${u.host}${path === '/' ? '' : path}`;
}

/** The redacted target of a step, or null when the step has no target. */
export function redactTarget(kind: TargetKind, raw: string | null | undefined, ctx: RedactContext = {}): string | null {
  if (kind === 'none' || raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  if (value === '') return null;
  let out: string | null;
  switch (kind) {
    case 'file':
    case 'dir':
      out = redactPath(value, ctx);
      break;
    case 'command':
      out = redactCommand(value, ctx);
      break;
    case 'url':
      out = redactUrl(value);
      break;
    case 'pattern':
      // A pattern with a space is a sentence: prompt text, never kept.
      out = value.length <= 60 && !/\s/.test(value) && !looksSecret(value) ? value : '<pattern>';
      break;
    default:
      out = NAME.test(value) && !looksSecret(value) ? value : `<${kind}>`;
  }
  if (out === null) return null;
  if (looksSecret(out.replace(/<redacted>/g, ''))) return '<redacted>';
  return finish(out);
}

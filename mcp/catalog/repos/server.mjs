// repos@2 — a read-only fleet of REAL synthetic git repositories (2 orgs, ~14 repos), served by two
// upstream MCP reference servers from modelcontextprotocol/servers (see manifest.json `upstream`)
// plus ONE tool of our own:
//
//   - @modelcontextprotocol/server-filesystem (Node): list_allowed_directories, list_directory,
//     directory_tree, search_files, read_text_file, read_multiple_files;
//   - mcp-server-git (Python, GitPython): git_log, git_show;
//   - read_file_lines (this file, lines.mjs): a file with LINE NUMBERS, whole or a range. The upstream
//     read tools print raw text, so an agent that must cite `repo:path:line` counted the lines itself
//     and was off by a few (campaign k7). This tool is the only addition to repos@1.
//
// The two upstreams speak stdio only. They run as child processes INSIDE the sidecar, and the base fixture bridges
// them to streamable HTTP with the token, the allow-list and the call log (same pattern as memory@1).
// Only READ tools are in tools.json, so the write tools of both upstreams (write_file, edit_file,
// git_commit, ...) cannot be listed or called: the base refuses every name outside tools.json.
//
// The seed is not a file the upstream reads: fleet.mjs turns it into real repos with git fast-import.
// The state this fixture adds is a READ LOG (/state/readlog.json): every file read, every listing,
// every search and every git call, with repo-relative paths. The export gives it to the mcp_state
// scorer, so a task can assert "the agent read the file it cites" (benchmarks: evidence was read).
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { canonicalJson, EXIT, serve, STATE_DIR } from '/itera/fixture.mjs';
import { buildFleet, REPOS_DIR } from '/itera/server/fleet.mjs';
import { mergeRanges, numberLines, rangeOfRead, splitLines } from './lines.mjs';

/** The path the agent sees. In the image it is a symlink to /state/repos. */
export const PUBLIC_ROOT = process.env.ITERA_REPOS_ROOT ?? '/repos';
export const READLOG_FILE = 'readlog.json';
const FS_TOOLS = new Set(['list_allowed_directories', 'list_directory', 'directory_tree', 'search_files', 'read_text_file', 'read_multiple_files']);
const GIT_TOOLS = new Set(['git_log', 'git_show']);
/** Tools this server runs itself (no upstream). */
const LOCAL_TOOLS = new Set(['read_file_lines']);
const GIT_PYTHON = process.env.ITERA_GIT_PYTHON ?? '/itera/git/venv/bin/python';

const require = createRequire('/itera/upstream/package.json');
const FS_ENTRY = () => require.resolve('@modelcontextprotocol/server-filesystem/dist/index.js');

/**
 * Map an agent path to { repo: "org/name", path: "a/b.md" } (path '' = the repo root), or
 * { repo: null, path: "org" } above the repo level. Null when it is outside the fleet.
 */
export function locate(p, stateDir = STATE_DIR) {
  if (typeof p !== 'string' || p.length === 0) return null;
  const realRoot = join(stateDir, REPOS_DIR);
  const abs = isAbsolute(p) ? p : resolve(PUBLIC_ROOT, p);
  let rel = null;
  for (const root of [PUBLIC_ROOT, realRoot]) {
    const r = relative(root, abs);
    if (!r.startsWith('..') && !isAbsolute(r)) {
      rel = r;
      break;
    }
  }
  if (rel === null) return null;
  const segs = rel.split(/[\\/]/).filter(Boolean);
  if (segs.length < 2) return { repo: null, path: segs.join('/') };
  return { repo: `${segs[0]}/${segs[1]}`, path: segs.length > 2 ? posix.join(...segs.slice(2)) : '' };
}

/** The real path of a regular file under the fleet root, or null (a symlink out of the fleet is refused). */
const realFile = (stateDir, loc) => {
  if (!loc?.repo || !loc.path) return null;
  try {
    const full = join(stateDir, REPOS_DIR, loc.repo, loc.path);
    const real = realpathSync(full);
    return real.startsWith(join(stateDir, REPOS_DIR) + '/') && statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
};

/** Lines of a fleet file (see lines.mjs for the definition), or null when it is not a readable file. */
const fileLines = (stateDir, loc) => {
  const real = realFile(stateDir, loc);
  if (!real) return null;
  try {
    return splitLines(readFileSync(real, 'utf-8'));
  } catch {
    return null;
  }
};

const failure = (text) => ({ isError: true, content: [{ type: 'text', text }] });

/**
 * read_file_lines { path, start?, end? } → the file (or the range) with line numbers, "  42| text".
 * Same reach as the upstream filesystem server: a regular file under /repos. A `.git` entry is refused
 * (the gitlink file is not part of the repository content the task is about).
 */
export function readFileLines(args, stateDir = STATE_DIR) {
  const loc = locate(args.path, stateDir);
  if (!loc) return failure(`Access denied: ${args.path} is outside the allowed directory ${PUBLIC_ROOT}`);
  if (loc.path.split('/').includes('.git')) return failure(`Access denied: ${args.path} is repository metadata`);
  const real = realFile(stateDir, loc);
  if (!real) return failure(`${args.path} is not a file (use list_directory for a directory)`);
  let text;
  try {
    text = readFileSync(real, 'utf-8');
  } catch (err) {
    return failure(`${args.path} could not be read: ${String(err?.message ?? err).slice(0, 120)}`);
  }
  const r = numberLines(text, args.start, args.end);
  return r.ok ? { content: [{ type: 'text', text: r.text }] } : failure(r.error);
}

export function emptyLog() {
  return { files_read: {}, dirs_listed: {}, searches: [], git: [], calls: 0, calls_outside: 0 };
}

/** Add one successful call to the read log. Pure: (log, call) → log. */
export function recordCall(log, name, args, step, stateDir = STATE_DIR) {
  log.calls += 1;
  const fileRead = (p) => {
    const loc = locate(p, stateDir);
    const lines = fileLines(stateDir, loc);
    if (lines === null) {
      if (!loc) log.calls_outside += 1;
      return;
    }
    const id = `${loc.repo}:${loc.path}`;
    const e = log.files_read[id] ?? { id, repo: loc.repo, path: loc.path, reads: 0, first_seq: step, lines: [] };
    e.reads += 1;
    // `lines` = the line ranges the agent has seen in this file, merged (see lines.mjs rangeOfRead).
    const range = rangeOfRead(name, args, lines.length);
    e.lines = mergeRanges([...(e.lines ?? []), ...(range ? [range] : [])]);
    log.files_read[id] = e;
  };
  if (name === 'read_text_file' || name === 'read_file_lines') fileRead(args.path);
  else if (name === 'read_multiple_files') for (const p of args.paths ?? []) fileRead(p);
  else if (name === 'list_directory' || name === 'directory_tree') {
    const loc = locate(args.path, stateDir);
    if (!loc) log.calls_outside += 1;
    else {
      const id = loc.repo ? `${loc.repo}:${loc.path}` : `:${loc.path}`;
      const e = log.dirs_listed[id] ?? { id, repo: loc.repo, path: loc.path, tool: name, count: 0 };
      e.count += 1;
      log.dirs_listed[id] = e;
    }
  } else if (name === 'search_files') {
    const loc = locate(args.path, stateDir);
    log.searches.push({ seq: step, tool: name, repo: loc?.repo ?? null, path: loc?.path ?? null, pattern: String(args.pattern ?? '') });
  } else if (GIT_TOOLS.has(name)) {
    const loc = locate(args.repo_path, stateDir);
    log.git.push({ seq: step, tool: name, repo: loc?.repo ?? null, ...(name === 'git_show' ? { revision: String(args.revision ?? '') } : {}) });
  }
  return log;
}

function stdioClient(name, command, args, env) {
  let client;
  return async () => {
    if (client) return client;
    const c = new Client({ name: `itera-repos-${name}-bridge`, version: '1.0.0' });
    // Only these variables reach the upstream process: no token, no allow-list.
    await c.connect(new StdioClientTransport({ command, args, env, cwd: join(STATE_DIR, REPOS_DIR), stderr: 'ignore' }));
    client = c;
    return client;
  };
}

function upstreamAdapter() {
  const baseEnv = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: join(STATE_DIR, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const fs = stdioClient('fs', process.execPath, [FS_ENTRY(), PUBLIC_ROOT], baseEnv);
  const git = stdioClient('git', GIT_PYTHON, ['-m', 'mcp_server_git', '--repository', PUBLIC_ROOT], { ...baseEnv, PYTHONDONTWRITEBYTECODE: '1' });
  const logPath = join(STATE_DIR, READLOG_FILE);
  let log = emptyLog();
  let expected = [];
  return {
    async verifyTools(tools) {
      // The base runs this BEFORE init, when /repos does not exist yet and the upstreams cannot
      // start. Keep the list; init() compares it with the live upstreams once the fleet exists.
      expected = tools;
    },
    async init({ seed, stateDir }) {
      buildFleet(seed, stateDir);
      writeFileSync(join(stateDir, READLOG_FILE), JSON.stringify(log));
      // Start both upstreams now (the server reports ready only when they answer), and check that
      // their definitions still equal tools.json: a drifted upstream stops the boot with exit 4.
      const pick = (t) => canonicalJson({ name: t.name, description: t.description, inputSchema: t.inputSchema });
      const fsTools = (await (await fs()).listTools()).tools;
      const gitTools = (await (await git()).listTools()).tools;
      for (const t of expected) {
        if (LOCAL_TOOLS.has(t.name)) continue; // ours: there is no upstream definition to compare
        const up = (FS_TOOLS.has(t.name) ? fsTools : gitTools).find((u) => u.name === t.name);
        if (!up || pick(up) !== pick(t)) {
          process.stdout.write(`${JSON.stringify({ event: 'fatal', code: EXIT.tools, error: `upstream tool ${t.name} differs from tools.json` })}\n`);
          process.exit(EXIT.tools);
        }
      }
    },
    async call(name, args, ctx) {
      let out;
      if (LOCAL_TOOLS.has(name)) {
        out = readFileLines(args);
      } else {
        const client = FS_TOOLS.has(name) ? await fs() : GIT_TOOLS.has(name) ? await git() : null;
        if (!client) throw new Error(`unknown tool ${name}`);
        out = await client.callTool({ name, arguments: args });
      }
      if (!out.isError) {
        log = recordCall(log, name, args, ctx.step);
        writeFileSync(logPath, JSON.stringify(log));
      }
      return { content: out.content ?? [], ...(out.isError ? { isError: true } : {}) };
    },
  };
}

if (process.argv[1] === import.meta.filename) {
  await serve(upstreamAdapter());
}

// repos@1 — turn the seed into REAL git repositories (TMA-Q2 = A: real synthetic git repos, not a
// mock of git). One `git fast-import` stream per repo, then one checkout. The commit dates, the
// author and the committer come from the seed, so the same seed gives the same commit SHAs on every
// boot (the export carries the HEAD SHA of every repo).
//
// Layout in the /state tmpfs:
//   /state/repos/<org>/<repo>/        the working tree the agent reads (through /repos, a symlink)
//   /state/repos/<org>/<repo>/.git    a one-line gitlink file, so `directory_tree` stays readable
//   /state/git/<org>/<repo>.git       the git directory (outside the tree the agent lists)
//   /state/repos/.git -> /state/git/_root.git   an empty repo: mcp-server-git needs its
//                                     `--repository` to be a repo, and it only allows repo_path
//                                     values UNDER that path.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPOS_DIR = 'repos';
export const GIT_DIR = 'git';

const BAD_SEGMENT = /^(\.|\.\.|\.git)$/i;

/** Seed paths are relative POSIX paths inside a repo: no `..`, no `.git`, no absolute path. */
export function safeRelPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return p.split('/').every((seg) => seg.length > 0 && !BAD_SEGMENT.test(seg));
}

function git(args, opts = {}) {
  const r = spawnSync('git', args, {
    input: opts.input,
    encoding: opts.input instanceof Buffer ? undefined : 'utf-8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: opts.home ?? '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...(opts.env ?? {}) },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr ?? '').slice(0, 300)}`);
  return String(r.stdout ?? '').trim();
}

const epoch = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error(`bad commit date ${iso}`);
  return Math.floor(t / 1000);
};

/** A `git fast-import` stream for one repo's commits on refs/heads/<branch>. */
export function fastImportStream(repo, branch) {
  const parts = [];
  const data = (text) => {
    const buf = Buffer.from(text, 'utf-8');
    parts.push(Buffer.from(`data ${buf.length}\n`), buf, Buffer.from('\n'));
  };
  repo.commits.forEach((c, i) => {
    const who = `${c.author.name} <${c.author.email}> ${epoch(c.date)} +0000`;
    parts.push(Buffer.from(`commit refs/heads/${branch}\nmark :${i + 1}\nauthor ${who}\ncommitter ${who}\n`));
    data(c.message);
    if (i > 0) parts.push(Buffer.from(`from :${i}\n`));
    for (const path of Object.keys(c.files).sort()) {
      if (!safeRelPath(path)) throw new Error(`unsafe path in ${repo.name}: ${path}`);
      const content = c.files[path];
      if (content === null) {
        parts.push(Buffer.from(`D ${path}\n`));
      } else {
        parts.push(Buffer.from(`M 100644 inline ${path}\n`));
        data(content);
      }
    }
    parts.push(Buffer.from('\n'));
  });
  parts.push(Buffer.from('done\n'));
  return Buffer.concat(parts);
}

/** Build every repo of the seed under stateDir. Returns [{ id, org, repo, head, commits, files }]. */
export function buildFleet(seed, stateDir) {
  const reposRoot = join(stateDir, REPOS_DIR);
  const gitRoot = join(stateDir, GIT_DIR);
  const home = join(stateDir, 'home');
  mkdirSync(reposRoot, { recursive: true });
  mkdirSync(gitRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  // The root repo that mcp-server-git --repository points at (empty, never shown in an export).
  git(['init', '-q', '-b', 'main', `--separate-git-dir=${join(gitRoot, '_root.git')}`, reposRoot], { home });

  const seen = new Set();
  const out = [];
  for (const org of seed.orgs ?? []) {
    for (const repo of org.repos ?? []) {
      const id = `${org.name}/${repo.name}`;
      if (seen.has(id)) throw new Error(`duplicate repo ${id}`);
      seen.add(id);
      const branch = repo.default_branch ?? 'main';
      const work = join(reposRoot, org.name, repo.name);
      const gitDir = join(gitRoot, org.name, `${repo.name}.git`);
      mkdirSync(work, { recursive: true });
      mkdirSync(join(gitRoot, org.name), { recursive: true });
      git(['init', '-q', '-b', branch, `--separate-git-dir=${gitDir}`, work], { home });
      git([`--git-dir=${gitDir}`, 'fast-import', '--quiet', '--done'], { input: fastImportStream(repo, branch), home });
      git([`--git-dir=${gitDir}`, `--work-tree=${work}`, 'checkout', '-q', '-f', branch], { home });
      const head = git([`--git-dir=${gitDir}`, 'rev-parse', 'HEAD'], { home });
      const files = git([`--git-dir=${gitDir}`, 'ls-tree', '-r', '--name-only', 'HEAD'], { home }).split('\n').filter(Boolean).length;
      out.push({ id, org: org.name, repo: repo.name, head, commits: repo.commits.length, files });
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  writeFileSync(join(stateDir, 'fleet.json'), JSON.stringify(out));
  return out;
}

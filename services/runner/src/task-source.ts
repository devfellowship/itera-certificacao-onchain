// User tasks (U19, plan 20261012-itera-testmyagent-ui-refactor): the task folder is read from GitHub
// through the TestMyAgent App at the pinned commit, on every validation and every run (Gate Q5: no
// copy at rest). The folder lands in a per-job temp dir on the TRUSTED side of the worker; the agent
// sandbox still receives only environment/ + public tests (workspace.ts materializeWorkspace), and
// hidden tests only ever reach a grading container (grade.ts).
//
// Needs GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (Infisical /apps/itera-agent-credentials/). The App is
// read-only (Contents: read, Metadata: read). The installation token is minted per job and kept in
// memory only.
import { createSign } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/** Same caps as apps/api/src/github/task-layout.ts. */
export const TASK_FOLDER_MAX_FILES = 1000;
export const TASK_FOLDER_MAX_BYTES = 5 * 1024 * 1024;

export interface TaskPin {
  installationId: number;
  repoFullName: string;
  commitSha: string;
  /** Folder of task.json inside the repo ('.' = root). */
  repoPath: string;
}

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  mode: string;
  sha: string;
  size?: number;
}

/** What the worker needs from GitHub. A fake implements it in tests. */
export interface TaskRepoReader {
  listTree(pin: TaskPin): Promise<{ entries: TreeEntry[]; truncated: boolean }>;
  readBlob(pin: TaskPin, sha: string): Promise<Buffer>;
}

/** The task folder content is not acceptable (a gate failure: the version is invalid). */
export class TaskSourceError extends Error {}
/** GitHub could not be read (a platform failure: retry later, the version is not judged). */
export class GitHubReadError extends Error {}

export class GitHubTaskReader implements TaskRepoReader {
  private readonly tokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(
    private readonly appId: string,
    private readonly privateKeyPem: string,
    private readonly apiBase = 'https://api.github.com',
  ) {}

  /** Null when GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY are not set (user tasks then fail with a clear error). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): GitHubTaskReader | null {
    const id = env.GITHUB_APP_ID;
    const raw = env.GITHUB_APP_PRIVATE_KEY;
    if (!id || !raw) return null;
    const pem = raw.includes('-----BEGIN') ? raw.replace(/\\n/g, '\n') : Buffer.from(raw, 'base64').toString('utf-8');
    return new GitHubTaskReader(id, pem);
  }

  private jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');
    const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: this.appId }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${head}.${body}`);
    return `${head}.${body}.${b64(signer.sign(this.privateKeyPem))}`;
  }

  private async get<T>(path: string, auth: string, method = 'GET'): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'testmyagent-runner', Authorization: auth },
    });
    if (!res.ok) throw new GitHubReadError(`GitHub ${method} ${path.split('?')[0]} -> ${res.status}`);
    return (await res.json()) as T;
  }

  private async token(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return `Bearer ${cached.token}`;
    const out = await this.get<{ token: string; expires_at: string }>(`/app/installations/${installationId}/access_tokens`, `Bearer ${this.jwt()}`, 'POST');
    this.tokens.set(installationId, { token: out.token, expiresAt: Date.parse(out.expires_at) });
    return `Bearer ${out.token}`;
  }

  private repo(pin: TaskPin): string {
    const [owner, name, ...rest] = pin.repoFullName.split('/');
    if (!owner || !name || rest.length) throw new TaskSourceError(`invalid repo name: ${pin.repoFullName}`);
    return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  async listTree(pin: TaskPin) {
    const out = await this.get<{ tree: TreeEntry[]; truncated: boolean }>(
      `/repos/${this.repo(pin)}/git/trees/${encodeURIComponent(pin.commitSha)}?recursive=1`,
      await this.token(pin.installationId),
    );
    return { entries: out.tree, truncated: out.truncated };
  }

  async readBlob(pin: TaskPin, sha: string) {
    const out = await this.get<{ content: string; encoding: string }>(`/repos/${this.repo(pin)}/git/blobs/${encodeURIComponent(sha)}`, await this.token(pin.installationId));
    return Buffer.from(out.content, out.encoding === 'base64' ? 'base64' : 'utf-8');
  }
}

/**
 * Write the task folder at the pinned commit into `dest` (which becomes the task bundle root, the
 * directory that holds task.json). Refuses symlinks, submodules, a truncated tree and folders above
 * the caps; never writes outside `dest`. Returns the number of files written.
 */
export async function fetchTaskFolder(reader: TaskRepoReader, pin: TaskPin, dest: string): Promise<{ files: number; bytes: number }> {
  if (!/^[0-9a-f]{40}$/.test(pin.commitSha)) throw new TaskSourceError('the pinned commit is not a full SHA');
  const tree = await reader.listTree(pin);
  if (tree.truncated) throw new TaskSourceError('the repository tree is too large to read (GitHub truncated it)');
  const prefix = pin.repoPath === '.' ? '' : `${pin.repoPath.replace(/^\/+|\/+$/g, '')}/`;
  const under = tree.entries.filter((e) => e.path.startsWith(prefix) && e.path.length > prefix.length);
  const bad = under.find((e) => e.mode === '120000' || e.type === 'commit');
  if (bad) throw new TaskSourceError(`symbolic links and submodules are not allowed in a task folder: ${bad.path.slice(prefix.length)}`);
  const blobs = under.filter((e) => e.type === 'blob' && !e.path.slice(prefix.length).split('/').includes('node_modules'));
  if (!blobs.some((e) => e.path === `${prefix}task.json`)) throw new TaskSourceError(`no task.json at ${pin.repoPath} in ${pin.repoFullName}@${pin.commitSha.slice(0, 7)}`);
  if (blobs.length > TASK_FOLDER_MAX_FILES) throw new TaskSourceError(`the task folder has ${blobs.length} files (cap ${TASK_FOLDER_MAX_FILES})`);
  const root = resolve(dest);
  let bytes = 0;
  for (const e of blobs) {
    const rel = e.path.slice(prefix.length);
    const target = resolve(root, rel);
    if (!target.startsWith(root + sep)) throw new TaskSourceError(`path escapes the task folder: ${rel}`);
    const content = await reader.readBlob(pin, e.sha);
    bytes += content.length;
    if (bytes > TASK_FOLDER_MAX_BYTES) throw new TaskSourceError(`the task folder is above ${TASK_FOLDER_MAX_BYTES} bytes`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o644 });
  }
  return { files: blobs.length, bytes };
}

/** The pack id of a validated user task version (db/migrations/0009_user_tasks.sql). */
export const USER_PACK_PREFIX = 'user-';
export const isUserPack = (packId: string) => packId.startsWith(USER_PACK_PREFIX);
export const versionIdOfPack = (packId: string) => packId.slice(USER_PACK_PREFIX.length);

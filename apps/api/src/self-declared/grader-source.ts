/**
 * Grader source, planted-bug proof list and judge prompt, read only from Git at the stored digest
 * (plan 20261112-tma-c5-studio-area-web2, task C5-SRC-SERVE; Q cd26fe07 = A; ADR-5: the source and the prompts live in Git,
 * the result store keeps only their digests; ADR-7: the studio never re-scores).
 *
 *   GET /grader-versions/:id/source[?path=<file>]
 *
 * The route reads the stored digest of one grader version (tenant scoped, like GET /grader-versions/:id) and looks for
 * the Git commit whose files hash to that digest. It answers the files of that commit, as text. A digest that no commit
 * of the branch produces is refused (404 digest_not_in_git): the page never shows a file that is not the graded one.
 * There is no write path: every other method answers 405.
 *
 * Digest rules (each one is the rule of the code that wrote the digest):
 *   evaluator-src/1    kit built-in `hidden-tests` (services/evaluator, EVALUATOR_VERSION): sha256 over each
 *                      services/evaluator/src/**.ts file that is not a test, sorted by relative POSIX path, of
 *                      "<path><bytes>" (services/evaluator/src/runner.ts evaluatorDigest). Git source: the TMA repo.
 *   tma-grader-code/1  a library grader graders/<id>/<semver>/ of the eval repo: sha256 over "tma-grader-code/1\n" and,
 *                      per code file sorted by path, "<path>\n<sha256 hex of the bytes>\n" (dfl-evals graders/README.md).
 *                      The proof list is fixtures/<name>/fixture.json (kind mutation) and fixtures/code-mutations.json
 *                      of the same commit.
 *   judge-rubric/1     a judge judges/<id>/<semver>/ of the eval repo: the code digest is sha256(rubric.md)
 *                      (services/runner/src/cli/eval/judge.ts). prompt.md must hash to the prompt_sha256 of the
 *                      grader.json of the same commit, and params.json to the stored params digest when one is stored.
 *
 * Git access: a bare clone per source in TMA_GRADER_SOURCE_DIR, fetched again at most every 5 minutes on a miss. The
 * clone URL can carry a read credential (the eval repo is private): it is never logged, never returned and never part
 * of an error message.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type DigestRule = "evaluator-src/1" | "tma-grader-code/1" | "judge-rubric/1";

/** The stored fields the resolver needs (a subset of GraderVersionDetail). */
export interface StoredGraderVersion {
  graderId: string;
  semver: string;
  kind: "code" | "judge" | "human";
  codeSha256: string;
  rubricSha256: string | null;
  paramsSha256: string | null;
}

export interface SourceFile {
  path: string;
  blobSha: string;
  bytes: number;
}

export interface SourceText {
  path: string;
  blobSha: string;
  text: string;
}

/** One planted bug of a library grader: a mutation fixture or a code mutation (dfl-evals graders/README.md). */
export interface PlantedBug {
  name: string;
  kind: "fixture" | "code-mutation";
  proves: string;
  /** Fixture: the check it must turn red. Code mutation: the fixture whose verdict it must change. */
  target: string | null;
}

export interface GraderSourceView {
  /** "<owner>/<repo>" of the Git source. Never a URL. */
  repo: string;
  /** The oldest commit of the branch whose files give the stored digest. */
  commit: string;
  /** The folder of the files, relative to the repo root. */
  root: string;
  rule: DigestRule;
  /** The files that make the digest (for a judge: the prompt, the rubric and the params). */
  files: SourceFile[];
  /** The asked file (default: the entry file). */
  file: SourceText;
  /** Library code graders only: the planted bugs of the same commit. Null when the version has no proof in Git. */
  proof: PlantedBug[] | null;
  /** Judges only. */
  judge: { prompt: SourceText; rubric: SourceText; params: SourceText | null } | null;
}

export class SourceUnavailableError extends Error {}
export class FileNotInDigestError extends Error {}

/** The largest file the route returns as text. */
export const MAX_FILE_BYTES = 512 * 1024;
const MIN_REFETCH_MS = 5 * 60 * 1000;
const GIT_TIMEOUT_MS = 60_000;
const SEMVER_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** "<owner>/<repo>" from a clone URL or a local path, without user info. */
export function repoName(url: string): string {
  const path = url.replace(/^[a-z+]+:\/\/[^/]*\//i, "").replace(/^[^@/]+@[^:]+:/, "");
  const parts = path.replace(/\.git\/?$/, "").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || "repo";
}

/** A bare clone of one branch of one Git source. Read only: clone, fetch, rev-list, ls-tree, cat-file. */
export class GitMirror {
  readonly name: string;
  private lastFetch = 0;
  private syncing: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly dir: string,
    private readonly options: { branch?: string; minRefetchMs?: number; name?: string; sshKey?: () => Promise<string> } = {},
  ) {
    this.name = options.name ?? repoName(url);
  }

  private get branch() {
    return this.options.branch ?? "main";
  }

  private async run(args: string[], cwd?: string): Promise<Buffer> {
    // A private source (the eval repo) is read over SSH with a read-only deploy key: the key file is given to ssh only.
    const keyPath = this.options.sshKey ? await this.options.sshKey() : null;
    const sshEnv = keyPath ? { GIT_SSH_COMMAND: sshCommand(keyPath) } : {};
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        ["-c", "credential.helper=", "-c", "core.askPass=", ...args],
        {
          cwd,
          encoding: "buffer",
          maxBuffer: 64 * 1024 * 1024,
          timeout: GIT_TIMEOUT_MS,
          env: { ...process.env, ...sshEnv, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
        },
        (err, stdout) => {
          // stderr can hold the clone URL (and its credential): it never reaches the message.
          if (err) return reject(new SourceUnavailableError(`git ${args[0]} failed on ${this.name}`));
          resolve(stdout as Buffer);
        },
      );
    });
  }

  private git(args: string[]): Promise<Buffer> {
    return this.run(["--git-dir", this.dir, ...args]);
  }

  /** Clones on first use; with `refetch`, fetches the branch again when the last fetch is older than the floor. */
  sync(refetch = false): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.doSync(refetch).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async doSync(refetch: boolean): Promise<void> {
    const floor = this.options.minRefetchMs ?? MIN_REFETCH_MS;
    const cloned = await access(join(this.dir, "HEAD")).then(
      () => true,
      () => false,
    );
    if (cloned && !(refetch && Date.now() - this.lastFetch >= floor)) return;
    if (!cloned) {
      await rm(this.dir, { recursive: true, force: true });
      await mkdir(this.dir, { recursive: true });
      await this.run(["clone", "--quiet", "--bare", "--single-branch", "--branch", this.branch, this.url, this.dir]);
    } else {
      await this.git(["fetch", "--quiet", "origin", `+refs/heads/${this.branch}:refs/heads/${this.branch}`]);
    }
    this.lastFetch = Date.now();
  }

  /** Commits of the branch that touch `path`, oldest first. */
  async commitsTouching(path: string): Promise<string[]> {
    const out = (await this.git(["rev-list", "--reverse", `refs/heads/${this.branch}`, "--", path])).toString("utf8");
    return out.split("\n").filter((l) => /^[0-9a-f]{40}$/.test(l));
  }

  /** The tree id of `path` at `commit`, or null when the path does not exist there. */
  async treeOf(commit: string, path: string): Promise<string | null> {
    try {
      return (await this.git(["rev-parse", "--verify", "--quiet", `${commit}:${path}`])).toString("utf8").trim() || null;
    } catch {
      return null;
    }
  }

  /** Every blob under `path` at `commit`, with paths relative to `path`. */
  async files(commit: string, path: string): Promise<SourceFile[]> {
    const out = (await this.git(["ls-tree", "-r", "-z", "--long", commit, "--", `${path}/`])).toString("utf8");
    const prefix = `${path}/`;
    return out
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const [meta, p] = [line.slice(0, line.indexOf("\t")), line.slice(line.indexOf("\t") + 1)];
        const [, type, sha, size] = meta.trim().split(/\s+/);
        return { type, path: p.startsWith(prefix) ? p.slice(prefix.length) : p, blobSha: sha!, bytes: Number(size) };
      })
      .filter((f) => f.type === "blob")
      .map(({ path: p, blobSha, bytes }) => ({ path: p, blobSha, bytes }));
  }

  async blob(sha: string): Promise<Buffer> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new SourceUnavailableError("bad blob id");
    return this.git(["cat-file", "blob", sha]);
  }
}

interface Resolved {
  mirror: GitMirror;
  commit: string;
  root: string;
  rule: DigestRule;
  files: SourceFile[];
  entry: string;
  proof: PlantedBug[] | null;
  judgeFiles: { prompt: SourceFile; rubric: SourceFile; params: SourceFile | null } | null;
}

export interface GraderSourceResolver {
  /** The source view, or null when no commit gives the stored digest. Throws SourceUnavailableError when Git fails. */
  resolve(v: StoredGraderVersion, path?: string): Promise<GraderSourceView | null>;
}

export interface GitGraderSourceOptions {
  /** The TMA repo (kit built-in graders). */
  kit?: GitMirror;
  /** The eval repo (library graders and judges). Absent: those versions do not resolve. */
  evals?: GitMirror;
}

const isText = (b: Buffer) => !b.subarray(0, 8000).includes(0);

export class GitGraderSourceResolver implements GraderSourceResolver {
  private readonly cache = new Map<string, Resolved>();
  private readonly evaluatorDigests = new Map<string, string>();

  constructor(private readonly sources: GitGraderSourceOptions) {}

  private async text(mirror: GitMirror, f: SourceFile): Promise<SourceText> {
    if (f.bytes > MAX_FILE_BYTES) throw new FileNotInDigestError(`${f.path} is larger than ${MAX_FILE_BYTES} bytes`);
    const b = await mirror.blob(f.blobSha);
    if (!isText(b)) throw new FileNotInDigestError(`${f.path} is not a text file`);
    return { path: f.path, blobSha: f.blobSha, text: b.toString("utf8") };
  }

  /** evaluator-src/1 over the tree of services/evaluator/src at one commit. */
  private async evaluatorDigest(mirror: GitMirror, commit: string, root: string): Promise<{ digest: string; files: SourceFile[] } | null> {
    const tree = await mirror.treeOf(commit, root);
    if (!tree) return null;
    const files = (await mirror.files(commit, root)).filter((f) => f.path.endsWith(".ts") && !f.path.endsWith(".test.ts")).sort(byPath);
    let digest = this.evaluatorDigests.get(tree);
    if (!digest) {
      const h = createHash("sha256");
      for (const f of files) {
        h.update(f.path);
        h.update(await mirror.blob(f.blobSha));
      }
      digest = h.digest("hex");
      this.evaluatorDigests.set(tree, digest);
    }
    return { digest, files };
  }

  private async findEvaluator(mirror: GitMirror, v: StoredGraderVersion): Promise<Resolved | null> {
    const root = "services/evaluator/src";
    for (const commit of await mirror.commitsTouching(root)) {
      const d = await this.evaluatorDigest(mirror, commit, root);
      if (d && d.digest === v.codeSha256) {
        const entry = d.files.find((f) => f.path === "runner.ts")?.path ?? d.files[0]?.path;
        if (!entry) return null;
        return { mirror, commit, root, rule: "evaluator-src/1", files: d.files, entry, proof: null, judgeFiles: null };
      }
    }
    return null;
  }

  private async json(mirror: GitMirror, f: SourceFile | undefined): Promise<Record<string, unknown> | null> {
    if (!f || f.bytes > MAX_FILE_BYTES) return null;
    try {
      const v = JSON.parse((await mirror.blob(f.blobSha)).toString("utf8"));
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private async proofOf(mirror: GitMirror, all: SourceFile[]): Promise<PlantedBug[] | null> {
    const out: PlantedBug[] = [];
    for (const f of all.filter((x) => /^fixtures\/[^/]+\/fixture\.json$/.test(x.path)).sort(byPath)) {
      const fx = await this.json(mirror, f);
      if (!fx || fx.kind !== "mutation") continue;
      const expect = fx.expect && typeof fx.expect === "object" ? (fx.expect as Record<string, unknown>) : {};
      out.push({
        name: f.path.split("/")[1]!,
        kind: "fixture",
        proves: typeof fx.proves === "string" ? fx.proves : "",
        target: typeof expect.failed_check === "string" ? expect.failed_check : null,
      });
    }
    const cm = all.find((x) => x.path === "fixtures/code-mutations.json");
    if (cm && cm.bytes <= MAX_FILE_BYTES) {
      try {
        const list = JSON.parse((await mirror.blob(cm.blobSha)).toString("utf8"));
        if (Array.isArray(list))
          for (const m of list)
            if (m && typeof m === "object" && typeof m.name === "string")
              out.push({ name: m.name, kind: "code-mutation", proves: typeof m.proves === "string" ? m.proves : "", target: typeof m.fixture === "string" ? m.fixture : null });
      } catch {
        /* an unreadable list adds nothing */
      }
    }
    return out.length ? out : null;
  }

  private async findLibraryGrader(mirror: GitMirror, v: StoredGraderVersion): Promise<Resolved | null> {
    const root = `graders/${v.graderId}/${v.semver}`;
    for (const commit of await mirror.commitsTouching(root)) {
      const all = await mirror.files(commit, root);
      const manifest = await this.json(mirror, all.find((f) => f.path === "grader.json"));
      if (!manifest || !Array.isArray(manifest.code_files) || typeof manifest.entry !== "string") continue;
      const names = [...new Set(manifest.code_files.filter((p): p is string => typeof p === "string"))].sort();
      const files = names.map((p) => all.find((f) => f.path === p));
      if (!names.length || files.some((f) => !f)) continue;
      let body = "tma-grader-code/1\n";
      for (const f of files as SourceFile[]) body += `${f.path}\n${sha256(await mirror.blob(f.blobSha))}\n`;
      if (sha256(body) !== v.codeSha256) continue;
      const entry = names.includes(manifest.entry) ? manifest.entry : names[0]!;
      return { mirror, commit, root, rule: "tma-grader-code/1", files: files as SourceFile[], entry, proof: await this.proofOf(mirror, all), judgeFiles: null };
    }
    return null;
  }

  private async findJudge(mirror: GitMirror, v: StoredGraderVersion): Promise<Resolved | null> {
    const root = `judges/${v.graderId}/${v.semver}`;
    if (v.rubricSha256 && v.rubricSha256 !== v.codeSha256) return null;
    for (const commit of await mirror.commitsTouching(root)) {
      const all = await mirror.files(commit, root);
      const manifest = await this.json(mirror, all.find((f) => f.path === "grader.json"));
      if (!manifest) continue;
      const pick = (key: string, fallback: string) => all.find((f) => f.path === (typeof manifest[key] === "string" ? (manifest[key] as string) : fallback));
      const rubric = pick("rubric", "rubric.md");
      const prompt = pick("prompt", "prompt.md");
      const params = pick("params", "params.json") ?? null;
      if (!rubric || !prompt) continue;
      if (sha256(await mirror.blob(rubric.blobSha)) !== v.codeSha256) continue;
      // The prompt must be the one the manifest of the same commit pins; the params the stored ones.
      if (typeof manifest.prompt_sha256 !== "string" || sha256(await mirror.blob(prompt.blobSha)) !== manifest.prompt_sha256) continue;
      if (v.paramsSha256 && (!params || sha256(await mirror.blob(params.blobSha)) !== v.paramsSha256)) continue;
      const files = [prompt, rubric, ...(params ? [params] : [])];
      return { mirror, commit, root, rule: "judge-rubric/1", files, entry: prompt.path, proof: null, judgeFiles: { prompt, rubric, params } };
    }
    return null;
  }

  /** The Git sources to search for one version, each with its lookup, in order. */
  private candidates(v: StoredGraderVersion): Array<[GitMirror, (m: GitMirror) => Promise<Resolved | null>]> {
    if (!SHA_RE.test(v.codeSha256) || !ID_RE.test(v.graderId) || !SEMVER_RE.test(v.semver)) return [];
    const out: Array<[GitMirror, (m: GitMirror) => Promise<Resolved | null>]> = [];
    const { kit, evals } = this.sources;
    if (v.kind === "code" && v.graderId === "hidden-tests" && kit) out.push([kit, (m) => this.findEvaluator(m, v)]);
    if (v.kind === "code" && evals) out.push([evals, (m) => this.findLibraryGrader(m, v)]);
    if (v.kind === "judge" && evals) out.push([evals, (m) => this.findJudge(m, v)]);
    return out;
  }

  /** Each source on its own: one that fails (for example the eval repo without a credential) never hides another. */
  private async find(v: StoredGraderVersion): Promise<Resolved | null> {
    let failure: unknown = null;
    for (const [mirror, lookup] of this.candidates(v)) {
      try {
        await mirror.sync(false);
        let hit = await lookup(mirror);
        if (!hit) {
          // A miss may be a commit newer than the clone: fetch once (at most every 5 minutes) and look again.
          await mirror.sync(true);
          hit = await lookup(mirror);
        }
        if (hit) return hit;
      } catch (e) {
        failure ??= e;
      }
    }
    if (failure) throw failure;
    return null;
  }

  async resolve(v: StoredGraderVersion, path?: string): Promise<GraderSourceView | null> {
    if (v.kind === "human") return null;
    const key = `${v.kind}:${v.graderId}@${v.semver}:${v.codeSha256}:${v.rubricSha256 ?? ""}:${v.paramsSha256 ?? ""}`;
    let hit = this.cache.get(key) ?? null;
    if (!hit) {
      hit = await this.find(v);
      if (!hit) return null;
      this.cache.set(key, hit);
    }
    const want = path ?? hit.entry;
    const f = hit.files.find((x) => x.path === want);
    if (!f) throw new FileNotInDigestError(`${want} is not a file of this version`);
    const j = hit.judgeFiles;
    return {
      repo: hit.mirror.name,
      commit: hit.commit,
      root: hit.root,
      rule: hit.rule,
      files: hit.files,
      file: await this.text(hit.mirror, f),
      proof: hit.proof,
      judge: j
        ? { prompt: await this.text(hit.mirror, j.prompt), rubric: await this.text(hit.mirror, j.rubric), params: j.params ? await this.text(hit.mirror, j.params) : null }
        : null,
    };
  }
}

/** ssh for one key only: no agent, no other identity, GitHub host key accepted on first use (as domain/manifests-repo.ts). */
export function sshCommand(keyPath: string): string {
  return `ssh -i "${keyPath}" -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
}

/**
 * The deploy key of the eval repo, as a file path for ssh. TMA_EVALS_DEPLOY_KEY_PATH names a file (local dev);
 * TMA_EVALS_DEPLOY_KEY_B64 holds the private key, base64 encoded (production): it is written once per process, mode
 * 600, into the clone dir. Neither set: no key (an https URL or a local path needs none). The key is never logged.
 */
export function evalsDeployKeyFromEnv(env: NodeJS.ProcessEnv, dir: string): (() => Promise<string>) | undefined {
  const direct = env.TMA_EVALS_DEPLOY_KEY_PATH?.trim();
  if (direct) return async () => direct;
  const b64 = env.TMA_EVALS_DEPLOY_KEY_B64?.trim();
  if (!b64) return undefined;
  let written: Promise<string> | null = null;
  return () => {
    written ??= (async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, "evals-deploy-key");
      const pem = Buffer.from(b64, "base64").toString("utf8");
      await writeFile(path, pem.endsWith("\n") ? pem : `${pem}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
      return path;
    })();
    return written;
  };
}

export const DEFAULT_KIT_REPO_URL = "https://github.com/devfellowship/itera-certificacao-onchain.git";

/**
 * The resolver of the API process. TMA_GRADER_SOURCE=off turns the route off (404). TMA_KIT_REPO_URL overrides the
 * public TMA repo; TMA_EVALS_REPO_URL (unset by default) names the eval repo, which is private: an SSH URL
 * (git@github.com:devfellowship/dfl-evals.git) with a read-only deploy key in TMA_EVALS_DEPLOY_KEY_B64 (or
 * TMA_EVALS_DEPLOY_KEY_PATH), kept in the app env and never printed. TMA_GRADER_SOURCE_DIR holds the bare clones.
 */
export function graderSourceFromEnv(env: NodeJS.ProcessEnv = process.env): GraderSourceResolver | undefined {
  if ((env.TMA_GRADER_SOURCE ?? "").trim().toLowerCase() === "off") return undefined;
  const dir = env.TMA_GRADER_SOURCE_DIR?.trim() || join(tmpdir(), "tma-grader-source");
  const kitUrl = env.TMA_KIT_REPO_URL?.trim() || DEFAULT_KIT_REPO_URL;
  const evalsUrl = env.TMA_EVALS_REPO_URL?.trim();
  return new GitGraderSourceResolver({
    kit: new GitMirror(kitUrl, join(dir, "kit.git")),
    ...(evalsUrl ? { evals: new GitMirror(evalsUrl, join(dir, "evals.git"), { name: env.TMA_EVALS_REPO_NAME?.trim() || repoName(evalsUrl), sshKey: evalsDeployKeyFromEnv(env, join(dir, "keys")) }) } : {}),
  });
}

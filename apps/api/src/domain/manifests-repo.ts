import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { manifestsDeployKeyPath } from "../config.js";

// Commit messages here can carry user-submitted text (the evaluation request description). With
// shell: true on Windows (required for `ssh`/`git` resolution in this environment), each spawn
// arg is still escaped individually by Node, but routing user content through `-F <file>` instead
// of `-m "<text>"` avoids relying on that escaping for anything shell-adjacent.

const REPO_SSH_URL = "git@github.com:D0ingC0des/itera-agent-manifests.git";

export class ManifestsRepoError extends Error {}

/**
 * Commits a single markdown file to the public D0ingC0des/itera-agent-manifests repo, using the
 * deploy key saved to this API's env (see config.ts manifestsDeployKeyPath). GitHub has no native
 * way to restrict a repo to one file type for a direct push via deploy key (branch-protection
 * status checks only apply to pull requests, and a deploy key normally pushes straight to a
 * branch) — so `.md`-only is enforced HERE, in code, before anything ever reaches git. That's the
 * one real enforcement point; nothing on the GitHub side can be trusted to catch a mistake here.
 *
 * Clones fresh (shallow, depth 1) into a scratch directory per call rather than keeping a
 * persistent local clone — simpler and safer for a low-frequency write path (one file per
 * evaluation request), at the cost of a few seconds per call for the clone itself.
 */
export async function commitMarkdownFile(path: string, content: string, commitMessage: string): Promise<{ commitSha: string }> {
  if (!path.endsWith(".md")) {
    throw new ManifestsRepoError(`refusing to write a non-.md file to the manifests repo: ${path}`);
  }
  if (path.includes("..") || path.startsWith("/") || path.includes("\\")) {
    throw new ManifestsRepoError(`invalid path: ${path}`);
  }

  const workDir = await mkdtemp(join(tmpdir(), "itera-manifests-"));
  try {
    const sshCommand = `ssh -i "${manifestsDeployKeyPath()}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    const env = { ...process.env, GIT_SSH_COMMAND: sshCommand };

    await run("git", ["clone", "--depth", "1", REPO_SSH_URL, workDir], process.cwd(), env);

    const filePath = join(workDir, path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");

    await run("git", ["add", path], workDir, env);
    const commitMsgFile = join(workDir, ".git", "ITERA_COMMIT_MSG");
    await writeFile(commitMsgFile, commitMessage, "utf-8");
    const commit = await run(
      "git",
      ["-c", "user.email=api@itera-agent-credentials.devfellowship.com", "-c", "user.name=itera-agent-credentials-api", "commit", "-q", "-F", commitMsgFile],
      workDir,
      env,
    );
    if (commit.code !== 0) {
      throw new ManifestsRepoError(`git commit failed: ${commit.stderr.slice(0, 500)}`);
    }
    const push = await run("git", ["push", "origin", "HEAD"], workDir, env);
    if (push.code !== 0) {
      throw new ManifestsRepoError(`git push failed: ${push.stderr.slice(0, 500)}`);
    }
    const rev = await run("git", ["rev-parse", "HEAD"], workDir, env);
    return { commitSha: rev.stdout.trim() };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env, shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RequestHandler } from "express";

const SHA_RE = /^[0-9a-f]{40}$/;

export interface VersionDeps {
  env?: NodeJS.ProcessEnv;
  /** Test seam: reads the commit file. Default: node:fs readFileSync (utf8). */
  readFile?: (path: string) => string;
  /** Default: `GIT_COMMIT` in the working directory (the Dockerfile `gitsha` stage writes /app/GIT_COMMIT). */
  commitFile?: string;
}

/** The deployed git commit: 40 lowercase hex characters, or `unknown`. Order: GIT_COMMIT env, then the file. */
export function resolveCommit(deps: VersionDeps = {}): string {
  const env = deps.env ?? process.env;
  const valid = (v: unknown): string | null => (typeof v === "string" && SHA_RE.test(v.trim()) ? v.trim() : null);
  const fromEnv = valid(env.GIT_COMMIT);
  if (fromEnv) return fromEnv;
  try {
    const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
    return valid(read(deps.commitFile ?? resolve(process.cwd(), "GIT_COMMIT"))) ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** GET /version. Public, cheap, never cached: the e2e workflow polls it to see when a new build is live. */
export function createVersionHandler(deps: VersionDeps = {}): RequestHandler {
  const commit = resolveCommit(deps);
  return (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ service: "testmyagent-api", commit });
  };
}

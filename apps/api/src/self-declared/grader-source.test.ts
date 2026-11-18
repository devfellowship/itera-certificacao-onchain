/**
 * C5-SRC-SERVE (plan 20261112-tma-c5-studio-area-web2, Q cd26fe07 = A): grader source and judge prompt from Git at the
 * stored digest. A local fixture repo stands in for the TMA repo and the eval repo (no network). Each test compares the
 * served text with `git cat-file blob` of the same commit, and refuses a digest that no commit gives.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { issueSessionToken } from "../auth/session.js";
import { GitGraderSourceResolver, GitMirror, repoName, type StoredGraderVersion } from "./grader-source.js";
import { createGraderVersionsRouter, type GraderVersionDetail, type GraderVersionsReader } from "./grader-versions.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
let root = "";
let work = "";
const git = (...args: string[]) =>
  execFileSync("git", ["-C", work, "-c", "user.email=t@t.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args]).toString().trim();
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(work, path)), { recursive: true });
  writeFileSync(join(work, path), text);
};
const commit = (msg: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
};
const blobAt = (c: string, path: string) => execFileSync("git", ["-C", work, "cat-file", "blob", `${c}:${path}`]).toString("utf8");

/** The reference rule: services/evaluator/src/runner.ts evaluatorDigest, run on a checked-out folder. */
function evaluatorDigestOnDisk(dir: string): string {
  const h = createHash("sha256");
  const files = (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => f.split(sep).join("/"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
  for (const f of files) {
    h.update(f);
    h.update(readFileSync(join(dir, f)));
  }
  return h.digest("hex");
}

/** The reference rule of dfl-evals graders/README.md (tma-grader-code/1). */
function graderCodeDigest(files: Record<string, string>): string {
  let body = "tma-grader-code/1\n";
  for (const p of Object.keys(files).sort()) body += `${p}\n${sha256(files[p]!)}\n`;
  return sha256(body);
}

let evalV1 = "";
let evalV1Commit = "";
let evalV2 = "";
let evalV2Commit = "";
let gradeDigest = "";
let gradeCommit = "";
const rubric = "## Criterion\nDid the agent check CI?\n";
const prompt = "# Judge prompt\nYou grade one run.\n\n{{rubric}}\n";
const params = '{"answer":["pass","fail"],"temperature":0}\n';
let judgeCommit = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "grader-source-"));
  work = join(root, "repo");
  mkdirSync(work);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  // Evaluator v1, then v2 (one source change), then a test-only change (same digest as v2).
  write("services/evaluator/src/runner.ts", "export const EVALUATOR_VERSION = '0.3.0';\n");
  write("services/evaluator/src/drivers/node.ts", "export const node = 1;\n");
  write("services/evaluator/src/runner.test.ts", "test\n");
  evalV1Commit = commit("evaluator v1");
  evalV1 = evaluatorDigestOnDisk(join(work, "services/evaluator/src"));
  write("services/evaluator/src/runner.ts", "export const EVALUATOR_VERSION = '0.6.0';\n");
  evalV2Commit = commit("evaluator v2");
  evalV2 = evaluatorDigestOnDisk(join(work, "services/evaluator/src"));
  write("services/evaluator/src/runner.test.ts", "test 2\n");
  commit("tests only");
  // A library grader with a proof.
  const code = { "grade.py": "print('pass')\n", "lib/util.py": "X = 1\n" };
  gradeDigest = graderCodeDigest(code);
  for (const [p, t] of Object.entries(code)) write(`graders/rules/1.0.0/${p}`, t);
  write(
    "graders/rules/1.0.0/grader.json",
    JSON.stringify({ schema: "tma-grader/1", id: "rules", semver: "1.0.0", kind: "code", entry: "grade.py", code_files: ["lib/util.py", "grade.py"], code_sha256: gradeDigest }),
  );
  write("graders/rules/1.0.0/fixtures/reference/fixture.json", JSON.stringify({ kind: "reference", proves: "a good answer passes", expect: { status: "pass" } }));
  write("graders/rules/1.0.0/fixtures/mutation-file-missing/fixture.json", JSON.stringify({ kind: "mutation", proves: "a missing file fails", expect: { status: "fail", failed_check: "file_exists" } }));
  write("graders/rules/1.0.0/fixtures/code-mutations.json", JSON.stringify([{ name: "exists-dropped", fixture: "mutation-file-missing", proves: "the exists check turns it red", file: "grade.py", edits: [] }]));
  gradeCommit = commit("rules grader");
  // A judge.
  write("judges/ci-check/0.1.0/rubric.md", rubric);
  write("judges/ci-check/0.1.0/prompt.md", prompt);
  write("judges/ci-check/0.1.0/params.json", params);
  write(
    "judges/ci-check/0.1.0/grader.json",
    JSON.stringify({ schema: "tma-grader/1", kind: "judge", id: "ci-check", semver: "0.1.0", prompt: "prompt.md", rubric: "rubric.md", params: "params.json", prompt_sha256: sha256(prompt), rubric_sha256: sha256(rubric), params_sha256: sha256(params) }),
  );
  judgeCommit = commit("judge");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const resolver = () => {
  n += 1;
  return new GitGraderSourceResolver({
    kit: new GitMirror(work, join(root, `kit-${n}.git`), { name: "devfellowship/itera-certificacao-onchain", minRefetchMs: 0 }),
    evals: new GitMirror(work, join(root, `evals-${n}.git`), { name: "devfellowship/dfl-evals", minRefetchMs: 0 }),
  });
};
const code = (graderId: string, semver: string, codeSha256: string): StoredGraderVersion => ({ graderId, semver, kind: "code", codeSha256, rubricSha256: null, paramsSha256: null });

describe("GitGraderSourceResolver", () => {
  it("resolves the kit evaluator at the commit of each digest; the text equals the Git blob", async () => {
    const r = resolver();
    const v1 = await r.resolve(code("hidden-tests", "0.3.0", evalV1));
    expect(v1).toMatchObject({ repo: "devfellowship/itera-certificacao-onchain", commit: evalV1Commit, root: "services/evaluator/src", rule: "evaluator-src/1", proof: null, judge: null });
    expect(v1!.files.map((f) => f.path)).toEqual(["drivers/node.ts", "runner.ts"]);
    expect(v1!.file.path).toBe("runner.ts");
    expect(v1!.file.text).toBe(blobAt(evalV1Commit, "services/evaluator/src/runner.ts"));
    expect(v1!.file.text).toContain("0.3.0");
    // The test-only commit gives the same digest as v2: the oldest commit is the answer.
    const v2 = await r.resolve(code("hidden-tests", "0.6.0", evalV2), "drivers/node.ts");
    expect(v2!.commit).toBe(evalV2Commit);
    expect(v2!.file.text).toBe(blobAt(evalV2Commit, "services/evaluator/src/drivers/node.ts"));
  });

  it("refuses a digest that no commit gives, a human grader, and a file outside the digest", async () => {
    const r = resolver();
    expect(await r.resolve(code("hidden-tests", "0.6.0", "a".repeat(64)))).toBeNull();
    expect(await r.resolve({ ...code("label-ci-check", "1.0.0", evalV2), kind: "human" })).toBeNull();
    await expect(r.resolve(code("hidden-tests", "0.6.0", evalV2), "runner.test.ts")).rejects.toThrow(/not a file of this version/);
  });

  it("resolves a library grader by tma-grader-code/1 with its planted bugs from the same commit", async () => {
    const v = await resolver().resolve(code("rules", "1.0.0", gradeDigest));
    expect(v).toMatchObject({ repo: "devfellowship/dfl-evals", commit: gradeCommit, root: "graders/rules/1.0.0", rule: "tma-grader-code/1" });
    expect(v!.files.map((f) => f.path)).toEqual(["grade.py", "lib/util.py"]);
    expect(v!.file.text).toBe(blobAt(gradeCommit, "graders/rules/1.0.0/grade.py"));
    expect(v!.proof).toEqual([
      { name: "mutation-file-missing", kind: "fixture", proves: "a missing file fails", target: "file_exists" },
      { name: "exists-dropped", kind: "code-mutation", proves: "the exists check turns it red", target: "mutation-file-missing" },
    ]);
    expect(await resolver().resolve(code("rules", "1.0.0", "b".repeat(64)))).toBeNull();
  });

  it("resolves a judge: the rubric digest, the pinned prompt and the stored params; any other digest is refused", async () => {
    const stored: StoredGraderVersion = { graderId: "ci-check", semver: "0.1.0", kind: "judge", codeSha256: sha256(rubric), rubricSha256: sha256(rubric), paramsSha256: sha256(params) };
    const v = await resolver().resolve(stored);
    expect(v).toMatchObject({ commit: judgeCommit, root: "judges/ci-check/0.1.0", rule: "judge-rubric/1" });
    expect(v!.file.path).toBe("prompt.md");
    expect(v!.judge!.prompt.text).toBe(blobAt(judgeCommit, "judges/ci-check/0.1.0/prompt.md"));
    expect(v!.judge!.rubric.text).toBe(blobAt(judgeCommit, "judges/ci-check/0.1.0/rubric.md"));
    expect(v!.judge!.params!.text).toBe(params);
    expect(await resolver().resolve({ ...stored, paramsSha256: "c".repeat(64) })).toBeNull();
    expect(await resolver().resolve({ ...stored, codeSha256: "d".repeat(64), rubricSha256: "d".repeat(64) })).toBeNull();
  });

  it("fetches again on a miss, so a commit made after the clone resolves", async () => {
    const r = resolver();
    expect(await r.resolve(code("hidden-tests", "0.6.0", evalV1))).not.toBeNull();
    write("services/evaluator/src/runner.ts", "export const EVALUATOR_VERSION = '0.7.0';\n");
    const c = commit("evaluator v3");
    const v3 = evaluatorDigestOnDisk(join(work, "services/evaluator/src"));
    const v = await r.resolve(code("hidden-tests", "0.7.0", v3));
    expect(v!.commit).toBe(c);
    expect(v!.file.text).toBe(blobAt(c, "services/evaluator/src/runner.ts"));
  });

  it("names a repo without the user info of its URL", () => {
    expect(repoName("https://x-access-token:secret@github.com/devfellowship/dfl-evals.git")).toBe("devfellowship/dfl-evals");
    expect(repoName("git@github.com:devfellowship/dfl-evals.git")).toBe("devfellowship/dfl-evals");
  });

  it("never puts the clone URL in an error", async () => {
    const r = new GitGraderSourceResolver({ kit: new GitMirror("https://user:hunter2@127.0.0.1:1/x/y.git", join(root, "bad.git"), { name: "x/y" }) });
    const err = await r.resolve(code("hidden-tests", "0.6.0", evalV2)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain("hunter2");
  });
});

describe("GET /grader-versions/:id/source", () => {
  const ALICE = "dfl:00000000-0000-4000-8000-00000000000a";
  const GV = "1b6f3c2e-1d4a-4c8e-9f00-123456789abc";
  const GV_LOST = "2b6f3c2e-1d4a-4c8e-9f00-123456789abc";
  const token = () => issueSessionToken(ALICE, Date.now(), "dfl").token;
  const row = (id: string, codeSha256: string): GraderVersionDetail => ({
    id, graderId: "hidden-tests", semver: "0.6.0", kind: "code", codeSha256, judgeModelId: null, createdAt: "2026-11-17T00:00:00.000Z", usedByCount: 1,
    rubricSha256: null, paramsSha256: null, testSplitSha256: null, tpr: null, tnr: null, proof: null, calibration: null, note: null, author: null, recentRuns: [],
  });
  const reader: GraderVersionsReader = {
    ready: async () => true,
    list: async () => [],
    detail: async (id, tenant) => (tenant !== "devfellowship" ? null : id === GV ? row(GV, evalV2) : id === GV_LOST ? row(GV_LOST, "e".repeat(64)) : null),
  };
  let server: Server;
  let base = "";
  beforeEach(async () => {
    const app = express();
    app.use(createGraderVersionsRouter(reader, { tenant: "devfellowship", source: resolver() }));
    server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  const call = async (path: string, init: RequestInit = {}, auth = true) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: auth ? { authorization: `Bearer ${token()}` } : {} });
    return { status: res.status, json: (await res.json()) as any };
  };

  it("serves the file at the stored digest; the text equals the Git blob", async () => {
    const r = await call(`/grader-versions/${GV}/source`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ commit: evalV2Commit, rule: "evaluator-src/1", file: { path: "runner.ts" } });
    expect(r.json.file.text).toBe(blobAt(evalV2Commit, "services/evaluator/src/runner.ts"));
    const d = await call(`/grader-versions/${GV}/source?path=drivers/node.ts`);
    expect(d.json.file.text).toBe(blobAt(evalV2Commit, "services/evaluator/src/drivers/node.ts"));
  });

  it("answers 401 without a session, 404 for a digest not in Git and an unknown id, 400 for a bad path", async () => {
    expect((await call(`/grader-versions/${GV}/source`, {}, false)).status).toBe(401);
    expect(await call(`/grader-versions/${GV_LOST}/source`)).toMatchObject({ status: 404, json: { error: "digest_not_in_git" } });
    expect((await call("/grader-versions/3b6f3c2e-1d4a-4c8e-9f00-123456789abc/source")).status).toBe(404);
    expect((await call(`/grader-versions/${GV}/source?path=../../etc/passwd`)).status).toBe(400);
    expect(await call(`/grader-versions/${GV}/source?path=runner.test.ts`)).toMatchObject({ status: 404, json: { error: "file_not_in_digest" } });
  });

  it("has no write path: every other method answers 405", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect((await call(`/grader-versions/${GV}/source`, { method })).status).toBe(405);
  });
});

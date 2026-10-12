import { validateTaskContract, type TaskContract } from "@itera/contracts";
import { OPEN_TESTS_LABEL, SEALED_TESTS_LABEL } from "../domain/reputation.js";
import type { GitHubAppApi, TreeEntry } from "./app-client.js";

/**
 * Reads the Harbor-shaped layout of a user task at a pinned commit through the GitHub App (U19,
 * Gate Q4/Q5): task.json (checked with the JSON Schema of packages/contracts), and the presence of
 * instruction, environment/, tests/public, tests/hidden and the solution patch. Nothing is stored:
 * the runner reads the same folder again at the same commit for every validation and every run.
 *
 * The full checks (lockfile registry, protected paths cover the tests, the gate itself) run in the
 * runner with services/evaluator's loadTask. This is the fast pre-check that the task editor shows.
 */

/** Caps of one task folder. The runner applies the same caps when it fetches the folder. */
export const TASK_FOLDER_MAX_FILES = 1000;
export const TASK_FOLDER_MAX_BYTES = 5 * 1024 * 1024;
const TASK_JSON_MAX_BYTES = 64 * 1024;

export class TaskPathError extends Error {}

/** "" / "." / "/" → "."; strips slashes; refuses "..". Same rule as the agent path. */
export function normalizeTaskPath(input: unknown): string {
  if (input === undefined || input === null) return ".";
  if (typeof input !== "string") throw new TaskPathError("path must be a string");
  const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "" || trimmed === ".") return ".";
  const parts = trimmed.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw new TaskPathError("path must be a plain relative directory");
  if (trimmed.length > 200) throw new TaskPathError("path is too long");
  return parts.join("/");
}

export interface LayoutEntry {
  key: "taskJson" | "instruction" | "environment" | "testsPublic" | "testsHidden" | "solution";
  path: string;
  present: boolean;
  /** Files under a directory entry. */
  files?: number;
}

export type TaskLayout =
  | {
      ok: true;
      contract: TaskContract;
      entries: LayoutEntry[];
      fileCount: number;
      totalBytes: number;
    }
  | {
      ok: false;
      /** Machine code for the editor: no_task_json | bad_json | schema | missing_entries | too_large | symlink | truncated */
      errorCode: string;
      error: string;
      contract: TaskContract | null;
      entries: LayoutEntry[];
      schemaErrors?: string[];
    };

const isBlob = (e: TreeEntry) => e.type === "blob";

export async function readTaskLayout(
  gh: GitHubAppApi,
  installationId: number,
  repoFullName: string,
  commitSha: string,
  taskPath: string,
): Promise<TaskLayout> {
  const tree = await gh.listTree(installationId, repoFullName, commitSha);
  const prefix = taskPath === "." ? "" : `${taskPath}/`;
  const under = tree.entries.filter((e) => e.path.startsWith(prefix) && e.path.length > prefix.length);
  const rel = (e: TreeEntry) => e.path.slice(prefix.length);
  const fail = (errorCode: string, error: string, extra: Partial<Extract<TaskLayout, { ok: false }>> = {}): TaskLayout => ({
    ok: false,
    errorCode,
    error,
    contract: null,
    entries: [],
    ...extra,
  });

  if (tree.truncated) return fail("truncated", "the repository tree is too large to read (GitHub truncated it)");
  const taskJson = under.find((e) => isBlob(e) && rel(e) === "task.json");
  if (!taskJson) return fail("no_task_json", `no task.json at ${taskPath === "." ? "the repo root" : taskPath} in ${repoFullName}@${commitSha.slice(0, 7)}`);

  const link = under.find((e) => e.mode === "120000" || e.type === "commit");
  if (link) return fail("symlink", `symbolic links and submodules are not allowed in a task folder: ${rel(link)}`);
  const blobs = under.filter(isBlob).filter((e) => !rel(e).split("/").includes("node_modules"));
  const totalBytes = blobs.reduce((a, e) => a + (e.size ?? 0), 0);
  if (blobs.length > TASK_FOLDER_MAX_FILES || totalBytes > TASK_FOLDER_MAX_BYTES) {
    return fail("too_large", `the task folder has ${blobs.length} files / ${totalBytes} bytes; the caps are ${TASK_FOLDER_MAX_FILES} files and ${TASK_FOLDER_MAX_BYTES} bytes`);
  }
  if ((taskJson.size ?? 0) > TASK_JSON_MAX_BYTES) return fail("too_large", "task.json is larger than 64 KB");

  let parsed: unknown;
  try {
    parsed = JSON.parse((await gh.readBlob(installationId, repoFullName, taskJson.sha)).toString("utf-8"));
  } catch {
    return fail("bad_json", "task.json is not valid JSON");
  }
  const checked = validateTaskContract(parsed);
  if (!checked.ok) {
    return fail("schema", "task.json does not match the task schema", { schemaErrors: checked.errors.slice(0, 20) });
  }
  const c = checked.value;
  const fileAt = (p: string) => blobs.some((e) => rel(e) === p);
  const filesIn = (p: string) => blobs.filter((e) => rel(e).startsWith(`${p}/`)).length;
  const entries: LayoutEntry[] = [
    { key: "taskJson", path: "task.json", present: true },
    { key: "instruction", path: c.instruction, present: fileAt(c.instruction) },
    { key: "environment", path: c.environment.dir, present: filesIn(c.environment.dir) > 0, files: filesIn(c.environment.dir) },
    { key: "testsPublic", path: c.tests.public, present: filesIn(c.tests.public) > 0, files: filesIn(c.tests.public) },
    { key: "testsHidden", path: c.tests.hidden, present: filesIn(c.tests.hidden) > 0, files: filesIn(c.tests.hidden) },
    { key: "solution", path: c.solution.patch, present: fileAt(c.solution.patch) },
  ];
  const missing = entries.filter((e) => !e.present);
  if (missing.length > 0) {
    return fail("missing_entries", `task.json names entries that are missing at this commit: ${missing.map((e) => e.path).join(", ")}`, {
      contract: c,
      entries,
    });
  }
  return { ok: true, contract: c, entries, fileCount: blobs.length, totalBytes };
}

/**
 * Q7 + U27 sealed-test rule (domain/reputation.ts): a private repo seals the hidden tests and the task
 * is ranked; a public repo has open tests and is never ranked. Ranking itself is isRankedTask().
 */
export function labelsFor(repoPrivate: boolean): string[] {
  return repoPrivate ? [SEALED_TESTS_LABEL] : [OPEN_TESTS_LABEL];
}

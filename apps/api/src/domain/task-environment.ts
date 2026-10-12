/**
 * The tool environment of a task version (ADR-11, U28): built-in tools and MCP servers the agent may
 * call. Source, in order:
 *   1. task_versions.contract.environment, when the stored contract has an environment block
 *      (user tasks: U19 stores the task.json read through the GitHub App at the pinned commit);
 *   2. the curated pack's task.json under benchmarks/<pack_id>/ (vendored in the API image);
 *   3. the default environment (every built-in tool, no MCP server).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toolEnvironment, validateTaskContract, type ToolEnvironment } from "@itera/contracts";
import { REPO_ROOT } from "./paths.js";

const PACK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const packCache = new Map<string, ToolEnvironment | null>();

function packEnvironment(packId: string, root: string): ToolEnvironment | null {
  const key = `${root}\0${packId}`;
  if (packCache.has(key)) return packCache.get(key)!;
  let env: ToolEnvironment | null = null;
  try {
    const checked = validateTaskContract(JSON.parse(readFileSync(join(root, "benchmarks", packId, "task.json"), "utf-8")));
    if (checked.ok) env = toolEnvironment(checked.value);
  } catch {
    env = null; // no task.json for this pack (a legacy scenario.json-only pack): the default applies
  }
  packCache.set(key, env);
  return env;
}

export function taskToolEnvironment(task: { packId?: string | null; contract?: unknown }, root: string = REPO_ROOT): ToolEnvironment {
  const contract = task.contract;
  if (contract && typeof contract === "object" && "environment" in contract) {
    const env = (contract as { environment?: unknown }).environment;
    if (env && typeof env === "object") return toolEnvironment(contract as { environment: Record<string, unknown> });
  }
  if (task.packId && PACK_ID_RE.test(task.packId)) {
    const env = packEnvironment(task.packId, root);
    if (env) return env;
  }
  return toolEnvironment(null);
}

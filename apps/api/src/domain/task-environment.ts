/**
 * The tool environment of a task version (ADR-11, U28): built-in tools and MCP servers the agent may
 * call. Source: task_versions.contract.environment (user tasks: U19 stores the task.json read
 * through the GitHub App at the pinned commit; curated tasks: the seed, 0011 fills webhook-ledger).
 * The API image does not ship benchmarks/ (#71), so the DB row is the only source here.
 * A contract without an environment block gets the default (every built-in tool, no MCP server).
 */
import { toolEnvironment, type ToolEnvironment } from "@itera/contracts";

export function taskToolEnvironment(task: { contract?: unknown }): ToolEnvironment {
  const contract = task.contract;
  if (contract && typeof contract === "object") {
    const env = (contract as { environment?: unknown }).environment;
    if (env && typeof env === "object") return toolEnvironment(contract as { environment: Record<string, unknown> });
  }
  return toolEnvironment(null);
}

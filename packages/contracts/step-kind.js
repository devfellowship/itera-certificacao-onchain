// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// The tma-trajectory/2 step kind of one tool call (plan 20261112-tma-c4-result-store-trajectory-upload, T10). ONE
// mapping for the hosted runner (services/runner/src/trace.ts, at write time) and the API back-fill of the hosted rows
// written before migration 0024 (POST /eval-results/recompute). Close to the layer-1 intent rules of the fleet
// trajectory: build/test -> test, file-read -> read, search -> search, file-edit and git-write -> write, MCP and skill
// runs -> mcp, a sub-agent -> agent.

const READ_TOOLS = new Set(['read', 'list', 'ls', 'webfetch', 'todoread']);
const SEARCH_TOOLS = new Set(['glob', 'grep', 'codesearch', 'websearch']);
const WRITE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit']);
const GIT_WRITE = new Set([
  'add', 'commit', 'push', 'pull', 'checkout', 'switch', 'restore', 'reset', 'merge', 'rebase', 'stash', 'rm', 'mv', 'tag', 'init',
  'clone', 'cherry-pick', 'revert', 'am', 'apply', 'clean',
]);
const TEST_COMMAND = new RegExp([
  String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t|lint|check|typecheck|build)\b`,
  String.raw`\b(?:vitest|jest|mocha|ava|tsc|eslint|biome|prettier\s+--check|playwright\s+test)\b`,
  String.raw`\b(?:pytest|tox|nox|ruff|mypy|flake8|pylint)\b`,
  String.raw`\bpython3?\s+-m\s+(?:pytest|unittest|py_compile|compileall)\b`,
  String.raw`\b(?:go|cargo|mvn|gradle|dotnet|mix|deno)\s+test\b`,
  String.raw`\bcargo\s+(?:build|check|clippy)\b`,
  String.raw`\bmake\s+(?:test|check|lint)\b`,
  String.raw`\bnode\s+--test\b`,
].join('|'));
const READ_COMMAND = /^(?:cat|head|tail|less|more|ls|tree|wc|stat|file|sed\s+-n)\b/;
const SEARCH_COMMAND = /^(?:grep|egrep|rg|ag|find|fd|ack)\b/;
/** The first command of a shell line, after `cd <dir> &&` and leading VAR=value assignments. */
const FIRST_COMMAND = /^(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/;

/**
 * The step kind of one call. `command` is the shell line of a bash call (null otherwise); `isMcp` says that the tool
 * belongs to an MCP server of the run.
 * @param {string} tool
 * @param {string | null} command
 * @param {boolean} isMcp
 * @returns {import('./index.js').StepKind}
 */
export function stepKindOf(tool, command, isMcp) {
  if (isMcp) return 'mcp';
  const name = tool.toLowerCase();
  if (READ_TOOLS.has(name)) return 'read';
  if (SEARCH_TOOLS.has(name)) return 'search';
  if (WRITE_TOOLS.has(name)) return 'write';
  if (name === 'task') return 'agent';
  if (name === 'skill') return 'mcp';
  if (name !== 'bash') return 'other';
  const cmd = (command ?? '').trim();
  const first = cmd.replace(FIRST_COMMAND, '');
  const git = /^git\s+(?:-C\s+\S+\s+)?([a-z-]+)/.exec(first);
  if (git) return GIT_WRITE.has(/** @type {string} */ (git[1])) ? 'write' : 'shell';
  if (TEST_COMMAND.test(cmd)) return 'test';
  if (READ_COMMAND.test(first)) return 'read';
  if (SEARCH_COMMAND.test(first)) return 'search';
  return 'shell';
}

/** Every opencode tool name the hosted runner can record that is not an MCP tool. */
export const OPENCODE_TOOL_NAMES = /** @type {const} */ ([
  'read', 'write', 'edit', 'patch', 'multiedit', 'glob', 'grep', 'list', 'ls', 'todowrite', 'todoread', 'webfetch', 'websearch',
  'codesearch', 'bash', 'task', 'skill', 'invalid',
]);
const OPENCODE = new Set(OPENCODE_TOOL_NAMES);
/** opencode names an MCP tool `<server>_<tool>` (for example repos_read_file_lines, browser_browser_navigate). */
const MCP_TOOL_NAME = /^[a-z0-9][a-z0-9-]*_[a-z0-9_-]+$/i;

/**
 * The step kind of a stored hosted row (run_actions written before 0024): only `tool` and `target` are known. The MCP
 * server list of the run is not stored, so an MCP tool is told by its name: not an opencode tool and `<server>_<tool>`.
 * The target of a bash row is its command (the runner stores the command as the target).
 * @param {string} tool
 * @param {string | null} target
 * @returns {import('./index.js').StepKind}
 */
export function hostedStepKindOf(tool, target) {
  const name = tool.toLowerCase();
  const isMcp = !OPENCODE.has(name) && MCP_TOOL_NAME.test(tool);
  return stepKindOf(tool, name === 'bash' ? target : null, isMcp);
}

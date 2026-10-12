// The tool environment of a task (ADR-11, plan 20261012-itera-testmyagent-ui-refactor, U28):
// which harness built-in tools and which MCP servers the agent may call during a run, and the
// compatibility check of an agent's `requires` against it. Pure functions, no I/O.
//
// Vocabulary (docs/contracts/GLOSSARY.md): Inspect AI calls these the tools given to the Solver;
// Valkyrie calls the run boundaries run_egress / secrets / resources.

/** Harness built-in tools, neutral names (task.schema.json $defs/builtinTool). */
export const BUILTIN_TOOLS = /** @type {const} */ (['read', 'write', 'edit', 'bash', 'search', 'list', 'todo']);

/** Neutral name → opencode tool names (the built-in run profile). U29 writes the opencode config from it. */
export const OPENCODE_BUILTIN_TOOLS = Object.freeze({
  read: ['read'],
  write: ['write'],
  edit: ['edit', 'patch'],
  bash: ['bash'],
  search: ['grep', 'glob'],
  list: ['list'],
  todo: ['todowrite', 'todoread'],
});

/** What a task without tool-environment keys gets: today's behaviour of the opencode profile. */
export const DEFAULT_TOOL_ENVIRONMENT = Object.freeze({
  builtin: [...BUILTIN_TOOLS],
  mcp: [],
  run_egress: ['model-gateway'],
  secrets: [],
  resources: {},
});

/**
 * The normalized tool environment of a parsed task.json (defaults filled in).
 * @param {{ environment?: Record<string, any> } | null | undefined} contract
 * @returns {import('./index.js').ToolEnvironment}
 */
export function toolEnvironment(contract) {
  const env = contract?.environment ?? {};
  const tools = env.tools ?? {};
  return {
    builtin: Array.isArray(tools.builtin) ? [...tools.builtin] : [...DEFAULT_TOOL_ENVIRONMENT.builtin],
    mcp: Array.isArray(tools.mcp)
      ? tools.mcp.map((/** @type {any} */ s) => ({ ...s, expose_state_to_scorer: s.expose_state_to_scorer === true }))
      : [],
    run_egress: Array.isArray(env.run_egress) ? [...env.run_egress] : [...DEFAULT_TOOL_ENVIRONMENT.run_egress],
    secrets: Array.isArray(env.secrets) ? [...env.secrets] : [],
    resources: env.resources && typeof env.resources === 'object' ? { ...env.resources } : {},
  };
}

/**
 * Rules of the tool environment that a JSON Schema cannot say. Returns error strings (empty = ok).
 * @param {any} contract a task.json that already matches the schema
 * @returns {string[]}
 */
export function toolEnvironmentErrors(contract) {
  /** @type {string[]} */
  const errors = [];
  const env = contract.environment ?? {};
  const servers = env.tools?.mcp ?? [];
  const egress = env.run_egress ?? DEFAULT_TOOL_ENVIRONMENT.run_egress;
  const declared = new Set(env.secrets ?? []);
  const seen = new Set();
  const dir = String(env.dir ?? '').replace(/\/+$/, '');
  servers.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
    const at = `/environment/tools/mcp/${i}`;
    if (seen.has(s.name)) errors.push(`${at}/name ${s.name} is declared twice`);
    seen.add(s.name);
    // docs/architecture/mcp-sandbox.md: the scenario seed lives at mcp/<name>/ (task root), never
    // under environment/ (copied into the agent workspace).
    if (s.seed && s.seed !== `mcp/${s.name}` && !s.seed.startsWith(`mcp/${s.name}/`)) {
      errors.push(`${at}/seed must be under mcp/${s.name}/ (the scenario folder at the task root)`);
    }
    for (const name of s.secrets ?? []) {
      if (!declared.has(name)) errors.push(`${at}/secrets ${name} is not declared in environment.secrets`);
    }
    if (s.seed && dir && (s.seed === dir || s.seed.startsWith(`${dir}/`))) {
      errors.push(`${at}/seed must not be inside environment.dir (the agent would read the test state)`);
    }
  });
  if (servers.length > 0 && !egress.includes('mcp')) errors.push('/environment/run_egress needs "mcp": the agent reaches the MCP sidecars over the run network');
  if (egress.includes('mcp') && servers.length === 0) errors.push('/environment/run_egress "mcp" needs at least one environment.tools.mcp server');
  return errors;
}

const REQUIREMENT_RE = /^(mcp|tool):([a-z0-9][a-z0-9_-]{0,31})$/;
export const MAX_REQUIRES = 20;

/**
 * Normalize an agent's `requires` (the chip field of screen 02). Each entry is `mcp:<server>` or
 * `tool:<builtin>`; a bare name means `mcp:<name>`. Lower-cased, de-duplicated, order kept.
 * @param {unknown} value
 * @returns {{ ok: true, value: string[] } | { ok: false, errors: string[] }}
 */
export function parseAgentRequires(value) {
  if (!Array.isArray(value)) return { ok: false, errors: ['requires must be an array of strings'] };
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const errors = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      errors.push('requires entries must be non-empty strings');
      continue;
    }
    const s = raw.trim().toLowerCase();
    const req = s.includes(':') ? s : `mcp:${s}`;
    const m = REQUIREMENT_RE.exec(req);
    if (!m) {
      errors.push(`requires "${raw}" must be mcp:<name> or tool:<name> (a-z, 0-9, _ and -, up to 32)`);
      continue;
    }
    if (m[1] === 'tool' && !BUILTIN_TOOLS.includes(/** @type {any} */ (m[2]))) {
      errors.push(`requires "${raw}": unknown built-in tool (one of ${BUILTIN_TOOLS.join(', ')})`);
      continue;
    }
    if (!out.includes(req)) out.push(req);
  }
  if (out.length > MAX_REQUIRES) errors.push(`at most ${MAX_REQUIRES} requires`);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
}

/**
 * Pre-run compatibility of an agent with a task: every requirement of the agent must be offered by
 * the task's tool environment. Pure; the API answers it on GET /tasks/:id/compatibility and the
 * quote refuses an incompatible pair before payment (422).
 * @param {import('./index.js').ToolEnvironment} env
 * @param {readonly string[]} requires normalized (parseAgentRequires)
 * @returns {import('./index.js').Compatibility}
 */
export function checkCompatibility(env, requires) {
  /** @type {import('./index.js').CompatibilityReason[]} */
  const reasons = [];
  // A requirement names a server (task-local name) or a catalog server (name of name@version).
  const mcp = new Set(env.mcp.flatMap((s) => [s.name, ...(s.catalog ? [s.catalog.split('@')[0]] : [])]));
  for (const req of requires) {
    const [kind, name] = req.split(':');
    if (kind === 'mcp' && !mcp.has(/** @type {string} */ (name))) {
      reasons.push({ code: 'missing_mcp_server', requirement: req, message: `the agent requires the MCP server "${name}"; the task does not provide it` });
    } else if (kind === 'tool' && !env.builtin.includes(/** @type {any} */ (name))) {
      reasons.push({ code: 'missing_builtin_tool', requirement: req, message: `the agent requires the built-in tool "${name}"; the task does not allow it` });
    }
  }
  return { compatible: reasons.length === 0, reasons };
}

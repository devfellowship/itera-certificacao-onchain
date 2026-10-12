/**
 * Environment step of the task editor (U31, ADR-11): the model behind the card. Pure functions, no
 * React, so node:test can run them (environment.test.mjs).
 *
 * U32 decision: the task.json in the repo wins. The card starts from what the repo declares
 * (`environment`), lets the author change a LOCAL draft, and produces the `environment` JSON to
 * paste into task.json. Nothing is written back to GitHub and nothing here is saved to the API.
 *
 * The preview of "what the agent sees" comes from `opencodeAgentConfig` in @itera/contracts, the
 * function the runner calls to write the real config. Only the endpoint callback differs.
 */
import type { BuiltinTool, McpServer } from '@itera/contracts'
import { BUILTIN_TOOLS, opencodeAgentConfig, toolEnvironment, toolEnvironmentErrors } from '@itera/contracts/tool-environment'
import type { McpCatalogServer } from '../../lib/api/types'

/** The `environment` object of task.json. Unknown keys (dir, install, cpus, …) pass through untouched. */
export type EnvJson = { dir: string; [key: string]: unknown }

export const MAX_SERVERS = 5
export const SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const DIGEST_IMAGE_RE = /@sha256:[0-9a-f]{64}$/

export const BUILTIN_LABELS: Record<BuiltinTool, { label: string; help?: string }> = {
  read: { label: 'Read files' },
  write: { label: 'Write new files' },
  edit: { label: 'Edit files', help: 'Limited to the editable paths in the Contract.' },
  bash: { label: 'Run shell commands', help: 'Runs in the sandbox. No network except the model gateway and the MCP servers.' },
  search: { label: 'Search (grep, glob)' },
  list: { label: 'List folders' },
  todo: { label: 'Keep a to-do list' },
}

export function draftFromContract(env: EnvJson | undefined | null): EnvJson {
  return structuredClone(env ?? { dir: 'environment' }) as EnvJson
}

type ToolsBlock = { builtin?: BuiltinTool[]; mcp?: McpServer[]; [key: string]: unknown }
const toolsOf = (env: EnvJson): ToolsBlock => (env.tools as ToolsBlock | undefined) ?? {}

export function serversOf(env: EnvJson): McpServer[] {
  return toolsOf(env).mcp ?? []
}

export function builtinOf(env: EnvJson): BuiltinTool[] {
  return toolEnvironment({ environment: env }).builtin
}

/** run_egress follows the server list: the agent reaches the sidecars only when there is one (schema rule). */
function syncEgress(env: EnvJson): EnvJson {
  const has = serversOf(env).length > 0
  const cur = Array.isArray(env.run_egress) ? (env.run_egress as string[]) : null
  if (has) return { ...env, run_egress: ['model-gateway', 'mcp'] }
  if (cur && cur.includes('mcp')) return { ...env, run_egress: cur.filter((x) => x !== 'mcp') }
  return env
}

function withTools(env: EnvJson, patch: Partial<ToolsBlock>): EnvJson {
  const tools: ToolsBlock = { ...toolsOf(env), ...patch }
  if (tools.mcp && tools.mcp.length === 0) delete tools.mcp
  if ('builtin' in patch && patch.builtin === undefined) delete tools.builtin
  const next = { ...env }
  if (Object.keys(tools).length === 0) delete next.tools
  else next.tools = tools
  return syncEgress(next)
}

export function setBuiltin(env: EnvJson, tool: BuiltinTool, on: boolean): EnvJson {
  const cur = new Set(builtinOf(env))
  if (on) cur.add(tool)
  else cur.delete(tool)
  // Keep the neutral order of the contract, so the snippet is stable.
  const builtin = BUILTIN_TOOLS.filter((t) => cur.has(t))
  // `builtin` absent = every built-in tool, so the full set is written as absent.
  return withTools(env, { builtin: builtin.length === BUILTIN_TOOLS.length ? undefined : builtin })
}

function mapServer(env: EnvJson, name: string, fn: (s: McpServer) => McpServer): EnvJson {
  return withTools(env, { mcp: serversOf(env).map((s) => (s.name === name ? fn(s) : s)) })
}

export function setAllowedTools(env: EnvJson, server: string, tools: string[]): EnvJson {
  return mapServer(env, server, (s) => ({ ...s, allowed_tools: tools }))
}

export function setScorerAccess(env: EnvJson, server: string, on: boolean): EnvJson {
  return mapServer(env, server, (s) => ({ ...s, expose_state_to_scorer: on }))
}

export function removeServer(env: EnvJson, name: string): EnvJson {
  return withTools(env, { mcp: serversOf(env).filter((s) => s.name !== name) })
}

/** The seed folder of a server in the task repo: mcp/<name>/ at the task root, never under environment/. */
export const seedFolder = (name: string) => `mcp/${name}/`

export function addCatalogServer(env: EnvJson, entry: McpCatalogServer): EnvJson {
  const server: McpServer = {
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    catalog: entry.ref,
    transport: entry.transport,
    seed: `mcp/${entry.name}/seed.json`,
    allowed_tools: entry.tools.map((t) => t.name),
    expose_state_to_scorer: false,
  }
  return withTools(env, { mcp: [...serversOf(env), server] })
}

export interface RepoServerInput {
  name: string
  transport: 'stdio' | 'http'
  image: string
  allowedTools: string[]
}

export function addRepoServer(env: EnvJson, input: RepoServerInput): EnvJson {
  const server: McpServer = {
    name: input.name,
    image: input.image,
    transport: input.transport,
    seed: `mcp/${input.name}/seed.json`,
    allowed_tools: input.allowedTools,
    expose_state_to_scorer: false,
  }
  return withTools(env, { mcp: [...serversOf(env), server] })
}

/** Validation of the repo-server form. Returns the first problem, or null. */
export function repoServerError(env: EnvJson, input: { name: string; image: string; allowedTools: string[] }): string | null {
  if (!SERVER_NAME_RE.test(input.name)) return 'name: lower case letters, digits, - and _, up to 32.'
  if (serversOf(env).some((s) => s.name === input.name)) return `name: ${input.name} is already used in this task.`
  if (!input.image.trim()) return 'image: required.'
  if (!DIGEST_IMAGE_RE.test(input.image.trim())) return 'image: must be pinned by digest (…@sha256:<64 hex>).'
  if (input.allowedTools.length === 0) return 'allowed tools: name at least one tool.'
  return null
}

export function isRepoServer(s: McpServer): boolean {
  return !s.catalog
}

export function catalogEntryOf(s: McpServer, catalog: McpCatalogServer[] | null): McpCatalogServer | null {
  if (!s.catalog || !catalog) return null
  return catalog.find((c) => c.ref === s.catalog) ?? null
}

export type ServerState = {
  kind: 'pinned' | 'unpublished' | 'retired' | 'unknown' | 'loading' | 'review'
  label: string
  tone: 'success' | 'warning' | 'danger' | 'neutral'
}

/** Status badge of one server card. A repo server is never probed or run before a reviewer approves it. */
export function serverState(s: McpServer, catalog: McpCatalogServer[] | null): ServerState {
  if (isRepoServer(s)) return { kind: 'review', label: 'Pending review', tone: 'warning' }
  if (catalog == null) return { kind: 'loading', label: 'Checking', tone: 'neutral' }
  const e = catalogEntryOf(s, catalog)
  if (!e) return { kind: 'unknown', label: 'Not in catalog', tone: 'danger' }
  if (e.status === 'retired') return { kind: 'retired', label: 'Retired', tone: 'warning' }
  if (e.status === 'unpublished' || !e.image) return { kind: 'unpublished', label: 'Image not published', tone: 'warning' }
  return { kind: 'pinned', label: 'Pinned', tone: 'success' }
}

export interface EnvIssue {
  /** Server name the issue belongs to, or null for the whole environment. */
  server: string | null
  message: string
}

/** Everything that stops the environment from being valid. `catalog` null = not loaded yet: catalog rules are skipped. */
export function envIssues(env: EnvJson, catalog: McpCatalogServer[] | null): EnvIssue[] {
  const out: EnvIssue[] = []
  const builtin = builtinOf(env)
  if (!builtin.includes('read') || !builtin.includes('edit')) out.push({ server: null, message: 'The agent has no way to return a patch. Turn on at least Read and Edit.' })
  const servers = serversOf(env)
  if (servers.length > MAX_SERVERS) out.push({ server: null, message: `At most ${MAX_SERVERS} MCP servers.` })
  for (const s of servers) {
    if (s.allowed_tools.length === 0) out.push({ server: s.name, message: `Allow at least one tool for ${s.name}.` })
    if (isRepoServer(s)) {
      if (s.image && !DIGEST_IMAGE_RE.test(s.image)) out.push({ server: s.name, message: `${s.name}: image must be pinned by digest.` })
      continue
    }
    if (!catalog) continue
    const e = catalogEntryOf(s, catalog)
    if (!e) {
      out.push({ server: s.name, message: `${s.catalog} is not in the Itera catalog.` })
      continue
    }
    if (e.status === 'retired') out.push({ server: s.name, message: `${e.ref} was withdrawn from the Itera catalog. Replace it.` })
    const known = new Set(e.tools.map((t) => t.name))
    for (const t of s.allowed_tools) if (!known.has(t)) out.push({ server: s.name, message: `${s.name}: ${t} is not a tool of ${e.ref}.` })
  }
  // The contract's own rules (seed folder, duplicate names, secrets, run_egress).
  for (const m of toolEnvironmentErrors({ environment: env } as never)) out.push({ server: null, message: m })
  return out
}

export type CardState = { label: 'Default' | 'Configured' | 'Incomplete' | 'In review' | 'Invalid'; tone: 'success' | 'warning' | 'danger' | 'neutral' }

export function cardState(env: EnvJson, catalog: McpCatalogServer[] | null): CardState {
  if (envIssues(env, catalog).length > 0) return { label: 'Invalid', tone: 'danger' }
  const servers = serversOf(env)
  if (servers.some(isRepoServer)) return { label: 'In review', tone: 'warning' }
  if (servers.some((s) => ['unpublished', 'retired'].includes(serverState(s, catalog).kind))) return { label: 'Incomplete', tone: 'warning' }
  const nonDefault = servers.length > 0 || builtinOf(env).length !== BUILTIN_TOOLS.length
  return nonDefault ? { label: 'Configured', tone: 'success' } : { label: 'Default', tone: 'neutral' }
}

/** Placeholder names for the values that exist only per run. */
export const RUN_TOKEN_PLACEHOLDER = '{{RUN_TOKEN}}'
export const urlPlaceholder = (name: string) => `{{MCP_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_URL}}`

/** The opencode config the agent gets, with the per-run values left as placeholders. Same function as the runner. */
export function previewConfig(env: EnvJson): { mcp?: Record<string, unknown>; tools?: Record<string, boolean> } {
  return opencodeAgentConfig(serversOf(env), builtinOf(env), (name) => ({ url: urlPlaceholder(name), token: RUN_TOKEN_PLACEHOLDER }))
}

/** The `environment` object to paste into task.json. */
export function environmentSnippet(env: EnvJson): string {
  return JSON.stringify(env, null, 2)
}

export function sameEnv(a: EnvJson, b: EnvJson): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

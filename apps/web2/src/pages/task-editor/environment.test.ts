import { expect, test } from 'vitest'
import { MCP_CATALOG } from '../../fixtures/design/mcp-catalog'
import {
  addCatalogServer,
  addRepoServer,
  builtinOf,
  cardState,
  draftFromContract,
  envIssues,
  environmentSnippet,
  previewConfig,
  removeServer,
  repoServerError,
  sameEnv,
  serverState,
  serversOf,
  setAllowedTools,
  setBuiltin,
  setScorerAccess,
} from './environment'

const helpdesk = MCP_CATALOG.find((c) => c.name === 'helpdesk')!
const memory = MCP_CATALOG.find((c) => c.name === 'memory')!
const base = () => draftFromContract({ dir: 'environment', cpus: 2 })
const DIGEST = 'ghcr.io/acme/x@sha256:' + 'ab'.repeat(32)

test('a task with no tool keys is the Default environment: every built-in tool, no server', () => {
  const env = base()
  expect(builtinOf(env).length).toBe(7)
  expect(serversOf(env)).toEqual([])
  expect(cardState(env, MCP_CATALOG).label).toBe('Default')
  expect(envIssues(env, MCP_CATALOG).length).toBe(0)
  expect(environmentSnippet(env)).toBe(JSON.stringify({ dir: 'environment', cpus: 2 }, null, 2))
})

test('turning a built-in tool off writes the allow-list, turning it back on removes the key (absent = all)', () => {
  const off = setBuiltin(base(), 'bash', false)
  expect((off.tools as { builtin: string[] }).builtin).toEqual(['read', 'write', 'edit', 'search', 'list', 'todo'])
  expect(cardState(off, MCP_CATALOG).label).toBe('Configured')
  const on = setBuiltin(off, 'bash', true)
  expect(on.tools).toBeUndefined()
  expect(sameEnv(on, base())).toBeTruthy()
})

test('without Read and Edit the agent cannot return a patch', () => {
  const env = setBuiltin(base(), 'edit', false)
  expect(envIssues(env, MCP_CATALOG).map((i) => i.message).join(' ')).toMatch(/Read and Edit/)
  expect(cardState(env, MCP_CATALOG).label).toBe('Invalid')
})

test('adding a catalog server pins name@version, allows every pinned tool, and adds the mcp egress', () => {
  const env = addCatalogServer(base(), helpdesk)
  const [s] = serversOf(env)
  expect(s.catalog).toBe('helpdesk@1')
  expect(s.seed).toBe('mcp/helpdesk/seed.json')
  expect(s.allowed_tools).toEqual(helpdesk.tools.map((t) => t.name))
  expect(s.expose_state_to_scorer).toBe(false)
  expect(env.run_egress).toEqual(['model-gateway', 'mcp'])
  expect(envIssues(env, MCP_CATALOG)).toEqual([])
  // helpdesk@1 has no published digest yet (GHCR private): the card says so instead of "Configured".
  expect(serverState(s, MCP_CATALOG).kind).toBe('unpublished')
  expect(cardState(env, MCP_CATALOG).label).toBe('Incomplete')
  // a published version is Pinned and the card is Configured
  const m = addCatalogServer(base(), memory)
  expect(serverState(serversOf(m)[0], MCP_CATALOG).kind).toBe('pinned')
  expect(cardState(m, MCP_CATALOG).label).toBe('Configured')
})

test('allowed subset: empty is invalid, an unknown tool is invalid, a subset is valid', () => {
  const env = addCatalogServer(base(), helpdesk)
  const subset = setAllowedTools(env, 'helpdesk', ['search_tickets', 'issue_refund'])
  expect(serversOf(subset)[0].allowed_tools).toEqual(['search_tickets', 'issue_refund'])
  expect(envIssues(subset, MCP_CATALOG)).toEqual([])
  const none = setAllowedTools(env, 'helpdesk', [])
  expect(envIssues(none, MCP_CATALOG)[0].message).toMatch(/Allow at least one tool for helpdesk/)
  const bogus = setAllowedTools(env, 'helpdesk', ['drop_database'])
  expect(envIssues(bogus, MCP_CATALOG).map((i) => i.message).join(' ')).toMatch(/drop_database is not a tool of helpdesk@1/)
})

test('catalog rules wait for the catalog: while it loads, no catalog issue is invented', () => {
  const env = addCatalogServer(base(), helpdesk)
  expect(envIssues(env, null)).toEqual([])
  expect(serverState(serversOf(env)[0], null).kind).toBe('loading')
})

test('a catalog ref that is not in the catalog is flagged', () => {
  const env = draftFromContract({ dir: 'environment', tools: { mcp: [{ name: 'ghost', catalog: 'ghost@3', transport: 'http', allowed_tools: ['x'] }] }, run_egress: ['model-gateway', 'mcp'] })
  expect(envIssues(env, MCP_CATALOG)[0].message).toMatch(/ghost@3 is not in the Itera catalog/)
})

test('a server from the repo is Pending review, needs a digest-pinned image, and is never probed', () => {
  expect(repoServerError(base(), { name: 'Bad Name', image: DIGEST, allowedTools: ['a'] })).toMatch(/name/)
  expect(repoServerError(base(), { name: 'stripe', image: 'acme/x:latest', allowedTools: ['a'] })).toMatch(/pinned by digest/)
  expect(repoServerError(base(), { name: 'stripe', image: DIGEST, allowedTools: [] })).toMatch(/allowed tools/)
  expect(repoServerError(base(), { name: 'stripe', image: DIGEST, allowedTools: ['create_charge'] })).toBeNull()
  const env = addRepoServer(base(), { name: 'stripe', transport: 'http', image: DIGEST, allowedTools: ['create_charge'] })
  const [s] = serversOf(env)
  expect(serverState(s, MCP_CATALOG).label).toBe('Pending review')
  expect(cardState(env, MCP_CATALOG).label).toBe('In review')
  expect(repoServerError(env, { name: 'stripe', image: DIGEST, allowedTools: ['a'] })).toBe('name: stripe is already used in this task.')
})

test('the seed always sits under mcp/<name>/, and a seed inside environment/ is refused by the contract rules', () => {
  const bad = draftFromContract({ dir: 'environment', tools: { mcp: [{ name: 'helpdesk', catalog: 'helpdesk@1', transport: 'http', seed: 'environment/seed.json', allowed_tools: ['search_tickets'] }] }, run_egress: ['model-gateway', 'mcp'] })
  expect(envIssues(bad, MCP_CATALOG).map((i) => i.message).join(' ')).toMatch(/seed must be under mcp\/helpdesk\//)
})

test('removing the last server drops the mcp egress and the empty tools block', () => {
  const env = removeServer(addCatalogServer(base(), memory), 'memory')
  expect(env.run_egress).toEqual(['model-gateway'])
  expect(env.tools).toBeUndefined()
})

test('scorer access toggles expose_state_to_scorer', () => {
  const env = setScorerAccess(addCatalogServer(base(), memory), 'memory', true)
  expect(serversOf(env)[0].expose_state_to_scorer).toBe(true)
})

test('the preview is the runner function with placeholders: no endpoint, no token', () => {
  const env = setBuiltin(addCatalogServer(base(), memory), 'bash', false)
  const cfg = previewConfig(env)
  expect(cfg.mcp?.memory).toEqual({ type: 'remote', url: '{{MCP_MEMORY_URL}}', headers: { Authorization: 'Bearer {{RUN_TOKEN}}' }, enabled: true })
  expect(cfg.tools).toEqual({ bash: false })
  expect(previewConfig(base())).toEqual({})
})

test('the snippet is the environment object, and the draft equals the repo until something changes', () => {
  const repo = draftFromContract({ dir: 'environment', install: ['npm', 'ci'] })
  expect(sameEnv(repo, draftFromContract(repo))).toBeTruthy()
  const edited = addCatalogServer(repo, memory)
  expect(sameEnv(edited, repo)).toBe(false)
  const parsed = JSON.parse(environmentSnippet(edited))
  expect(parsed.tools.mcp[0].catalog).toBe('memory@1')
  expect(parsed.install).toEqual(['npm', 'ci'])
})

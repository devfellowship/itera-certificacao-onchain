import assert from 'node:assert/strict'
import test from 'node:test'
import { MCP_CATALOG } from '../../fixtures/design/mcp-catalog.ts'
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
} from './environment.ts'

const helpdesk = MCP_CATALOG.find((c) => c.name === 'helpdesk')
const memory = MCP_CATALOG.find((c) => c.name === 'memory')
const base = () => draftFromContract({ dir: 'environment', cpus: 2 })
const DIGEST = 'ghcr.io/acme/x@sha256:' + 'ab'.repeat(32)

test('a task with no tool keys is the Default environment: every built-in tool, no server', () => {
  const env = base()
  assert.equal(builtinOf(env).length, 7)
  assert.deepEqual(serversOf(env), [])
  assert.equal(cardState(env, MCP_CATALOG).label, 'Default')
  assert.equal(envIssues(env, MCP_CATALOG).length, 0)
  assert.equal(environmentSnippet(env), JSON.stringify({ dir: 'environment', cpus: 2 }, null, 2))
})

test('turning a built-in tool off writes the allow-list, turning it back on removes the key (absent = all)', () => {
  const off = setBuiltin(base(), 'bash', false)
  assert.deepEqual(off.tools.builtin, ['read', 'write', 'edit', 'search', 'list', 'todo'])
  assert.equal(cardState(off, MCP_CATALOG).label, 'Configured')
  const on = setBuiltin(off, 'bash', true)
  assert.equal(on.tools, undefined)
  assert.ok(sameEnv(on, base()))
})

test('without Read and Edit the agent cannot return a patch', () => {
  const env = setBuiltin(base(), 'edit', false)
  assert.match(envIssues(env, MCP_CATALOG).map((i) => i.message).join(' '), /Read and Edit/)
  assert.equal(cardState(env, MCP_CATALOG).label, 'Invalid')
})

test('adding a catalog server pins name@version, allows every pinned tool, and adds the mcp egress', () => {
  const env = addCatalogServer(base(), helpdesk)
  const [s] = serversOf(env)
  assert.equal(s.catalog, 'helpdesk@1')
  assert.equal(s.seed, 'mcp/helpdesk/seed.json')
  assert.deepEqual(s.allowed_tools, helpdesk.tools.map((t) => t.name))
  assert.equal(s.expose_state_to_scorer, false)
  assert.deepEqual(env.run_egress, ['model-gateway', 'mcp'])
  assert.deepEqual(envIssues(env, MCP_CATALOG), [])
  // helpdesk@1 has no published digest yet (GHCR private): the card says so instead of "Configured".
  assert.equal(serverState(s, MCP_CATALOG).kind, 'unpublished')
  assert.equal(cardState(env, MCP_CATALOG).label, 'Incomplete')
  // a published version is Pinned and the card is Configured
  const m = addCatalogServer(base(), memory)
  assert.equal(serverState(serversOf(m)[0], MCP_CATALOG).kind, 'pinned')
  assert.equal(cardState(m, MCP_CATALOG).label, 'Configured')
})

test('allowed subset: empty is invalid, an unknown tool is invalid, a subset is valid', () => {
  const env = addCatalogServer(base(), helpdesk)
  const subset = setAllowedTools(env, 'helpdesk', ['search_tickets', 'issue_refund'])
  assert.deepEqual(serversOf(subset)[0].allowed_tools, ['search_tickets', 'issue_refund'])
  assert.deepEqual(envIssues(subset, MCP_CATALOG), [])
  const none = setAllowedTools(env, 'helpdesk', [])
  assert.match(envIssues(none, MCP_CATALOG)[0].message, /Allow at least one tool for helpdesk/)
  const bogus = setAllowedTools(env, 'helpdesk', ['drop_database'])
  assert.match(envIssues(bogus, MCP_CATALOG).map((i) => i.message).join(' '), /drop_database is not a tool of helpdesk@1/)
})

test('catalog rules wait for the catalog: while it loads, no catalog issue is invented', () => {
  const env = addCatalogServer(base(), helpdesk)
  assert.deepEqual(envIssues(env, null), [])
  assert.equal(serverState(serversOf(env)[0], null).kind, 'loading')
})

test('a catalog ref that is not in the catalog is flagged', () => {
  const env = draftFromContract({ dir: 'environment', tools: { mcp: [{ name: 'ghost', catalog: 'ghost@3', transport: 'http', allowed_tools: ['x'] }] }, run_egress: ['model-gateway', 'mcp'] })
  assert.match(envIssues(env, MCP_CATALOG)[0].message, /ghost@3 is not in the Itera catalog/)
})

test('a server from the repo is Pending review, needs a digest-pinned image, and is never probed', () => {
  assert.match(repoServerError(base(), { name: 'Bad Name', image: DIGEST, allowedTools: ['a'] }), /name/)
  assert.match(repoServerError(base(), { name: 'stripe', image: 'acme/x:latest', allowedTools: ['a'] }), /pinned by digest/)
  assert.match(repoServerError(base(), { name: 'stripe', image: DIGEST, allowedTools: [] }), /allowed tools/)
  assert.equal(repoServerError(base(), { name: 'stripe', image: DIGEST, allowedTools: ['create_charge'] }), null)
  const env = addRepoServer(base(), { name: 'stripe', transport: 'http', image: DIGEST, allowedTools: ['create_charge'] })
  const [s] = serversOf(env)
  assert.equal(serverState(s, MCP_CATALOG).label, 'Pending review')
  assert.equal(cardState(env, MCP_CATALOG).label, 'In review')
  assert.equal(repoServerError(env, { name: 'stripe', image: DIGEST, allowedTools: ['a'] }), 'name: stripe is already used in this task.')
})

test('the seed always sits under mcp/<name>/, and a seed inside environment/ is refused by the contract rules', () => {
  const bad = draftFromContract({ dir: 'environment', tools: { mcp: [{ name: 'helpdesk', catalog: 'helpdesk@1', transport: 'http', seed: 'environment/seed.json', allowed_tools: ['search_tickets'] }] }, run_egress: ['model-gateway', 'mcp'] })
  assert.match(envIssues(bad, MCP_CATALOG).map((i) => i.message).join(' '), /seed must be under mcp\/helpdesk\//)
})

test('removing the last server drops the mcp egress and the empty tools block', () => {
  const env = removeServer(addCatalogServer(base(), memory), 'memory')
  assert.deepEqual(env.run_egress, ['model-gateway'])
  assert.equal(env.tools, undefined)
})

test('scorer access toggles expose_state_to_scorer', () => {
  const env = setScorerAccess(addCatalogServer(base(), memory), 'memory', true)
  assert.equal(serversOf(env)[0].expose_state_to_scorer, true)
})

test('the preview is the runner function with placeholders: no endpoint, no token', () => {
  const env = setBuiltin(addCatalogServer(base(), memory), 'bash', false)
  const cfg = previewConfig(env)
  assert.deepEqual(cfg.mcp.memory, { type: 'remote', url: '{{MCP_MEMORY_URL}}', headers: { Authorization: 'Bearer {{RUN_TOKEN}}' }, enabled: true })
  assert.deepEqual(cfg.tools, { bash: false })
  assert.deepEqual(previewConfig(base()), {})
})

test('the snippet is the environment object, and the draft equals the repo until something changes', () => {
  const repo = draftFromContract({ dir: 'environment', install: ['npm', 'ci'] })
  assert.ok(sameEnv(repo, draftFromContract(repo)))
  const edited = addCatalogServer(repo, memory)
  assert.ok(!sameEnv(edited, repo))
  const parsed = JSON.parse(environmentSnippet(edited))
  assert.equal(parsed.tools.mcp[0].catalog, 'memory@1')
  assert.deepEqual(parsed.install, ['npm', 'ci'])
})

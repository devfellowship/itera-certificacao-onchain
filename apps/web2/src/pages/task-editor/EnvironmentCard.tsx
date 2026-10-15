/**
 * ENVIRONMENT card of the task editor (U31, ADR-11, designer addendum U32 part 1).
 *
 * Four blocks: BUILT-IN TOOLS, LIMITS, MCP SERVERS, WHAT THE AGENT SEES, plus the task.json
 * snippet. The repo's task.json wins (U32): the card starts from what the repo declares, the author
 * edits a local draft, and COPIES the generated `environment` JSON into task.json. There is no
 * write-back to GitHub, and the draft is not saved to the API.
 *
 * A custom MCP server from the task repo is shown "Pending review": no probe, no run. A catalog
 * server shows the tools snapshot pinned with its version (mcp_catalog), not a live list_tools.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { api } from '../../lib/api'
import type { McpCatalogServer, TaskContract } from '../../lib/api/types'
import { Badge, Button, Card, Checkbox, CodePanel, KeyValue, Segmented, TagPill } from '../../tma/ui'
import { copyText, useFlash } from '../task-profile/helpers'
import { useLoad } from '../add-agent/useLoad'
import { AddMcpModal, type CatalogLoad } from './AddMcpModal'
import {
  BUILTIN_LABELS,
  cardState,
  catalogEntryOf,
  draftFromContract,
  envIssues,
  environmentSnippet,
  isRepoServer,
  previewConfig,
  removeServer,
  sameEnv,
  seedFolder,
  serverState,
  serversOf,
  setAllowedTools,
  setBuiltin,
  setScorerAccess,
  builtinOf,
  type EnvIssue,
  type EnvJson,
} from './environment'
import { BUILTIN_TOOLS, OPENCODE_BUILTIN_TOOLS } from '@itera/contracts/tool-environment'
import type { McpServer } from '@itera/contracts'
import './environment.css'

const shortDigest = (image: string | null) => {
  const m = image?.match(/@sha256:([0-9a-f]{64})$/)
  return m ? `sha256 ${m[1]!.slice(0, 6)}…${m[1]!.slice(-2)}` : null
}

function CopyButton({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [flash, setFlash] = useFlash()
  return (
    <button
      type="button"
      className="te-link"
      data-testid={testId}
      onClick={() => {
        void copyText(text)
        setFlash(label)
      }}
    >
      {flash === label ? 'Copied' : label}
    </button>
  )
}

function Block({ label, aside, children, testId }: { label: string; aside?: ReactNode; children: ReactNode; testId: string }) {
  return (
    <section className="te-env-block" data-testid={testId}>
      <div className="te-env-block__head">
        <span className="tma-label">{label}</span>
        {aside}
      </div>
      {children}
    </section>
  )
}

function BuiltinBlock({ env, locked, onChange }: { env: EnvJson; locked: boolean; onChange: (e: EnvJson) => void }) {
  const on = new Set(builtinOf(env))
  return (
    <Block label="Built-in tools" testId="env-builtin">
      <div className="te-env-tools">
        {BUILTIN_TOOLS.map((t) => (
          <div className="te-env-tool" key={t}>
            <Checkbox
              checked={on.has(t)}
              disabled={locked}
              onChange={(v) => onChange(setBuiltin(env, t, v))}
              data-testid={`builtin-${t}`}
              label={
                <span className="te-env-tool__text">
                  <span>{BUILTIN_LABELS[t].label}</span>
                  {BUILTIN_LABELS[t].help && <span className="te-env-help">{BUILTIN_LABELS[t].help}</span>}
                </span>
              }
            />
            <span className="te-mono te-muted" title={OPENCODE_BUILTIN_TOOLS[t].join(', ')}>
              {t}
            </span>
          </div>
        ))}
      </div>
    </Block>
  )
}

function LimitsBlock({ env, contract }: { env: EnvJson; contract: TaskContract | null }) {
  const servers = serversOf(env)
  const res = (env.resources ?? {}) as { cpus?: number; memory_mb?: number; pids?: number }
  const secrets = Array.isArray(env.secrets) ? (env.secrets as string[]) : []
  const boot = servers.map((s) => s.startup_timeout_sec).filter((n): n is number => typeof n === 'number')
  const resources = [res.cpus != null && `${res.cpus} CPU`, res.memory_mb != null && `${res.memory_mb} MB`, res.pids != null && `${res.pids} pids`].filter(Boolean).join(' · ')
  return (
    <Block label="Limits" testId="env-limits" aside={<span className="te-env-help">Set in task.json</span>}>
      <div className="te-kv">
        <KeyValue
          rows={[
            { key: 'Network', value: servers.length > 0 ? 'Model API + MCP servers' : 'Model API only' },
            { key: 'Secrets', value: secrets.length > 0 ? <span className="te-mono">{secrets.join(', ')}</span> : 'None (names only, never values)' },
            { key: 'Resources', value: resources || 'Runner default' },
            { key: 'MCP boot timeout', value: boot.length > 0 ? `${Math.max(...boot)} s` : servers.length > 0 ? '30 s (default)' : '—' },
            { key: 'Run timeout', value: contract ? `${contract.agent.timeout_sec} s (Contract)` : '—' },
          ]}
        />
      </div>
    </Block>
  )
}

function ParamsPanel({ schema }: { schema: unknown }) {
  const text = JSON.stringify(schema ?? {}, null, 2)
  return (
    <div className="te-env-params" data-testid="tool-schema">
      <div className="te-env-params__bar">
        <CopyButton text={text} label="Copy schema" />
      </div>
      <pre>{text}</pre>
    </div>
  )
}

function paramCount(schema: unknown): number {
  const p = (schema as { properties?: Record<string, unknown> } | null)?.properties
  return p && typeof p === 'object' ? Object.keys(p).length : 0
}

function ToolPicker({ server, entry, locked, onChange }: { server: McpServer; entry: McpCatalogServer; locked: boolean; onChange: (tools: string[]) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const allowed = new Set(server.allowed_tools)
  const all = entry.tools.map((t) => t.name)
  return (
    <div className="te-env-picker" data-testid="tool-picker">
      <div className="te-env-picker__head">
        <span className="te-mono te-muted" data-testid="tool-count">
          {entry.tools.length} tools in {entry.ref} · {all.filter((n) => allowed.has(n)).length} allowed
        </span>
        <span className="te-env-picker__acts">
          <button type="button" className="te-link" disabled={locked} onClick={() => onChange(all)}>
            Select all
          </button>
          <button type="button" className="te-link" disabled={locked} onClick={() => onChange([])}>
            Clear
          </button>
        </span>
      </div>
      <div className="te-env-picker__rows">
        {entry.tools.map((t) => (
          <div className="te-env-picker__row" key={t.name} data-testid="tool-row" data-tool={t.name}>
            <Checkbox
              checked={allowed.has(t.name)}
              disabled={locked}
              onChange={(v) => onChange(all.filter((n) => (n === t.name ? v : allowed.has(n))))}
              aria-label={`Allow ${t.name}`}
              label={<span className="te-env-name te-env-name--tool">{t.name}</span>}
            />
            <span className="te-env-desc te-env-desc--clamp">{t.description ?? ''}</span>
            <button type="button" className="te-link te-mono" aria-expanded={open === t.name} onClick={() => setOpen(open === t.name ? null : t.name)}>
              {paramCount(t.inputSchema)} {paramCount(t.inputSchema) === 1 ? 'param' : 'params'} {open === t.name ? '▴' : '▾'}
            </button>
            {open === t.name && <ParamsPanel schema={t.inputSchema} />}
          </div>
        ))}
      </div>
      <span className="te-env-foot">
        Snapshot pinned with the catalog version{entry.commit ? ` · commit ${entry.commit.slice(0, 7)}` : ''}. A published version never changes.
      </span>
    </div>
  )
}

function ServerCard({
  server,
  catalog,
  issues,
  locked,
  onChange,
  env,
}: {
  server: McpServer
  catalog: McpCatalogServer[] | null
  issues: EnvIssue[]
  locked: boolean
  env: EnvJson
  onChange: (e: EnvJson) => void
}) {
  const repo = isRepoServer(server)
  const state = serverState(server, catalog)
  const entry = catalogEntryOf(server, catalog)
  const mine = issues.filter((i) => i.server === server.name)
  return (
    <div className="te-env-server" data-testid="env-server" data-server={server.name}>
      <div className="te-env-server__top">
        <span className="te-env-server__title">
          <span className="te-env-name">{server.name}</span>
          <span className="te-env-pill" data-testid="server-source">
            {repo ? 'Task repo' : 'Itera catalog'}
          </span>
          <Badge tone={state.tone} testId="server-status">
            {state.label}
          </Badge>
        </span>
        <button type="button" className="te-link" disabled={locked} onClick={() => onChange(removeServer(env, server.name))} data-testid="server-remove">
          Remove
        </button>
      </div>
      <div className="te-kv">
        <KeyValue
          rows={[
            { key: 'Transport', value: <span className="te-env-pill">{server.transport}</span> },
            repo
              ? { key: 'Image', value: <span className="te-mono">{server.image ?? (server.command ? server.command.join(' ') : '—')}</span> }
              : {
                  key: 'Version',
                  value: (
                    <span className="te-mono" data-testid="server-version">
                      {server.catalog}
                      {entry ? ` · ${shortDigest(entry.image) ?? 'no digest yet'}` : ''}
                    </span>
                  ),
                },
            { key: 'Seed folder', value: <span className="te-mono" data-testid="server-seed">{seedFolder(server.name)}</span> },
          ]}
        />
      </div>
      <span className="te-env-help">Seed: {server.seed ?? seedFolder(server.name)} · read at the pinned commit, applied fresh on every run, never under environment/ and never shown on the public page.</span>

      {repo ? (
        <div className="te-env-review" data-testid="server-review">
          <span className="te-muted">A reviewer reads this server before it can run. It is not probed or started until then, and the task cannot be Ready until the review passes.</span>
          <span className="te-env-chips">
            {server.allowed_tools.map((t) => (
              <TagPill key={t}>{t}</TagPill>
            ))}
          </span>
        </div>
      ) : entry ? (
        <ToolPicker server={server} entry={entry} locked={locked} onChange={(tools) => onChange(setAllowedTools(env, server.name, tools))} />
      ) : catalog != null ? (
        <span className="ta-error" role="alert">
          {server.catalog} is not in the Itera catalog, so its tools cannot be listed.
        </span>
      ) : (
        <span className="te-muted">Loading the pinned tools…</span>
      )}

      {state.kind === 'unpublished' && (
        <span className="te-env-help te-env-help--warn" data-testid="server-unpublished">
          The image of this version has no published digest yet, so a run cannot start it. The pinned tool schema above is already valid.
        </span>
      )}
      {state.kind === 'retired' && <span className="te-env-help te-env-help--warn">The Itera catalog withdrew this server. Remove it and add a current one.</span>}

      <Checkbox
        checked={server.expose_state_to_scorer === true}
        disabled={locked}
        onChange={(v) => onChange(setScorerAccess(env, server.name, v))}
        data-testid="server-scorer"
        label={
          <span className="te-env-tool__text">
            <span>Let the scorer read the final state of this server</span>
            <span className="te-env-help">The agent never sees it. It is for checks the tests cannot do.</span>
          </span>
        }
      />
      {mine.map((i) => (
        <span className="ta-error" role="alert" key={i.message} data-testid="server-issue">
          {i.message}
        </span>
      ))}
    </div>
  )
}

function McpBlock({ env, catalog, issues, locked, onChange, onAdd }: { env: EnvJson; catalog: CatalogLoad; issues: EnvIssue[]; locked: boolean; onChange: (e: EnvJson) => void; onAdd: () => void }) {
  const servers = serversOf(env)
  return (
    <Block
      label="MCP servers"
      testId="env-mcp"
      aside={
        <span className="te-env-block__aside">
          <span className="te-mono te-muted" data-testid="server-count">
            {servers.length} {servers.length === 1 ? 'server' : 'servers'}
          </span>
          <Button variant="secondary" size={32} disabled={locked} onClick={onAdd} data-testid="add-mcp">
            Add MCP
          </Button>
        </span>
      }
    >
      {servers.length === 0 ? (
        <span className="te-muted" data-testid="mcp-empty">
          No MCP servers. The agent works with the files and the tools above.
        </span>
      ) : (
        <div className="te-env-servers">
          {servers.map((s) => (
            <ServerCard key={s.name} server={s} catalog={catalog.servers} issues={issues} locked={locked} env={env} onChange={onChange} />
          ))}
        </div>
      )}
    </Block>
  )
}

function SeesBlock({ env, issues }: { env: EnvJson; issues: EnvIssue[] }) {
  const [tab, setTab] = useState<'summary' | 'config'>('summary')
  const servers = serversOf(env)
  const builtin = builtinOf(env)
  const config = useMemo(() => previewConfig(env), [env])
  const configText = JSON.stringify(config, null, 2)
  const noTool = issues.some((i) => i.server === null && /Read and Edit/.test(i.message))
  return (
    <Block
      label="What the agent sees"
      testId="env-sees"
      aside={
        <Segmented
          items={[
            { id: 'summary' as const, label: 'Summary' },
            { id: 'config' as const, label: 'opencode config' },
          ]}
          value={tab}
          onChange={setTab}
        />
      }
    >
      {noTool && (
        <span className="ta-error" role="alert">
          The agent has no way to return a patch. Turn on at least Read and Edit.
        </span>
      )}
      {tab === 'summary' ? (
        <div className="te-env-sum" data-testid="sees-summary">
          <div className="te-env-sum__row">
            <span className="tma-label">Built-in tools</span>
            <span className="te-env-chips">
              {builtin.length === 0 ? <span className="te-muted">None</span> : builtin.map((t) => <TagPill key={t}>{t}</TagPill>)}
            </span>
          </div>
          <div className="te-env-sum__row">
            <span className="tma-label">MCP tools</span>
            {servers.length === 0 ? (
              <span className="te-muted">Only built-in tools.</span>
            ) : (
              <div className="te-env-sum__servers">
                {servers.map((s) => (
                  <div key={s.name} data-testid="sees-server">
                    <span className="te-mono">{s.name}</span>
                    <span className="te-muted"> · {s.allowed_tools.length} allowed</span>
                    <span className="te-env-chips">
                      {s.allowed_tools.map((t) => (
                        <TagPill key={t}>{`${s.name}_${t}`}</TagPill>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="te-env-config" data-testid="sees-config">
          <div className="te-env-config__strip">
            <span className="te-env-strip">Illustrative · endpoints and tokens are filled per run</span>
            <CopyButton text={configText} label="Copy" />
          </div>
          <CodePanel title="opencode.json · mcp, tools" meta={Object.keys(config).length === 0 ? 'nothing to add' : undefined}>
            {configText}
          </CodePanel>
        </div>
      )}
    </Block>
  )
}

/** Props: `contract` is what the repo declares at the pinned commit; `locked` = Validating or Ready. */
export function EnvironmentCard({ contract, locked, shortSha }: { contract: TaskContract | null; locked: boolean; shortSha: string | null }) {
  const repoEnv = useMemo(() => (contract ? draftFromContract(contract.environment as EnvJson) : null), [contract])
  if (!contract || !repoEnv) {
    return (
      <Card className="ta-card ta-card--tight" data-testid="environment-slot" data-slot="u31-environment">
        <div className="ta-card__top">
          <span className="tma-label">Environment</span>
          <span className="te-meta">from task.json</span>
        </div>
        <span className="ta-help">The tools and MCP servers of the task show here after task.json is read.</span>
      </Card>
    )
  }
  // Remount when the repo declares something else (new commit, other folder): the draft restarts from the repo.
  return <EnvironmentBody key={JSON.stringify(repoEnv)} repoEnv={repoEnv} contract={contract} locked={locked} shortSha={shortSha} />
}

function EnvironmentBody({ repoEnv, contract, locked, shortSha }: { repoEnv: EnvJson; contract: TaskContract; locked: boolean; shortSha: string | null }) {
  const [env, setEnv] = useState<EnvJson>(repoEnv)
  const [adding, setAdding] = useState(false)
  const load = useLoad(() => api.mcpCatalog(), [])
  const catalog: CatalogLoad = { status: load.status, servers: load.data?.servers ?? null, reload: load.reload }
  const issues = envIssues(env, catalog.servers)
  const state = cardState(env, catalog.servers)
  const changed = !sameEnv(env, repoEnv)
  const snippet = environmentSnippet(env)
  return (
    <Card className="ta-card" data-testid="environment-slot" data-slot="u31-environment">
      <div className="ta-card__top">
        <span className="tma-label">Environment</span>
        <span className="te-env-top">
          <span className="te-meta">{shortSha ? `from task.json · ${shortSha}` : 'from task.json'}</span>
          <Badge tone={state.tone} testId="env-state">
            {state.label}
          </Badge>
        </span>
      </div>
      <span className="ta-help">The tools and servers the agent can use in this task. The agent cannot add more.</span>

      <BuiltinBlock env={env} locked={locked} onChange={setEnv} />
      <LimitsBlock env={env} contract={contract} />
      <McpBlock env={env} catalog={catalog} issues={issues} locked={locked} onChange={setEnv} onAdd={() => setAdding(true)} />
      <SeesBlock env={env} issues={issues} />

      <Block
        label="Paste into task.json"
        testId="env-snippet"
        aside={
          <span className="te-env-block__aside">
            {changed && (
              <button type="button" className="te-link" onClick={() => setEnv(repoEnv)} disabled={locked} data-testid="env-reset">
                Reset to the repo
              </button>
            )}
            <CopyButton text={snippet} label="Copy snippet" testId="env-copy" />
          </span>
        }
      >
        <span className={changed ? 'te-env-help te-env-help--warn' : 'te-env-help'} data-testid="env-diff">
          {changed
            ? 'This draft differs from your repo. Copy the snippet into the "environment" key of task.json, push, and pin the new commit. Nothing here is written to GitHub.'
            : 'This is what your task.json declares at the pinned commit. Change a setting above to generate the new "environment" key.'}
        </span>
        <CodePanel title="environment" meta={changed ? 'edited' : 'from the repo'}>
          {snippet}
        </CodePanel>
      </Block>

      <AddMcpModal open={adding} onClose={() => setAdding(false)} env={env} onChange={setEnv} catalog={catalog} />
    </Card>
  )
}

/**
 * "Add MCP server" modal of the Environment card (addendum U32, Block C). Two tabs: the Itera
 * catalog (curated, no review, read from GET /mcp-catalog) and a server from the task repo (needs
 * review: never probed or run before a reviewer approves it).
 */
import { useMemo, useState } from 'react'
import type { McpCatalogServer } from '../../lib/api/types'
import { Badge, Button, Field, Input, Modal, SearchInput, Segmented, Select, TagPill } from '../../tma/ui'
import { addCatalogServer, addRepoServer, repoServerError, serversOf, type EnvJson } from './environment'

type Tab = 'catalog' | 'repo'

export interface CatalogLoad {
  status: 'idle' | 'loading' | 'ready' | 'error'
  servers: McpCatalogServer[] | null
  reload: () => void
}

export function AddMcpModal({ open, onClose, env, onChange, catalog }: { open: boolean; onClose: () => void; env: EnvJson; onChange: (env: EnvJson) => void; catalog: CatalogLoad }) {
  const [tab, setTab] = useState<Tab>('catalog')
  return (
    <Modal open={open} onClose={onClose} title="Add MCP server" width={560} testId="add-mcp-modal">
      <div className="te-env-modal">
        <Segmented
          items={[
            { id: 'catalog' as Tab, label: 'Itera catalog' },
            { id: 'repo' as Tab, label: 'From task repo' },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'catalog' ? (
          <CatalogTab env={env} catalog={catalog} onAdd={(entry) => { onChange(addCatalogServer(env, entry)); onClose() }} switchToRepo={() => setTab('repo')} />
        ) : (
          <RepoTab env={env} onAdd={(input) => { onChange(addRepoServer(env, input)); onClose() }} />
        )}
      </div>
    </Modal>
  )
}

function CatalogTab({ env, catalog, onAdd, switchToRepo }: { env: EnvJson; catalog: CatalogLoad; onAdd: (e: McpCatalogServer) => void; switchToRepo: () => void }) {
  const [q, setQ] = useState('')
  const used = useMemo(() => new Set(serversOf(env).map((s) => s.name)), [env])
  const list = (catalog.servers ?? []).filter((e) => e.status !== 'retired')
  const shown = list.filter((e) => !q.trim() || [e.name, e.description ?? '', ...e.capabilities].join(' ').toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <div className="te-env-modal__pane" data-testid="add-mcp-catalog">
      <SearchInput width="100%" placeholder="Search the catalog" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the catalog" />
      {catalog.status === 'loading' && (
        <div className="te-env-skel" data-testid="catalog-loading" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <span className="te-env-skel__row" key={i} />
          ))}
        </div>
      )}
      {catalog.status === 'error' && (
        <div className="te-env-empty" data-testid="catalog-error">
          <span className="ta-error" role="alert">
            Could not load the catalog.
          </span>
          <Button variant="secondary" size={30} onClick={catalog.reload}>
            Try again
          </Button>
        </div>
      )}
      {catalog.status === 'ready' && list.length === 0 && (
        <div className="te-env-empty" data-testid="catalog-empty">
          <span className="te-muted">The catalog has no servers yet. Use a server from your repo.</span>
          <button type="button" className="te-link" onClick={switchToRepo}>
            From task repo
          </button>
        </div>
      )}
      {catalog.status === 'ready' && list.length > 0 && shown.length === 0 && (
        <div className="te-env-empty" data-testid="catalog-no-match">
          <span className="te-muted">No servers match.</span>
        </div>
      )}
      {shown.length > 0 && (
        <div className="te-env-catalog" data-testid="catalog-list">
          {shown.map((e) => {
            const added = used.has(e.name)
            return (
              <div className="te-env-catalog__row" key={e.ref} data-testid="catalog-row" data-ref={e.ref}>
                <div className="te-env-catalog__main">
                  <span className="te-env-name">{e.name}</span>
                  <span className="te-env-desc">{e.description ?? 'No description.'}</span>
                  <span className="te-env-catalog__tags">
                    {e.capabilities.slice(0, 4).map((c) => (
                      <TagPill key={c}>{c}</TagPill>
                    ))}
                    {e.status === 'unpublished' && <Badge tone="warning">Image not published</Badge>}
                  </span>
                </div>
                <div className="te-env-catalog__side">
                  <span className="te-mono te-muted">
                    {e.tools.length} tools · v{e.version}
                  </span>
                  <Button variant="secondary" size={30} disabled={added} onClick={() => onAdd(e)} data-testid="catalog-add">
                    {added ? 'Added' : 'Add'}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function RepoTab({ env, onAdd }: { env: EnvJson; onAdd: (input: { name: string; transport: 'stdio' | 'http'; image: string; allowedTools: string[] }) => void }) {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'http'>('http')
  const [image, setImage] = useState('')
  const [tools, setTools] = useState('')
  const [touched, setTouched] = useState(false)
  const allowedTools = tools.split(/[\s,]+/).filter(Boolean)
  const error = repoServerError(env, { name, image, allowedTools })
  return (
    <div className="te-env-modal__pane" data-testid="add-mcp-repo">
      <span className="te-muted">Servers in your repo run only after review. A reviewer reads the server before it can run, and it is never started before that.</span>
      <Field label="Name" htmlFor="env-repo-name" hint="Sets the tool prefix the agent sees, for example stripe_create_charge.">
        <Input id="env-repo-name" mono compact value={name} maxLength={32} onChange={(e) => setName(e.target.value.toLowerCase())} />
      </Field>
      <Field label="Transport">
        <Select
          value={transport}
          onChange={(v) => setTransport(v as 'stdio' | 'http')}
          options={[
            { value: 'http', label: 'http' },
            { value: 'stdio', label: 'stdio' },
          ]}
          aria-label="Transport"
        />
      </Field>
      <Field label="Image" htmlFor="env-repo-image" hint="Pinned by digest.">
        <Input id="env-repo-image" mono compact placeholder="registry/name@sha256:…" value={image} onChange={(e) => setImage(e.target.value)} />
      </Field>
      <Field label="Allowed tools" htmlFor="env-repo-tools" hint="Tool names, separated by commas. You cannot list them from a server that was never started.">
        <Input id="env-repo-tools" mono compact value={tools} onChange={(e) => setTools(e.target.value)} />
      </Field>
      <div className="te-env-warn">A reviewer reads the server before it can run. The task cannot be Ready until the review passes.</div>
      {touched && error && (
        <span className="ta-error" role="alert" data-testid="repo-error">
          {error}
        </span>
      )}
      <div>
        <Button
          variant="primary"
          size={36}
          data-testid="repo-add"
          onClick={() => {
            setTouched(true)
            if (!error) onAdd({ name, transport, image: image.trim(), allowedTools })
          }}
        >
          Add for review
        </Button>
      </div>
    </div>
  )
}

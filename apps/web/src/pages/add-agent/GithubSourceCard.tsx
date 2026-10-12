import { useState, type ReactNode } from 'react'
import { api } from '../../lib/api'
import type { GithubCommit } from '../../lib/api'
import { Badge, Button, Card, Field, Input, Select, StatusChip, type SelectOption } from '../../tma/ui'
import { describeError } from './errors'
import type { GithubPin, GithubSource, Validation } from './useGithubSource'

const short = (sha: string) => sha.slice(0, 7)
const fmtDate = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function SkeletonRow() {
  return (
    <div className="ta-pair" data-testid="source-loading" aria-busy="true">
      <div className="ta-skel" />
      <div className="ta-skel" />
    </div>
  )
}

/** Opens the install page of the GitHub App in a new tab; the tab is opened first so the pop-up blocker allows it. */
async function openInstall(onStarted: () => void): Promise<string | null> {
  const tab = window.open('', '_blank')
  try {
    const { url } = await api.githubInstallUrl()
    if (tab) {
      tab.opener = null
      tab.location.href = url
    } else {
      window.location.assign(url)
    }
    onStarted()
    return null
  } catch (e) {
    tab?.close()
    return describeError(e, 'Could not start the install. Try again.')
  }
}

/** Copy of the install card; the task editor (U20) swaps the third tile and the intro line. */
export interface InstallCopy {
  intro: string
  tile3: { title: string; detail: string; mono?: boolean }
}
const AGENT_INSTALL_COPY: InstallCopy = {
  intro: 'We read your agent from the repo, pinned to a commit, and run it on our infra. Read-only, on the repos you pick.',
  tile3: { title: 'Point to agent files', detail: 'AGENTS.md, skills/', mono: true },
}

function Disconnected({ gh, copy }: { gh: GithubPin; copy: InstallCopy }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <div className="ta-stack" style={{ gap: 20 }} data-testid="github-disconnected">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="ta-install__title">Install the testmyagent GitHub App</span>
        <span className="ta-install__copy">{copy.intro}</span>
      </div>
      <div className="ta-tiles">
        <div className="ta-tile ta-tile--on">
          <span className="ta-tile__n">01</span>
          <span className="ta-tile__t">Install app</span>
          <span className="ta-tile__d">On your user or org.</span>
        </div>
        <div className="ta-tile">
          <span className="ta-tile__n">02</span>
          <span className="ta-tile__t">Pick repo</span>
          <span className="ta-tile__d">Only selected repos.</span>
        </div>
        <div className="ta-tile">
          <span className="ta-tile__n">03</span>
          <span className="ta-tile__t">{copy.tile3.title}</span>
          <span className={copy.tile3.mono ? 'ta-tile__d ta-tile__d--mono' : 'ta-tile__d'}>{copy.tile3.detail}</span>
        </div>
      </div>
      <div className="ta-install__cta">
        <Button
          variant="inverse"
          disabled={busy}
          data-testid="install-github"
          onClick={async () => {
            setBusy(true)
            setError(null)
            setError(await openInstall(gh.startWaiting))
            setBusy(false)
          }}
        >
          Install GitHub App
        </Button>
        <span className="ta-install__note">{gh.waiting ? 'Waiting for GitHub… finish the install in the other tab.' : 'Opens github.com in a new tab.'}</span>
      </div>
      {error && <span className="ta-error" role="alert">{error}</span>}
    </div>
  )
}

function ValidationRow({ gh }: { gh: GithubSource }) {
  const v: Validation = gh.validation
  if (v.phase === 'idle') return <div className="ta-verify" />
  if (v.phase === 'running')
    return (
      <div className="ta-verify" data-testid="validation-running">
        <Badge tone="warning">
          <span className="ta-spin" />
          Checking
        </Badge>
        <span className="ta-verify__text">Reading files…</span>
      </div>
    )
  if (v.phase === 'ok')
    return (
      <div className="ta-verify" data-testid="validation-ok">
        <StatusChip status="verified" dot />
        <span className="ta-verify__text">
          {v.result.summary} at {v.result.shortCommit ?? v.result.commit.slice(0, 7)}
        </span>
      </div>
    )
  if (v.phase === 'fail') {
    const tooLarge = v.result.errorCode === 'too_large'
    const cands = (v.result.candidates ?? []).slice(0, 4)
    return (
      <div className="ta-stack" style={{ gap: 10 }} data-testid="validation-fail">
        <div className="ta-verify">
          <Badge tone="danger" dot>
            {tooLarge ? 'Too large' : 'No agent files'}
          </Badge>
          <span className="ta-verify__text ta-verify__text--bad">
            {tooLarge ? 'The agent files are over the size cap. Remove large files from the path.' : 'Add AGENTS.md or CLAUDE.md at this path.'}
          </span>
        </div>
        {!tooLarge && cands.length > 0 && (
          <div className="ta-verify__try">
            Found an agent in:
            {cands.map((c) => (
              <Button key={c} variant="secondary" size={30} className="ta-mono13" onClick={() => gh.setAgentPath(c)}>
                {c}
              </Button>
            ))}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="ta-verify" data-testid="validation-error">
      <Badge tone="danger" dot>
        {v.gone ? 'Access removed' : 'Not checked'}
      </Badge>
      <span className="ta-verify__text ta-verify__text--bad">{v.message}</span>
      {!v.gone && (
        <Button variant="secondary" size={30} onClick={gh.revalidate}>
          Try again
        </Button>
      )}
    </div>
  )
}

function Connected({ gh, pathLabel, path, onPath, footer, repoAside }: { gh: GithubPin; pathLabel: string; path: string; onPath: (p: string) => void; footer?: ReactNode; repoAside?: ReactNode }) {
  const data = gh.source.data!
  const accounts = [...new Set(data.installations.map((i) => i.accountLogin).filter(Boolean))] as string[]
  const first = data.installations[0]
  const n = data.repos.length

  if (n === 0)
    return (
      <div className="ta-stack" data-testid="github-no-repos">
        <div className="ta-info">
          <span>
            App installed on <b>{accounts.join(', ') || 'your account'}</b> · 0 repos selected
          </span>
          <a href={`https://github.com/settings/installations/${first.installationId}`} target="_blank" rel="noreferrer">
            Manage on GitHub ↗
          </a>
        </div>
        <span className="ta-help">Select a repo on GitHub. This page updates when you come back.</span>
      </div>
    )

  const repoOptions: SelectOption[] = data.repos.map((r) => ({
    value: r.fullName,
    label: (
      <span className="ta-repo">
        {r.fullName}
        {r.private && <span className="ta-pill">private</span>}
      </span>
    ),
  }))
  const branchList = gh.branches.data?.branches ?? []
  const branchOptions: SelectOption[] = branchList.map((b) => ({
    value: b.name,
    label: <span className="ta-mono13">{b.name}</span>,
    meta: short(b.headSha),
    note: b.isDefault ? 'default' : undefined,
  }))
  const commitList: GithubCommit[] = gh.commits.data?.commits ?? []
  const commitOptions: SelectOption[] = commitList.map((c, i) => ({
    value: c.sha,
    label:
      i === 0 ? (
        <span className="ta-sans13">
          Latest · <span className="ta-mono13">{c.shortSha || short(c.sha)}</span>
        </span>
      ) : (
        <span className="ta-mono13">{c.shortSha || short(c.sha)}</span>
      ),
    meta: c.message.split('\n')[0].slice(0, 60),
    note: fmtDate(c.date) || undefined,
  }))
  const branchLoading = gh.branches.status === 'loading' && !gh.branches.data
  const commitLoading = gh.commits.status === 'loading' && !gh.commits.data

  return (
    <div className="ta-stack" data-testid="github-connected">
      <div className="ta-info">
        <span>
          App installed on <b>{accounts.join(', ') || 'your account'}</b> · {n} {n === 1 ? 'repo' : 'repos'} selected
        </span>
        <a href={`https://github.com/settings/installations/${first.installationId}`} target="_blank" rel="noreferrer">
          Manage on GitHub ↗
        </a>
      </div>
      <div className="ta-pair">
        <Field label="Repository" htmlFor="ta-repo">
          <Select id="ta-repo" value={gh.repo?.fullName ?? null} options={repoOptions} onChange={gh.setRepo} aria-label="Repository" />
        </Field>
        <Field label="Branch" htmlFor="ta-branch" error={gh.branches.status === 'error' ? 'Could not load branches.' : undefined}>
          <Select
            id="ta-branch"
            value={gh.branch}
            options={branchOptions.length ? branchOptions : gh.branch ? [{ value: gh.branch, label: <span className="ta-mono13">{gh.branch}</span> }] : []}
            onChange={gh.setBranch}
            disabled={branchLoading}
            placeholder={branchLoading ? 'Loading…' : 'No branches'}
            aria-label="Branch"
          />
        </Field>
      </div>
      <div className="ta-pair">
        <Field label={pathLabel} htmlFor="ta-path">
          <Input id="ta-path" mono value={path} placeholder="." spellCheck={false} onChange={(e) => onPath(e.target.value)} />
        </Field>
        <Field label="Pinned commit" htmlFor="ta-commit" error={gh.commits.status === 'error' ? 'Could not load commits. The branch head is used.' : undefined}>
          <Select
            id="ta-commit"
            value={gh.commit}
            options={commitOptions}
            onChange={gh.setCommit}
            disabled={commitLoading || commitOptions.length === 0}
            placeholder={commitLoading ? 'Loading…' : 'Latest'}
            aria-label="Pinned commit"
          />
        </Field>
      </div>
      {repoAside}
      {footer}
    </div>
  )
}

/**
 * Source card of a GitHub pin: install card when the App is not connected, else Repository,
 * Branch, path and Pinned commit. 02 passes the agent path and its validation row; the task
 * editor (U20) passes the task path and its layout check.
 */
export function GithubPinCard({
  gh,
  title,
  badge,
  pathLabel,
  path,
  onPath,
  footer,
  repoAside,
  installCopy = AGENT_INSTALL_COPY,
  testId = 'source-card',
}: {
  gh: GithubPin
  title: ReactNode
  /** Status badge when connected (02: Connected). */
  badge: ReactNode
  pathLabel: string
  path: string
  onPath: (p: string) => void
  footer?: ReactNode
  /** Rendered under the selects, before the footer (task editor: open / sealed tests label). */
  repoAside?: ReactNode
  installCopy?: InstallCopy
  testId?: string
}) {
  const { source } = gh
  const loading = source.status === 'loading' && !source.data
  const connected = (source.data?.installations.length ?? 0) > 0
  const failed = source.status === 'error' && !source.data
  return (
    <Card className="ta-card" data-testid={testId}>
      <div className="ta-card__top">
        <span className="tma-label">{title}</span>
        {connected ? badge : <Badge tone="neutral">{loading ? 'Checking' : 'Not connected'}</Badge>}
      </div>
      {loading && <SkeletonRow />}
      {failed && (
        <div className="ta-stack" data-testid="source-error">
          <span className="ta-error" role="alert">{describeError(source.error, 'Could not load your GitHub connection. Try again.')}</span>
          <div>
            <Button variant="secondary" size={32} onClick={source.reload}>
              Try again
            </Button>
          </div>
        </div>
      )}
      {!loading && !failed &&
        (connected ? (
          <Connected gh={gh} pathLabel={pathLabel} path={path} onPath={onPath} footer={footer} repoAside={repoAside} />
        ) : (
          <Disconnected gh={gh} copy={installCopy} />
        ))}
    </Card>
  )
}

export function GithubSourceCard({ gh }: { gh: GithubSource }) {
  return (
    <GithubPinCard
      gh={gh}
      title="Source · GitHub"
      badge={<StatusChip status="confirmed" dot />}
      pathLabel="Agent path"
      path={gh.agentPath}
      onPath={gh.setAgentPath}
      footer={<ValidationRow gh={gh} />}
    />
  )
}

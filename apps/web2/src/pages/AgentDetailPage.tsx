/**
 * Screen 08 — Agent detail (design: "08 Agent Detail.dc.html"; plan 20261012-itera-testmyagent-ui-refactor, U15 + U16).
 * Data: GET /agents/:id/profile (public for a listed agent with issued evidence; its owner always)
 *       GET /agents/:id/my-results (signed in only: results on the viewer's own tasks).
 * The route is open: a shared agent link reads logged out. Private results appear only to the owner of the task.
 * The README badge card (U16) previews GET /badge/agents/:slug.svg and copies its Markdown on click.
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useSession } from '../auth/session'
import { ApiError, api } from '../lib/api'
import type { AgentEvidenceRow, AgentProfileResponse, MyResultRow } from '../lib/api'
import { AgentAvatar, Badge, Breadcrumb, Button, ButtonLink, Card, Input, ModelLabel, TagPill, Table, TableEmpty, type Column } from '../tma/ui'
import { TaskName } from '../tma/task-filter'
import { AvatarCropper, renderCrop, type CropState } from './profile-settings/AvatarCropper'
import './profile-settings/profile-settings.css'
import './agent-detail.css'

const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const longDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** "2d" + "ago": the stat strip shows the number big and the unit word small. */
export function relativeAge(iso: string | null, now = Date.now()): { value: string; unit: string } | null {
  if (!iso) return null
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const min = Math.max(0, Math.floor(ms / 60_000))
  if (min < 60) return { value: `${Math.max(min, 1)}m`, unit: 'ago' }
  const h = Math.floor(min / 60)
  if (h < 24) return { value: `${h}h`, unit: 'ago' }
  return { value: `${Math.floor(h / 24)}d`, unit: 'ago' }
}

export function formatScore(n: number | null): string {
  return n == null ? '—' : n.toFixed(1)
}

/** The Markdown of the README badge: image from the API, link to the public evaluation (or this page). */
export function badgeMarkdown(profile: AgentProfileResponse, apiBadgeUrl: string, origin: string): string {
  const key = profile.agent.slug ?? profile.agent.id
  const link = profile.badge?.markdownLinkPath ? `${origin}${profile.badge.markdownLinkPath}` : `${origin}/agents/${encodeURIComponent(key)}`
  return `[![TestMyAgent](${apiBadgeUrl})](${link})`
}

function OutcomeBadge({ outcome }: { outcome: 'PASS' | 'FAIL' }) {
  return <Badge tone={outcome === 'PASS' ? 'success' : 'danger'}>{outcome}</Badge>
}

function Skeleton({ width, height = 14 }: { width: number | string; height?: number }) {
  return <span className="tad-skel" style={{ width, height }} />
}

type Load = { state: 'loading' } | { state: 'notfound' } | { state: 'error'; message: string } | { state: 'ready'; profile: AgentProfileResponse }

const EVIDENCE_COLUMNS: Column<AgentEvidenceRow>[] = [
  {
    key: 'task',
    header: 'Task',
    width: 'minmax(0,1fr)',
    render: (e) => (
      <span className="tad-task">
        <TaskName className="tad-task__name" name={e.name} taskId={e.taskId} slug={e.taskSlug} />
        <span className="tad-task__date">{shortDate.format(new Date(e.at))}</span>
      </span>
    ),
  },
  {
    key: 'tags',
    header: 'Tags',
    width: '200px',
    render: (e) => (
      <span className="tad-tags">
        {e.tags.map((t) => (
          <TagPill key={t.id}>{t.name}</TagPill>
        ))}
      </span>
    ),
  },
  { key: 'outcome', header: 'Outcome', width: '80px', render: (e) => <OutcomeBadge outcome={e.outcome} /> },
  {
    key: 'tests',
    header: 'Tests',
    width: '64px',
    align: 'right',
    render: (e) => <span className="tad-mono">{e.testsTotal == null ? '—' : `${e.testsPassed} / ${e.testsTotal}`}</span>,
  },
]

export function AgentDetailPage() {
  const { aid = '' } = useParams()
  const session = useSession()
  const signedIn = session.status === 'signed-in'
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoad({ state: 'loading' })
    api
      .agentProfile(aid)
      .then((profile) => !cancelled && setLoad({ state: 'ready', profile }))
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 404) setLoad({ state: 'notfound' })
        else setLoad({ state: 'error', message: err instanceof Error ? err.message : 'Request failed' })
      })
    return () => {
      cancelled = true
    }
    // The session status changes the answer for the owner of a draft agent: refetch on sign-in.
  }, [aid, attempt, signedIn])

  if (load.state === 'notfound') {
    return (
      <main className="tma-page tad" data-testid="agent-detail-notfound">
        <Breadcrumb items={[{ label: 'Agents', to: '/agents' }, { label: 'Not found' }]} />
        <Card pad className="tad-empty">
          <span className="tma-h3">Agent not found</span>
          <span className="tma-body-sm tma-muted">This agent does not exist, or it is private and has no public evidence yet.</span>
          <div>
            <ButtonLink variant="secondary" size={32} href="/agents">
              Back to agents
            </ButtonLink>
          </div>
        </Card>
      </main>
    )
  }
  if (load.state === 'error') {
    return (
      <main className="tma-page tad" data-testid="agent-detail-error" role="alert">
        <Breadcrumb items={[{ label: 'Agents', to: '/agents' }, { label: 'Error' }]} />
        <Card pad className="tad-empty">
          <span className="tma-h3">Could not load this agent</span>
          <span className="tma-body-sm tma-muted">{load.message}</span>
          <div>
            <Button variant="secondary" size={32} onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        </Card>
      </main>
    )
  }
  if (load.state === 'loading') {
    return (
      <main className="tma-page tad" data-testid="agent-detail-loading" aria-busy="true">
        <Skeleton width={160} />
        <div className="tad-grid">
          <div className="tad-main">
            <div className="tad-identity">
              <Skeleton width={72} height={72} />
              <div className="tad-identity__text">
                <Skeleton width={260} height={40} />
                <Skeleton width={420} />
              </div>
            </div>
            <Skeleton width="60%" height={20} />
            <Skeleton width="100%" height={96} />
            <Skeleton width="100%" height={220} />
          </div>
          <div className="tad-rail">
            <Skeleton width="100%" height={260} />
            <Skeleton width="100%" height={150} />
          </div>
        </div>
      </main>
    )
  }
  return <Ready profile={load.profile} signedIn={signedIn} onConnect={session.signIn} onChanged={() => setAttempt((n) => n + 1)} />
}

function Ready({ profile, signedIn, onConnect, onChanged }: { profile: AgentProfileResponse; signedIn: boolean; onConnect: () => void; onChanged: () => void }) {
  const { agent, source, model, stats, tags, evidence, latestAttestation } = profile
  const age = relativeAge(stats.lastVerifiedAt)
  // Screen 03 reads GET /agents/:id and posts the quote with the agent id; the slug would answer 404 "Agent not found".
  const chooseHref = `/agents/${encodeURIComponent(agent.id)}/evaluate`

  return (
    <main className="tma-page tad" data-testid="agent-detail" data-agent={agent.id}>
      <Breadcrumb items={[{ label: 'Agents', to: '/agents' }, { label: agent.name }]} />

      <div className="tad-grid">
        <div className="tad-main">
          <div className="tad-identity">
            <AgentAvatar id={agent.id} name={agent.name} src={agent.avatarUrl} size={72} author={{ name: agent.authorName, avatarUrl: agent.authorProfile?.avatarUrl }} />
            <div className="tad-identity__text">
              <h1 className="tad-h1" data-testid="agent-name">
                {agent.name}
              </h1>
              <span className="tad-meta">
                by <span className="tad-meta__strong">{agent.authorName}</span>
                {agent.listedAt && <> · listed {longDate.format(new Date(agent.listedAt))}</>} · <ModelLabel model={model.id} label={model.label} size={20} className="tad-meta__model" /> via OpenRouter
                {source.commitShort && (
                  <>
                    {' '}
                    · <span className="tad-mono tad-meta__commit">{source.commitShort}</span>
                  </>
                )}
              </span>
            </div>
          </div>

          {agent.isMine && <AgentEditor profile={profile} onChanged={onChanged} />}

          {agent.description && <p className="tad-desc">{agent.description}</p>}

          {tags.length > 0 && (
            <div className="tad-taglist" data-testid="agent-tags">
              {tags.map((t) => (
                <TagPill key={t.id} large count={t.count}>
                  {t.name}
                </TagPill>
              ))}
            </div>
          )}

          <div className="tad-stats" data-testid="agent-stats">
            <Stat label="Score" testId="stat-score">
              {formatScore(stats.score)}
            </Stat>
            <Stat label="Tasks evaluated" testId="stat-tasks">
              {stats.tasksEvaluated}
            </Stat>
            <Stat label="Evaluations" testId="stat-evaluations">
              {stats.evaluations}
            </Stat>
            <Stat label="Last verified" testId="stat-last">
              {age ? (
                <>
                  {age.value} <span className="tad-stat__unit">{age.unit}</span>
                </>
              ) : (
                '—'
              )}
            </Stat>
          </div>

          <OnYourTasks agent={agent} signedIn={signedIn} onConnect={onConnect} chooseHref={chooseHref} />

          {agent.isMine && (profile.history?.length ?? 0) > 0 && (
            <Card className="tad-section" data-testid="account-history">
              <div className="tad-section__head">
                <span className="tad-section__title">Your evaluation history</span>
                <span className="tad-section__sub">Private results, visible only to you.</span>
              </div>
              <div className="tad-history" role="table" aria-label="Your evaluation history">
                <div className="tad-history__head" role="row"><span>Task</span><span>Status</span><span>Score</span><span>Date</span><span /></div>
                {profile.history!.map((e) => (
                  <Link className="tad-history__row" role="row" key={e.id} to={e.path} data-testid="account-history-row">
                    <strong>{e.taskNames.join(', ') || 'Evaluation'}</strong>
                    <Badge tone={e.status === 'graded' || e.status === 'issued' ? 'success' : e.status === 'failed' ? 'danger' : 'neutral'}>{e.status}</Badge>
                    <span className="tad-history__score">{formatScore(e.score)}</span>
                    <time>{e.at ? shortDate.format(new Date(e.at)) : '—'}</time>
                    <span className="tad-history__arrow" aria-hidden="true">→</span>
                  </Link>
                ))}
              </div>
            </Card>
          )}

          <Card className="tad-section" data-testid="public-evidence">
            <div className="tad-section__head tad-section__head--baseline">
              <span className="tad-section__title">Public evidence</span>
              <span className="tad-section__meta">
                {stats.tasksEvaluated} {stats.tasksEvaluated === 1 ? 'task' : 'tasks'} · {stats.evaluations} {stats.evaluations === 1 ? 'evaluation' : 'evaluations'}
              </span>
            </div>
            <Table
              columns={EVIDENCE_COLUMNS}
              rows={evidence}
              rowKey={(e, i) => `${e.taskId ?? e.name}-${i}`}
              gap={16}
              rowHeight={53}
              testId="evidence-table"
              empty={
                <TableEmpty title="No public evidence yet">
                  <span className="tad-empty-text">{agent.isMine ? 'Run this agent on public tasks. Each graded evaluation adds its results here.' : 'This agent has no graded evaluation on a public task.'}</span>
                  {agent.isMine && (
                    <Link to={chooseHref} className="tma-body-sm">
                      Choose tasks →
                    </Link>
                  )}
                </TableEmpty>
              }
            />
          </Card>
        </div>

        <aside className="tad-rail">
          <Card pad className="tad-source" data-testid="agent-source">
            <span className="tma-label">Source</span>
            {source.repoFullName ? (
              <a href={`https://github.com/${source.repoFullName}/tree/${source.commit ?? source.branch ?? 'HEAD'}/${source.agentPath && source.agentPath !== '.' ? source.agentPath : ''}`} target="_blank" rel="noreferrer" data-testid="agent-source-link">
                <strong>{source.repoFullName}</strong><span>{source.agentPath && source.agentPath !== '.' ? source.agentPath : 'Repository root'} ↗</span>
              </a>
            ) : <span className="tad-source__empty">No verified repository source is available for this agent.</span>}
          </Card>
          {latestAttestation?.evaluationSlug && (
            <ButtonLink variant="secondary" block href={`/e/${latestAttestation.evaluationSlug}`} data-testid="open-evaluation-profile">
              Open evaluation profile
            </ButtonLink>
          )}

          <Card pad className="tad-run" data-testid="run-card">
            <span className="tad-run__title">Run {agent.name} on your tasks</span>
            <span className="tad-run__text">
              Pick any public or private task.{' '}
              Free. Bring your own OpenRouter key.
            </span>
            <ButtonLink variant="primary" href={chooseHref} data-testid="choose-tasks">
              Choose tasks
            </ButtonLink>
          </Card>

          {profile.badge && <BadgeCard profile={profile} />}
        </aside>
      </div>
    </main>
  )
}

const AGENT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
function imageFrom(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('This file is not a readable image.'))
    img.src = URL.createObjectURL(file)
  })
}

function AgentEditor({ profile, onChanged }: { profile: AgentProfileResponse; onChanged: () => void }) {
  const agent = profile.agent
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(agent.name)
  const [crop, setCrop] = useState<CropState | null>(null)
  const [removeImage, setRemoveImage] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const select = async (file: File | undefined) => {
    if (!file) return
    if (!AGENT_IMAGE_TYPES.includes(file.type) || file.size > 2 * 1024 * 1024) {
      setNotice({ tone: 'bad', text: 'Use a PNG, JPEG, or WebP image up to 2 MB.' })
      return
    }
    try {
      setCrop({ img: await imageFrom(file), zoom: 1, x: 0, y: 0 })
      setRemoveImage(false)
      setNotice(null)
    } catch (e) {
      setNotice({ tone: 'bad', text: e instanceof Error ? e.message : 'Could not read this image.' })
    }
  }
  const save = async () => {
    const clean = name.trim()
    if (clean.length < 2 || clean.length > 80) {
      setNotice({ tone: 'bad', text: 'Use between 2 and 80 characters for the agent name.' })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      await api.patchAgentProfile(agent.id, clean)
      if (crop) await api.uploadAgentAvatar(agent.id, await renderCrop(crop), 'agent.png')
      else if (removeImage) await api.deleteAgentAvatar(agent.id)
      setNotice({ tone: 'ok', text: 'Agent saved.' })
      setCrop(null)
      setRemoveImage(false)
      onChanged()
    } catch (e) {
      setNotice({ tone: 'bad', text: e instanceof Error ? e.message : 'Could not save the agent.' })
    } finally {
      setBusy(false)
    }
  }
  if (!open) return <Button variant="secondary" size={32} onClick={() => setOpen(true)} data-testid="edit-agent">Edit agent</Button>
  return (
    <Card pad className="tad-editor" data-testid="agent-editor">
      <div className="tad-editor__head"><strong>Edit agent</strong><Button variant="text" size={32} onClick={() => setOpen(false)}>Close</Button></div>
      <label><span className="tma-label">Name</span><Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Agent name" /></label>
      <input ref={fileRef} type="file" hidden accept={AGENT_IMAGE_TYPES.join(',')} onChange={(e) => void select(e.target.files?.[0])} />
      <div className="tad-editor__image-actions">
        <Button variant="secondary" size={32} onClick={() => fileRef.current?.click()}>{agent.avatarUrl ? 'Replace image' : 'Upload image'}</Button>
        {(agent.avatarUrl || crop) && <Button variant="text" size={32} onClick={() => { setCrop(null); setRemoveImage(true) }}>Remove image</Button>}
      </div>
      {crop && <AvatarCropper crop={crop} onChange={setCrop} />}
      {removeImage && <span className="tad-editor__pending">The current image will be removed when you save.</span>}
      {notice && <span className={`tad-editor__notice tad-editor__notice--${notice.tone}`} role="status">{notice.text}</span>}
      <Button variant="primary" onClick={() => void save()} disabled={busy} data-testid="save-agent">{busy ? 'Saving…' : 'Save agent'}</Button>
    </Card>
  )
}

function Stat({ label, children, testId }: { label: string; children: React.ReactNode; testId: string }) {
  return (
    <div className="tad-stat">
      <span className="tma-label">{label}</span>
      <span className="tad-stat__value" data-testid={testId}>
        {children}
      </span>
    </div>
  )
}

type Mine = { state: 'loading' } | { state: 'error' } | { state: 'ready'; rows: MyResultRow[] }

/** "On your tasks": this agent's private results, visible only to the viewer. Signed out: a connect prompt. */
function OnYourTasks({ agent, signedIn, onConnect, chooseHref }: { agent: AgentProfileResponse['agent']; signedIn: boolean; onConnect: () => void; chooseHref: string }) {
  const [mine, setMine] = useState<Mine>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!signedIn) return
    let cancelled = false
    setMine({ state: 'loading' })
    api
      .agentMyResults(agent.slug ?? agent.id)
      .then((r) => !cancelled && setMine({ state: 'ready', rows: r.results }))
      .catch(() => !cancelled && setMine({ state: 'error' }))
    return () => {
      cancelled = true
    }
  }, [agent.id, agent.slug, signedIn, attempt])

  const columns: Column<MyResultRow>[] = [
    { key: 'task', header: 'Task', width: 'minmax(0,1fr)', render: (r) => <TaskName className="tad-task__name" name={r.task.name} taskId={r.task.id} /> },
    { key: 'outcome', header: 'Outcome', width: '90px', render: (r) => <OutcomeBadge outcome={r.outcome} /> },
    { key: 'score', header: agent.name, width: '130px', align: 'right', render: (r) => <span className="tad-score">{formatScore(r.score)}</span> },
    {
      key: 'best',
      header: 'Your best agent',
      width: '200px',
      align: 'right',
      render: (r) =>
        r.bestOwnAgent ? (
          <span className="tad-best">
            {r.bestOwnAgent.name} <span className="tad-score">{formatScore(r.bestOwnAgent.score)}</span>
          </span>
        ) : (
          <span className="tad-subtle">—</span>
        ),
    },
    { key: 'evaluation', header: '', width: '42px', align: 'right', render: (r) => r.evaluationId ? <Link to={`/evaluations/${r.evaluationId}`} aria-label={`Open evaluation for ${r.task.name}`}>→</Link> : <span>—</span> },
  ]

  return (
    <Card className="tad-section" data-testid="on-your-tasks">
      <div className="tad-section__head">
        <div className="tad-section__titles">
          <span className="tad-section__title">On your tasks</span>
          <span className="tad-section__sub">Private results, visible only to you.</span>
        </div>
        <ButtonLink variant="secondary" size={32} href={chooseHref}>
          Run on more tasks
        </ButtonLink>
      </div>
      {!signedIn ? (
        <div className="tad-state" data-testid="on-your-tasks-signed-out">
          <span className="tad-empty-text">Log in with DFL to see how {agent.name} does on your own tasks.</span>
          <Button variant="secondary" size={32} onClick={onConnect} data-testid="agent-login">
            Login with DFL
          </Button>
        </div>
      ) : mine.state === 'loading' ? (
        <div className="tad-state" aria-busy="true" data-testid="on-your-tasks-loading">
          <Skeleton width="100%" height={52} />
        </div>
      ) : mine.state === 'error' ? (
        <div className="tad-state" role="alert" data-testid="on-your-tasks-error">
          <span className="tad-empty-text">Could not load your results.</span>
          <Button variant="secondary" size={32} onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      ) : (
        <Table
          columns={columns}
          rows={mine.rows}
          rowKey={(r) => r.task.id}
          gap={16}
          rowHeight={53}
          testId="my-results-table"
          empty={
            <TableEmpty title="No results on your tasks yet">
              <Link to={chooseHref} className="tma-body-sm">
                Choose tasks →
              </Link>
            </TableEmpty>
          }
        />
      )}
    </Card>
  )
}

/** README badge (U16): preview + a button that copies the Markdown (the snippet itself is not shown). */
function BadgeCard({ profile }: { profile: AgentProfileResponse }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  if (!profile.badge) return null
  const key = profile.agent.slug ?? profile.agent.id
  const url = api.agentBadgeUrl(key)
  const markdown = badgeMarkdown(profile, url, window.location.origin)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown)
    } catch {
      window.prompt('Copy this Markdown', markdown)
    }
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 2000)
  }
  return (
    <Card pad className="tad-badge" data-testid="badge-card">
      <span className="tad-run__title">README badge</span>
      <img className="tad-badge__img" src={url} alt={`TestMyAgent badge of ${profile.agent.name}`} height={20} data-testid="badge-img" />
      <Button variant="secondary" size={32} onClick={copy} data-testid="copy-badge">
        {copied ? 'Copied' : 'Copy Markdown'}
      </Button>
    </Card>
  )
}

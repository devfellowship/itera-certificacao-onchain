/**
 * Screen 08 — Agent detail (design: "08 Agent Detail.dc.html"; plan 20261012-itera-testmyagent-ui-refactor, U15 + U16).
 * Data: GET /agents/:id/profile (public for a listed agent with issued evidence; its owner always)
 *       GET /agents/:id/my-results (signed in only: results on the viewer's own tasks).
 * The route is open: a shared agent link reads logged out. Private results appear only to the owner of the task.
 * The README badge card (U16) shows the Markdown snippet of GET /badge/agents/:slug.svg.
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useSession } from '../auth/session'
import { ApiError, api } from '../lib/api'
import type { AgentEvidenceRow, AgentProfileResponse, MyResultRow } from '../lib/api'
import { Avatar, Badge, Breadcrumb, Button, ButtonLink, Card, CardHeader, KeyValue, TagPill, Table, TableEmpty, type Column } from '../tma/ui'
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

/** Per-task fee in SOL for the run card: up to 5 decimals, no trailing zeros ("0.00092"). */
export function formatFeeSol(sol: string | null): string | null {
  if (sol == null) return null
  const n = Number(sol)
  return Number.isFinite(n) ? String(Number(n.toFixed(5))) : null
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
        <span className="tad-task__name">{e.name}</span>
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
  {
    key: 'att',
    header: 'Attestation',
    width: '120px',
    align: 'right',
    render: (e) =>
      e.attestation?.explorerUrl ? (
        <a className="tad-mono tad-att" href={e.attestation.explorerUrl} target="_blank" rel="noreferrer" data-testid="attestation-link">
          {e.attestation.short} ↗
        </a>
      ) : (
        <span className="tad-mono tad-subtle">{e.attestation?.status ?? '—'}</span>
      ),
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
  return <Ready profile={load.profile} signedIn={signedIn} onConnect={session.signIn} />
}

function Ready({ profile, signedIn, onConnect }: { profile: AgentProfileResponse; signedIn: boolean; onConnect: () => void }) {
  const { agent, source, model, stats, tags, evidence, latestAttestation } = profile
  const age = relativeAge(stats.lastVerifiedAt)
  // Screen 03 reads GET /agents/:id and posts the quote with the agent id; the slug would answer 404 "Agent not found".
  const chooseHref = `/agents/${encodeURIComponent(agent.id)}/evaluate`
  const fee = formatFeeSol(profile.price.runCostSol)

  return (
    <main className="tma-page tad" data-testid="agent-detail" data-agent={agent.id}>
      <Breadcrumb items={[{ label: 'Agents', to: '/agents' }, { label: agent.name }]} />

      <div className="tad-grid">
        <div className="tad-main">
          <div className="tad-identity">
            <Avatar initials={agent.initials} size={72} surface="raised" />
            <div className="tad-identity__text">
              <h1 className="tad-h1" data-testid="agent-name">
                {agent.name}
              </h1>
              <span className="tad-meta">
                by <span className="tad-meta__strong">{agent.authorName}</span>
                {agent.listedAt && <> · listed {longDate.format(new Date(agent.listedAt))}</>} · {model.label} via OpenRouter
                {source.commitShort && (
                  <>
                    {' '}
                    · <span className="tad-mono tad-meta__commit">{source.commitShort}</span>
                  </>
                )}
              </span>
            </div>
          </div>

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
                  <span className="tad-empty-text">{agent.isMine ? 'Run this agent on public tasks. Each issued evaluation adds its results here.' : 'This agent has no issued evaluation on a public task.'}</span>
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
          <Card className="tad-section" data-testid="latest-attestation">
            <CardHeader title="Latest attestation">
              {latestAttestation ? (
                <Badge tone="success" dot>
                  Confirmed
                </Badge>
              ) : (
                <Badge tone="neutral">Not issued</Badge>
              )}
            </CardHeader>
            {latestAttestation ? (
              <>
                <KeyValue
                  rows={[
                    { key: 'Network', value: latestAttestation.network },
                    { key: 'Issued', value: longDate.format(new Date(latestAttestation.issuedAt)) },
                    { key: 'Transaction', value: <span className="tad-mono">{latestAttestation.txShort}</span>, testId: 'attestation-tx' },
                  ]}
                />
                <div className="tad-attest-foot">
                  {latestAttestation.evaluationSlug && (
                    <ButtonLink variant="secondary" block href={`/e/${latestAttestation.evaluationSlug}`} data-testid="open-evaluation-profile">
                      Open evaluation profile
                    </ButtonLink>
                  )}
                  <div className="tad-attest-foot__row">
                    <span className="tad-muted">Verifiable without a wallet.</span>
                    <a href={latestAttestation.explorerUrl} target="_blank" rel="noreferrer" data-testid="solscan-link">
                      Solscan ↗
                    </a>
                  </div>
                </div>
              </>
            ) : (
              <div className="tad-attest-foot">
                <span className="tad-muted">No confirmed attestation yet. An evaluation issues one per graded task.</span>
              </div>
            )}
          </Card>

          <Card pad className="tad-run" data-testid="run-card">
            <span className="tad-run__title">Run {agent.name} on your tasks</span>
            <span className="tad-run__text">
              Pick any public or private task.{' '}
              {fee ? (
                <>
                  Fee from {fee} SOL per task (≈ ${profile.price.usdPerRun.toFixed(2)}), paid by you.
                </>
              ) : (
                <>Fee from US${profile.price.usdPerRun.toFixed(2)} per task, paid by you.</>
              )}
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
    { key: 'task', header: 'Task', width: 'minmax(0,1fr)', render: (r) => <span className="tad-task__name">{r.task.name}</span> },
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
          <span className="tad-empty-text">Connect a wallet to see how {agent.name} does on your own tasks.</span>
          <Button variant="secondary" size={32} onClick={onConnect}>
            Connect wallet
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

/** README badge (U16): preview + Markdown snippet + copy. */
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
      <pre className="tad-badge__code" data-testid="badge-snippet">
        {markdown}
      </pre>
      <Button variant="secondary" size={32} onClick={copy} data-testid="copy-badge">
        {copied ? 'Copied' : 'Copy Markdown'}
      </Button>
    </Card>
  )
}

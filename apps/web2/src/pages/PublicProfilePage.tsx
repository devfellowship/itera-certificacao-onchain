/**
 * Screen 05 — public evaluation profile (`/e/:slugOrHash`, lane U14). Works logged out.
 * Data: GET /public/evaluations/:slugOrHash. Link previews come from the web server
 * (apps/web/server.mjs), which injects OG/Twitter meta for /e/* before the SPA loads.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useSession } from '../auth/session'
import { api, ApiError } from '../lib/api'
import type { Outcome, PublicEvaluation, ScorePartKey } from '../lib/api/types'
import { AgentAvatar, Badge, Button, ButtonLink, Input, Lockup, Logo, ModelLabel, StatusChip, TagPill } from '../tma/ui'
import { TaskName } from '../tma/task-filter'
import { NotFoundPage } from './NotFoundPage'
import './public-profile.css'

const PART_LABELS: Array<{ key: ScorePartKey; label: string; max: number }> = [
  { key: 'hidden_behavior', label: 'Hidden tests', max: 50 },
  { key: 'public_behavior', label: 'Public tests', max: 20 },
  { key: 'regression', label: 'Regression', max: 15 },
  { key: 'patch_integrity_and_scope', label: 'Patch scope', max: 10 },
  { key: 'reproducible_evidence', label: 'Evidence', max: 5 },
]

const SEG_COLOR: Record<Outcome, string> = { PASS: 'var(--tma-primary-text)', FAIL: 'var(--tma-danger-text)', INVALID: 'var(--tma-text-muted)' }

function fmtDate(iso: string | null, withTime = false): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  if (!withTime) return date
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
  return `${date} · ${time} UTC`
}

function mmss(ms: number | null): string {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function fmtScore(n: number | null): string {
  if (n == null) return '—'
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function useFlash(): [string | null, (k: string) => void] {
  const [k, setK] = useState<string | null>(null)
  const t = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(t.current), [])
  return [
    k,
    (key: string) => {
      setK(key)
      window.clearTimeout(t.current)
      t.current = window.setTimeout(() => setK(null), 1200)
    },
  ]
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* clipboard blocked: the field still shows the text */
  }
}

function PublicHeader() {
  return (
    <header className="tma-nav pp-nav">
      <Lockup />
      <div className="pp-nav__right">
        <ButtonLink href="/agents/new" variant="primary" size={36}>
          Evaluate your agent
        </ButtonLink>
      </div>
    </header>
  )
}

export function PublicProfilePage() {
  const { slugOrHash = '' } = useParams()
  const [data, setData] = useState<PublicEvaluation | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'notfound' | 'error'>('loading')
  const [error, setError] = useState('')

  const load = useCallback(() => {
    setState('loading')
    api
      .publicEvaluation(slugOrHash)
      .then((d) => {
        setData(d)
        setState('ok')
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) setState('notfound')
        else {
          setError(e instanceof Error ? e.message : String(e))
          setState('error')
        }
      })
  }, [slugOrHash])
  useEffect(load, [load])

  useEffect(() => {
    if (data) document.title = `${data.agent.name} — ${fmtScore(data.score)} on TestMyAgent`
  }, [data])

  return (
    <div className="tma-app pp">
      <PublicHeader />
      {state === 'loading' && (
        <main className="pp-page" data-testid="profile-loading" aria-busy="true">
          <div className="pp-skeleton pp-skeleton--hero" />
          <div className="pp-skeleton pp-skeleton--bar" />
          <div className="pp-skeleton pp-skeleton--grid" />
        </main>
      )}
      {state === 'notfound' && <NotFoundPage />}
      {state === 'error' && (
        <main className="pp-page" data-testid="profile-error">
          <div className="pp-error">
            <span className="pp-error__title">This profile could not load.</span>
            <span className="tma-muted">{error}</span>
            <div>
              <Button variant="secondary" onClick={load}>
                Try again
              </Button>
            </div>
          </div>
        </main>
      )}
      {state === 'ok' && data && <Profile data={data} />}
    </div>
  )
}

function Profile({ data }: { data: PublicEvaluation }) {
  const [copied, flash] = useFlash()
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const shareUrl = `${origin}/e/${data.slug}`
  const shownUrl = shareUrl.replace(/^https?:\/\//, '')
  const n = data.tasks.length
  const ogTitle = `${data.agent.name} — ${fmtScore(data.score)} on TestMyAgent`
  const badgeUrl = data.links?.badge ?? `${origin}/b/${data.slug}.svg`
  const badgeMd = `[![testmyagent](${badgeUrl})](${shareUrl})`
  const xUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(ogTitle)}&url=${encodeURIComponent(shareUrl)}`
  const liUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`
  const anyLabel = (l: string) => data.tasks.some((t) => t.labels?.includes(l))
  const { wallet } = useSession()
  // U27: the run owner (the account that ran it) answers "did the result match reality?" once per run.
  const isOwner = Boolean(wallet && data.evaluatorWallet && wallet === data.evaluatorWallet)

  return (
    <main className="pp-page" data-testid="public-profile">
      {/* Hero */}
      <section className="pp-hero" data-testid="profile-hero">
        <div className="pp-hero__main">
          <span className="tma-label">Evaluation profile · {fmtDate(data.issuedAt)}</span>
          <div className="pp-hero__id">
            <AgentAvatar id={data.agent.slug} name={data.agent.name} src={data.agent.avatarUrl} size={80} author={data.owner ? { name: data.agent.authorName, avatarUrl: data.owner.avatarUrl } : null} />
            <div className="pp-hero__names">
              <h1 className="pp-display">{data.agent.name}</h1>
              <span className="pp-byline">
                by <span className="pp-byline__owner" title={data.owner?.wallet}>{data.agent.authorName}</span> · <ModelLabel model={data.agent.modelId} label={data.agent.modelLabel} size={20} className="pp-byline__model" /> via OpenRouter
                {data.agent.commit && (
                  <>
                    {' '}
                    · <span className="pp-mono13" title={data.agent.commitFull ?? undefined}>{data.agent.commit}</span>
                  </>
                )}
              </span>
            </div>
          </div>
          {data.agent.description && <p className="pp-desc">{data.agent.description}</p>}
          {data.tags.length > 0 && (
            <div className="pp-tags">
              {data.tags.map((t) => (
                <TagPill key={t.id} large>
                  {t.name}
                </TagPill>
              ))}
            </div>
          )}
          <div className="pp-status-row">
            <div className="pp-status">
              <span className="tma-label">Task outcome</span>
              <div className="pp-status__badges" data-testid="outcome-counts">
                {data.counts.pass > 0 && <Badge tone="success">{data.counts.pass} PASS</Badge>}
                {data.counts.fail > 0 && <Badge tone="danger">{data.counts.fail} FAIL</Badge>}
                {data.counts.invalid > 0 && <Badge tone="neutral">{data.counts.invalid} INVALID</Badge>}
              </div>
            </div>
            <div className="pp-status">
              <span className="tma-label">Runtime</span>
              <div className="pp-status__badges">
                <StatusChip status="platform_run" dot />
              </div>
            </div>
            {data.selfEvaluated && (
              <div className="pp-status" title="The agent owner also wrote at least one task (same account or same GitHub account).">
                <span className="tma-label">Task author</span>
                <div className="pp-status__badges" data-testid="self-evaluated">
                  <Badge tone="neutral">Self-evaluated</Badge>
                </div>
              </div>
            )}
            {(anyLabel('sealed-tests') || anyLabel('open-tests')) && (
              <div className="pp-status">
                <span className="tma-label">Hidden tests</span>
                <div className="pp-status__badges" data-testid="tests-label">
                  {anyLabel('sealed-tests') && <Badge tone="neutral">Sealed</Badge>}
                  {anyLabel('open-tests') && <Badge tone="neutral">Open</Badge>}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="pp-hero__score">
          <div className="pp-score">
            <span className="tma-label">Score</span>
            <span className="pp-score__value" data-testid="profile-score">
              {fmtScore(data.score)}
            </span>
            <span className="pp-score__note">out of 100 · hidden checks, when every gate holds</span>
          </div>
          {data.scoreParts && (
            <div className="pp-parts" data-testid="score-parts">
              {PART_LABELS.map((p) => {
                const v = data.scoreParts![p.key]
                const max = data.scorePartsMax?.[p.key] ?? p.max
                return (
                  <div className="pp-part" key={p.key}>
                    <span className="pp-part__label">{p.label}</span>
                    <span className="pp-part__track">
                      <span className="pp-part__fill" style={{ width: `${Math.max(0, Math.min(1, v / max)) * 100}%` }} />
                    </span>
                    <span className="pp-part__value">
                      {fmtScore(v)} / {max}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          <div className="pp-score__foot">
            <div className="pp-segs">
              {data.tasks.map((t, i) => (
                <span key={i} className="pp-seg" style={{ background: t.outcome ? SEG_COLOR[t.outcome] : 'var(--tma-line-strong)' }} title={t.outcome ?? 'no result'} />
              ))}
            </div>
            <span className="pp-score__note">
              {data.counts.pass} of {n} task{n === 1 ? '' : 's'} passed · {data.testsPassed} of {data.testsTotal} hidden tests
            </span>
          </div>
        </div>
      </section>

      {/* Share bar */}
      <section className="pp-share" data-testid="share-bar">
        <div className="pp-share__field">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M6 8a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.6.6M8 6a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 6 11.5l.6-.6" />
          </svg>
          <span className="pp-share__url" data-testid="share-url">
            {shownUrl}
          </span>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            void copy(shareUrl)
            flash('link')
          }}
        >
          {copied === 'link' ? 'Copied' : 'Copy link'}
        </Button>
        <a className="tma-btn tma-btn--secondary" href={xUrl} target="_blank" rel="noreferrer" data-testid="share-x">
          Share on X
        </a>
        <a className="tma-btn tma-btn--secondary" href={liUrl} target="_blank" rel="noreferrer" data-testid="share-linkedin">
          Share on LinkedIn
        </a>
      </section>

      {/* Tasks */}
      <section className="pp-tasks">
        <div className="pp-tasks__head">
          <h2 className="pp-h2">Tasks</h2>
          <span className="pp-small-muted">Each cell is one hidden test.</span>
        </div>
        <div className="pp-tasks__grid">
          {data.tasks.map((t, i) => (
            <article className="pp-task" key={t.runId ?? i} data-testid="task-card">
              <div className="pp-task__head">
                <div className="pp-task__names">
                  <TaskName className="pp-task__name" name={t.name} slug={t.slug} />
                  {t.description && <span className="pp-small-muted">{t.description}</span>}
                </div>
                {t.outcome ? <Badge tone={t.outcome === 'PASS' ? 'success' : t.outcome === 'FAIL' ? 'danger' : 'neutral'}>{t.outcome}</Badge> : <Badge tone="warning">Review</Badge>}
              </div>
              <div className="pp-cells" aria-label={`${t.testsPassed} of ${t.testsTotal} hidden tests passed`}>
                {t.testResults.map((ok, j) => (
                  <span key={j} className={ok ? 'pp-cell pp-cell--pass' : 'pp-cell pp-cell--fail'} title={ok ? 'passed' : 'failed'} />
                ))}
              </div>
              <div className="pp-task__foot">
                <div className="pp-task__tags">
                  {t.tags.map((g) => (
                    <TagPill key={g.id}>{g.name}</TagPill>
                  ))}
                  {t.labels?.includes('sealed-tests') && <TagPill>Sealed tests</TagPill>}
                  {t.labels?.includes('open-tests') && <TagPill>Open tests</TagPill>}
                  {t.curatedByItera && <Badge tone="success" testId="curated-badge">Curated by Itera</Badge>}
                  {t.selfEvaluated && <Badge tone="warning" testId="task-self-evaluated">Self-evaluated</Badge>}
                  {t.ranked === false && <Badge tone="neutral" testId="task-unranked">Unranked</Badge>}
                </div>
                <span className="pp-mono12">
                  {t.testsPassed} / {t.testsTotal} tests · {mmss(t.durationMs)}
                  {t.score != null && <> · score {fmtScore(t.score)}</>}
                </span>
              </div>
              {isOwner && t.runId && t.outcome && <TaskFeedback runId={t.runId} initial={t.feedback ?? null} />}
            </article>
          ))}
        </div>
      </section>

      {/* Link preview · README badge */}
      <section className="pp-cards">
        <div className="tma-card pp-card">
          <div className="tma-card__header">
            <span className="tma-card__title">Link preview</span>
          </div>
          <div className="pp-card__body">
            {data.links?.og ? (
              <img className="pp-og-img" src={data.links.og} alt={`Link preview: ${ogTitle}`} width={1200} height={630} data-testid="og-image" />
            ) : (
              <div className="pp-og">
                <div className="pp-og__top">
                  <Logo width={39} height={18} />
                  <span className="pp-og__kicker">Graded</span>
                </div>
                <div className="pp-og__bottom">
                  <div className="pp-og__names">
                    <span className="pp-og__name">{data.agent.name}</span>
                    <span className="pp-og__sum">
                      {data.counts.pass} of {n} tasks PASS · {data.agent.modelLabel}
                    </span>
                  </div>
                  <span className="pp-og__score">{fmtScore(data.score)}</span>
                </div>
              </div>
            )}
            <span className="pp-small-muted">How the link unfurls on X, LinkedIn and Slack.</span>
          </div>
        </div>

        <div className="tma-card pp-card">
          <div className="tma-card__header">
            <span className="tma-card__title">README badge</span>
          </div>
          <div className="pp-card__body pp-card__body--grow">
            <div className="pp-badge-wrap">
              <div className="pp-badge">
                <span className="pp-badge__left">
                  <Logo variant="symbol" solid width={12} height={12} />
                  testmyagent
                </span>
                <span className="pp-badge__right">
                  {fmtScore(data.score)} · graded
                </span>
              </div>
            </div>
            <div className="pp-snippet" data-testid="badge-snippet">
              {badgeMd}
            </div>
            <Button
              variant="secondary"
              size={36}
              onClick={() => {
                void copy(badgeMd)
                flash('badge')
              }}
            >
              {copied === 'badge' ? 'Copied' : 'Copy Markdown'}
            </Button>
          </div>
        </div>
      </section>

      <span className="pp-disclaimer">{data.disclaimer}</span>
    </main>
  )
}

/** U27: one answer per run, by its owner. Feeds the task reputation. */
function TaskFeedback({ runId, initial }: { runId: string; initial: { matchedReality: boolean } | null }) {
  const [answer, setAnswer] = useState<{ matchedReality: boolean } | null>(initial)
  const [pick, setPick] = useState<boolean | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (answer) {
    return (
      <div className="pp-feedback pp-feedback--done" data-testid="feedback-done">
        <span className="pp-small-muted">Your feedback: {answer.matchedReality ? 'the result matched reality' : 'the result did not match reality'}.</span>
      </div>
    )
  }
  async function send() {
    if (pick === null) return
    setBusy(true)
    setErr('')
    try {
      const r = await api.runFeedback(runId, pick, note.trim() || undefined)
      setAnswer({ matchedReality: r.feedback.matchedReality })
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.body as { code?: string } | undefined)?.code === 'already_answered') setAnswer({ matchedReality: pick })
      else setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pp-feedback" data-testid="feedback-prompt">
      <span className="pp-feedback__q">Did this result match reality?</span>
      <div className="pp-feedback__row">
        <Button variant={pick === true ? 'primary' : 'secondary'} size={30} onClick={() => setPick(true)} disabled={busy}>
          Yes
        </Button>
        <Button variant={pick === false ? 'primary' : 'secondary'} size={30} onClick={() => setPick(false)} disabled={busy}>
          No
        </Button>
        <Input compact className="pp-feedback__note" placeholder="Note (optional)" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
        <Button variant="secondary" size={30} onClick={() => void send()} disabled={busy || pick === null}>
          {busy ? 'Sending…' : 'Send'}
        </Button>
      </div>
      <span className="pp-small-muted">One answer per run. It feeds the task reputation.</span>
      {err && <span className="pp-feedback__err">{err}</span>}
    </div>
  )
}

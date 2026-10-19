/**
 * Public task profile (`/tasks/:slug`, lane U30; plan 20261012-itera-testmyagent-ui-refactor, ADR-11,
 * designer addendum U32 part 3). Works logged out. Catalog tasks only; a private or unknown slug is
 * the generic not-found, except for the owner of a private task, who goes to the editor.
 * Data: GET /public/tasks/:slug (rules, tools, MCP schema snapshot, limits, scoring, version,
 * results), GET /tasks/:slug/reputation is folded into it, GET /tasks/:id/compatibility in the rail.
 * Link previews come from the web server (apps/web/server.mjs), which injects OG/Twitter meta for /tasks/*.
 * The page never shows a value that exists only per run: no endpoint, token, secret value or seed content.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom'
import { useSession } from '../auth/session'
import { api, ApiError } from '../lib/api'
import type { TaskHistoryResponse, TaskProfile } from '../lib/api/types'
import { Badge, Breadcrumb, Button, ButtonLink, Lockup, TagPill, middle } from '../tma/ui'
import { NotFoundPage } from './NotFoundPage'
import { RailCard, RunButton } from './task-profile/RailCard'
import { GoalSection, InjectSection, IoSection, LimitsSection, McpSection, ResultsSection, ScoringSection, TestsPill, ToolsSection, VersionSection } from './task-profile/sections'
import { SECTIONS, scrollToSection } from './task-profile/helpers'
import './task-profile/task-profile.css'
import { OwnedTaskDetailPage } from './OwnedTaskDetailPage'

type State = { kind: 'loading' } | { kind: 'ok'; task: TaskProfile } | { kind: 'owned'; data: TaskHistoryResponse } | { kind: 'notfound' } | { kind: 'mine'; id: string } | { kind: 'error'; message: string }

function TaskHeader() {
  const { status } = useSession()
  return (
    <header className="tma-nav tp-nav">
      <Lockup />
      <div className="tp-nav__right">
        <Link className="tp-nav__link" to="/#tasks">
          Tasks
        </Link>
        <ButtonLink href={status === 'signed-in' ? '/agents' : '/agents/new'} variant="primary" size={36}>
          {status === 'signed-in' ? 'Open app' : 'Evaluate your agent'}
        </ButtonLink>
      </div>
    </header>
  )
}

export function TaskProfilePage() {
  const { slug = '' } = useParams()
  const [search] = useSearchParams()
  const vParam = search.get('v')
  const version = vParam && /^[1-9][0-9]{0,5}$/.test(vParam) ? Number(vParam) : undefined
  const session = useSession()
  const [state, setState] = useState<State>({ kind: 'loading' })

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    if (session.status === 'signed-in') {
      try {
        const data = await api.taskEvaluations(slug)
        if (data.task.mine) {
          setState(data.task.status === 'ready' ? { kind: 'owned', data } : { kind: 'mine', id: data.task.id })
          return
        }
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) {
          setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
          return
        }
      }
    }
    try {
      setState({ kind: 'ok', task: await api.publicTask(slug, version) })
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setState({ kind: 'notfound' })
      else setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [slug, version, session.status])
  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (state.kind === 'ok') document.title = `${state.task.name} — task on TestMyAgent`
    if (state.kind === 'owned') document.title = `${state.data.task.name} — task details on TestMyAgent`
  }, [state])

  if (state.kind === 'mine') return <Navigate to={`/tasks/${encodeURIComponent(state.id)}/edit`} replace />
  if (state.kind === 'owned') return <OwnedTaskDetailPage data={state.data} />

  return (
    <div className="tma-app tp">
      <TaskHeader />
      {state.kind === 'loading' && (
        <main className="tp-page" data-testid="task-loading" aria-busy="true">
          <div className="tp-skeleton tp-skeleton--hero" />
          <div className="tp-skeleton tp-skeleton--card" />
          <div className="tp-skeleton tp-skeleton--card" />
        </main>
      )}
      {state.kind === 'notfound' && <NotFoundPage />}
      {state.kind === 'error' && (
        <main className="tp-page" data-testid="task-error">
          <div className="tp-error" role="alert">
            <span className="tp-error__title">Could not load this task.</span>
            <span className="tma-muted">{state.message}</span>
            <div>
              <Button variant="secondary" onClick={load}>
                Try again
              </Button>
            </div>
          </div>
        </main>
      )}
      {state.kind === 'ok' && <Profile task={state.task} />}
    </div>
  )
}

function Profile({ task }: { task: TaskProfile }) {
  const railRef = useRef<HTMLDivElement>(null)
  const [railVisible, setRailVisible] = useState(true)
  useEffect(() => {
    const el = railRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([entry]) => setRailVisible(entry!.isIntersecting), { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const toolsAllowed = task.tools.filter((t) => t.allowed).length
  const nMcp = task.mcp.servers.length
  const kicker = `TASK · CATALOG · v${task.version.number}`

  return (
    <main className="tp-page" data-testid="task-profile">
      {!task.version.isLatest && (
        <div className="tp-oldbanner" data-testid="old-version-banner">
          You are reading v{task.version.number}. The latest is v{task.version.latest}.{' '}
          <Link to={`/tasks/${task.slug}`}>Open v{task.version.latest}</Link>
        </div>
      )}
      <Breadcrumb items={[{ label: 'Catalog', to: '/#tasks' }, { label: task.slug }]} />

      <div className="tp-layout">
        <div className="tp-main">
          <section className="tp-hero" data-testid="task-hero">
            <span className="tma-label tp-kicker">{kicker}</span>
            <h1 className="tp-display" data-testid="task-title">
              {task.name}
            </h1>
            <p className="tp-desc">{task.description}</p>
            {task.tags.length > 0 && (
              <div className="tp-tags">
                {task.tags.map((t) => (
                  <TagPill key={t.id} large>
                    {t.name}
                  </TagPill>
                ))}
              </div>
            )}
            <div className="tp-status-row">
              <div className="tp-status">
                <span className="tma-label">Tests</span>
                <div className="tp-status__v">
                  <TestsPill task={task} />
                  {task.curatedByItera && <Badge tone="success">Curated by Itera</Badge>}
                </div>
              </div>
              <div className="tp-status">
                <span className="tma-label">Environment</span>
                <div className="tp-status__v tp-mono13" data-testid="env-summary">
                  {toolsAllowed} tool{toolsAllowed === 1 ? '' : 's'} · {nMcp} MCP server{nMcp === 1 ? '' : 's'}
                </div>
              </div>
              <div className="tp-status">
                <span className="tma-label">Version</span>
                <div className="tp-status__v tp-mono13" data-testid="version-summary">
                  v{task.version.number} {task.version.digest && <span title={task.version.digest}>{middle(task.version.digest, 4, 4)}</span>}
                </div>
              </div>
            </div>
          </section>

          <div className="tp-chips" role="navigation" aria-label="Sections">
            {SECTIONS.map((s) => (
              <button key={s.id} type="button" className="tma-chip" onClick={() => scrollToSection(s.id)}>
                {s.label}
              </button>
            ))}
          </div>

          {/* The rail card, in a single column, follows the hero. */}
          <div className="tp-rail-slot" ref={railRef}>
            <RailCard task={task} />
          </div>

          <GoalSection task={task} />
          <IoSection task={task} />
          <ToolsSection task={task} />
          <McpSection task={task} />
          <LimitsSection task={task} />
          <ScoringSection task={task} />
          <VersionSection task={task} />
          <ResultsSection task={task} />
          <InjectSection task={task} />
        </div>
      </div>

      {!railVisible && (
        <div className="tp-bottombar" data-testid="bottom-bar">
          <span className="tp-bottombar__price">US${task.price.usdPerRun.toFixed(2)} per run</span>
          <RunButton task={task} />
        </div>
      )}
    </main>
  )
}

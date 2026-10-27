/**
 * The review layout of a terminal evaluation (L14b; owner's design, TG 23999 + 24004): score header
 * (big score + 90% CI, verdict line, score bar, item navigator), the "Expected vs agent" card of the
 * current item (Fields | JSON, prev/next, the raw input at hand) and the Artifacts card.
 * The current item is `?item={seq}` in the URL; ← → move it. Data: the evaluation detail, the run
 * records (GET /runs/:id, owner view) and the public task profiles, all loaded by the page.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { Run, TaskProfile } from '../../lib/api'
import { JsonTree, PASS_LINE, ResultDot, ScoreBar, fmtScore, round1, wilson90 } from '../../tma/detail'
import { Segmented } from '../../tma/ui'
import { VERDICT_MARK, compareRows, inputPreview, mostLost, navItemsOf, patchStats, sourceOf, verdictOf } from './review'
import type { CompareRow, NavItem, ReviewDetail, ReviewTask } from './review'
import './review.css'

export interface EvaluationReviewProps {
  detail: ReviewDetail
  runs: Record<string, Run>
  /** By task slug. `null` = the task is private or unknown (404): the rows that need it are omitted. */
  profiles: Record<string, TaskProfile | null>
  /** L18: by run id, a run record that did not load (an HTTP error, a network error or the time limit). */
  runErrors?: Record<string, RunLoadError>
  /** L18: read the run record again. */
  onRetryRun?: (runId: string) => void
}

/** A run record that did not load. `status` 0 = no HTTP answer (network error or the time limit). */
export interface RunLoadError {
  status: number
  message: string
  timedOut?: boolean
}

/** L18: the text of a run record that did not load. A missing record is never shown as "loading". */
export function runErrorText(e: RunLoadError): string {
  if (e.timedOut) return `The run record did not answer in time. ${e.message}`
  if (e.status === 404) return 'The run record was not found (404). It was deleted, or this account cannot read it.'
  if (e.status === 0) return `The run record did not load: ${e.message}`
  return `The run record did not load (HTTP ${e.status}): ${e.message}`
}

/** L18: the error state of a section whose run record did not load, with a retry. */
export function RunLoadErrorNote({ error, testId, onRetry }: { error: RunLoadError; testId: string; onRetry?: () => void }) {
  return (
    <div className="ev-empty" role="alert" data-testid={testId} data-status={error.status}>
      <strong>Run record not available</strong>
      <span className="ev-dim">{runErrorText(error)}</span>
      {onRetry && (
        <button type="button" className="ev-text-btn" onClick={onRetry} data-testid={`${testId}-retry`}>
          Try again
        </button>
      )}
    </div>
  )
}

/** `?item={seq}` → the current nav item; an unknown value gives the first. */
export function useItemParam(items: NavItem[]): [NavItem | null, (seq: number) => void] {
  const [search, setSearch] = useSearchParams()
  const raw = Number(search.get('item'))
  const current = items.find((it) => it.seq === raw) ?? items[0] ?? null
  const set = (seq: number) =>
    setSearch(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('item', String(seq))
        return next
      },
      { replace: true },
    )
  return [current, set]
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable === true
}

export function EvaluationReview({ detail: d, runs, profiles, runErrors = {}, onRetryRun }: EvaluationReviewProps) {
  const items = useMemo(() => navItemsOf(d.tasks), [d.tasks])
  const [current, setItem] = useItemParam(items)
  const index = current ? items.findIndex((it) => it.seq === current.seq) : -1
  const prev = index > 0 ? items[index - 1]! : null
  const next = index >= 0 && index < items.length - 1 ? items[index + 1]! : null

  // ← → move the current item (not while the reader types in a field).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.altKey || ev.ctrlKey || ev.metaKey || isTyping(ev.target)) return
      if (ev.key === 'ArrowLeft' && prev) {
        ev.preventDefault()
        setItem(prev.seq)
      } else if (ev.key === 'ArrowRight' && next) {
        ev.preventDefault()
        setItem(next.seq)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const task: ReviewTask | undefined = current ? d.tasks.find((t) => t.runId === current.runId) : undefined
  const run = task ? runs[task.runId] : undefined
  const runError = task && !run ? runErrors[task.runId] : undefined
  const onRetry = task && onRetryRun ? () => onRetryRun(task.runId) : undefined
  const profile = task ? profiles[task.slug] : undefined
  const [showAllPublic, setShowAllPublic] = useState(false)
  const { rows, publicCollapsed } = useMemo(() => compareRows({ run, taskScore: task?.score, durationMs: task?.durationMs ?? run?.durationMs, profile, showAllPublic }), [run, task, profile, showAllPublic])
  const [view, setView] = useState<'fields' | 'json'>('fields')
  const source = sourceOf(d)

  return (
    <section className="ev" data-testid="evaluation-review" data-source={source}>
      <ScoreHeader detail={d} rows={rows} items={items} current={current} onSelect={setItem} />
      <CompareCard task={task} run={run} runError={runError} onRetry={onRetry} profile={profile} rows={rows} publicCollapsed={publicCollapsed} onShowAll={() => setShowAllPublic(true)} prev={prev} next={next} onSelect={setItem} view={view} onView={setView} />
      <ArtifactsCard eid={d.id} task={task} run={run} runError={runError} onRetry={onRetry} source={source} onGraderReport={() => setView('json')} />
    </section>
  )
}

function ScoreHeader({ detail: d, rows, items, current, onSelect }: { detail: ReviewDetail; rows: CompareRow[]; items: NavItem[]; current: NavItem | null; onSelect: (seq: number) => void }) {
  const n = d.testsTotal ?? 0
  const ci = wilson90(d.testsPassed ?? 0, n)
  const verdict = verdictOf(d.counts)
  const below = verdict === 'fail' && d.score != null ? round1(PASS_LINE - d.score) : null
  const lost = mostLost(rows)
  const passed = d.counts?.pass ?? 0
  return (
    <div className="ev-head tma-card" data-testid="score-header">
      <div className="ev-head__score">
        <span className="ev-score" data-testid="review-score">
          {fmtScore(d.score)}
        </span>
        <span className="ev-mono ev-dim" data-testid="review-ci">
          {ci ? `90% CI ${fmtScore(ci.lo)}–${fmtScore(ci.hi)} · n ${n}` : `n ${n} · no CI`}
        </span>
      </div>
      <div className="ev-head__verdict">
        <span className="ev-verdict" data-testid="review-verdict" data-verdict={verdict ?? ''}>
          <ResultDot outcome={verdict} testId="review-verdict-dot" />
          {below != null && below > 0 && <span> · {fmtScore(below)} below {PASS_LINE}.</span>}
          {lost && (
            <span>
              {' '}
              Most points lost on <code className="ev-mono" data-testid="review-most-lost">{lost.field}</code>.
            </span>
          )}
        </span>
        <ScoreBar score={d.score} ci={ci} testId="review-score-bar" />
      </div>
      <div className="ev-head__items">
        <span className="ev-mono ev-dim" data-testid="review-items-label">
          items · {passed} passed
        </span>
        <ItemNavigator items={items} current={current} onSelect={onSelect} />
      </div>
    </div>
  )
}

/** One small square per task run; the current one outlined. */
function ItemNavigator({ items, current, onSelect }: { items: NavItem[]; current: NavItem | null; onSelect: (seq: number) => void }) {
  return (
    <div className="ev-nav" role="listbox" aria-label="Items" data-testid="item-nav">
      {items.map((it) => {
        const isCurrent = current?.seq === it.seq
        return (
          <button
            key={it.runId}
            type="button"
            role="option"
            aria-selected={isCurrent}
            aria-label={`${it.name} · ${it.score != null ? it.score : '—'}`}
            title={`${it.name} · ${it.score != null ? `${it.score}/100` : 'not graded'}`}
            className={`ev-nav__sq ev-nav__sq--${it.tone}${isCurrent ? ' ev-nav__sq--current' : ''}`}
            data-testid="item-square"
            data-seq={it.seq}
            data-tone={it.tone}
            data-current={isCurrent ? 'true' : 'false'}
            onClick={() => onSelect(it.seq)}
          />
        )
      })}
    </div>
  )
}

function CompareCard({ task, run, runError, onRetry, profile, rows, publicCollapsed, onShowAll, prev, next, onSelect, view, onView }: { task: ReviewTask | undefined; run: Run | undefined; runError: RunLoadError | undefined; onRetry: (() => void) | undefined; profile: TaskProfile | null | undefined; rows: CompareRow[]; publicCollapsed: number; onShowAll: () => void; prev: NavItem | null; next: NavItem | null; onSelect: (seq: number) => void; view: 'fields' | 'json'; onView: (v: 'fields' | 'json') => void }) {
  const score = task?.score ?? run?.scoreTotal ?? null
  const input = inputPreview(profile?.input?.instruction?.text)
  return (
    <div className="ev-card tma-card" data-testid="compare-card" data-run-id={task?.runId ?? ''}>
      <div className="ev-card__head">
        <div className="ev-card__title">
          <strong>Expected vs agent</strong>
          {task && (
            <span className="ev-mono ev-dim" data-testid="compare-item">
              item {task.name} · {score != null ? fmtScore(score) : '—'}/100
            </span>
          )}
        </div>
        <div className="ev-card__tools">
          <Segmented items={[{ id: 'fields', label: 'Fields' }, { id: 'json', label: 'JSON' }]} value={view} onChange={onView} />
          <div className="ev-pager">
            <button type="button" className="ev-pager__btn" disabled={!prev} onClick={() => prev && onSelect(prev.seq)} data-testid="item-prev" aria-label={prev ? `Previous item: ${prev.name}` : 'No previous item'}>
              ‹ <span className="ev-mono">{prev?.slug ?? '—'}</span>
            </button>
            <button type="button" className="ev-pager__btn" disabled={!next} onClick={() => next && onSelect(next.seq)} data-testid="item-next" aria-label={next ? `Next item: ${next.name}` : 'No next item'}>
              <span className="ev-mono">{next?.slug ?? '—'}</span> ›
            </button>
          </div>
        </div>
      </div>
      {input && task && (
        <div className="ev-input" data-testid="review-input" data-truncated={input.truncated ? 'true' : 'false'}>
          <span className="tma-label">Input</span>
          <span className="ev-input__text">{input.text}</span>
          {input.truncated && (
            <Link to={`/tasks/${encodeURIComponent(task.slug)}?tab=input`} className="ev-text-btn" data-testid="review-input-link">
              Open the full input
            </Link>
          )}
        </div>
      )}
      <div className="ev-card__body">
        {!task ? (
          <p className="ev-dim">No task run in this evaluation.</p>
        ) : !run && runError ? (
          <RunLoadErrorNote error={runError} testId="compare-error" onRetry={onRetry} />
        ) : !run ? (
          <p className="ev-dim" aria-busy="true" data-testid="compare-loading">
            Loading the run record…
          </p>
        ) : view === 'json' ? (
          <JsonTree value={run} testId="compare-json" />
        ) : (
          <>
            <div className="ev-table-wrap">
              <table className="ev-table" data-testid="compare-table">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Expected</th>
                    <th>Agent</th>
                    <th className="ev-table__verdict-h">
                      <span className="ev-sr">Verdict</span>
                    </th>
                    <th className="ev-table__pts">Points</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.field} data-testid="compare-row" data-field={r.field} data-verdict={r.verdict}>
                      <td className="ev-table__f">{r.field}</td>
                      <td className="ev-table__v">{r.expected}</td>
                      <td className={`ev-table__v${r.verdict === 'missing' ? ' ev-dim' : ''}`}>{r.verdict === 'missing' && r.agent === 'not graded' ? 'not returned' : r.agent}</td>
                      <td className={`ev-table__verdict ev-verdict--${r.verdict}`}>
                        <span className="ev-verdict__mark" aria-hidden="true">
                          {VERDICT_MARK[r.verdict]}
                        </span>{' '}
                        {r.verdict}
                      </td>
                      <td className="ev-table__pts">{r.points}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={5} className="ev-dim">
                        This run stored no graded result.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {publicCollapsed > 0 && (
              <button type="button" className="ev-text-btn" onClick={onShowAll} data-testid="public-show-all">
                Show all {publicCollapsed} public tests
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function ArtifactsCard({ eid, task, run, runError, onRetry, source, onGraderReport }: { eid: string; task: ReviewTask | undefined; run: Run | undefined; runError: RunLoadError | undefined; onRetry: (() => void) | undefined; source: 'self-declared' | 'imported' | 'run here'; onGraderReport: () => void }) {
  const changed = run?.patchScope?.changedFiles ?? []
  const stats = patchStats(run?.patch, changed)
  const hasFiles = source === 'run here' && Boolean(run?.patch || changed.length)
  const tests = run?.tests ? (run.tests.public?.total ?? 0) + (run.tests.hidden?.total ?? 0) : null
  const runOrigin = (run as { resultOrigin?: string } | undefined)?.resultOrigin
  const selfDeclared = source === 'self-declared' || runOrigin === 'self_declared'
  return (
    <div className="ev-card tma-card" data-testid="artifacts-card" data-state={hasFiles ? 'files' : 'empty'}>
      <div className="ev-card__head">
        <div className="ev-card__title">
          <strong>Artifacts</strong>
          {task && <span className="ev-mono ev-dim">{task.slug}</span>}
        </div>
        {run && (
          <button type="button" className="ev-text-btn" onClick={onGraderReport} data-testid="grader-report">
            Grader report
          </button>
        )}
      </div>
      <div className="ev-card__body">
        {!task ? null : !run && runError ? (
          <RunLoadErrorNote error={runError} testId="artifacts-error" onRetry={onRetry} />
        ) : !run ? (
          <p className="ev-dim" aria-busy="true" data-testid="artifacts-loading">
            Loading the run record…
          </p>
        ) : hasFiles ? (
          <div className="ev-files" data-testid="artifacts-files">
            <span className="ev-mono" data-testid="artifacts-patch">
              patch.diff · {stats.files} file{stats.files === 1 ? '' : 's'} · +{stats.added} −{stats.removed}
            </span>
            <span className="ev-mono ev-dim" data-testid="artifacts-counts">
              {tests != null && `tests ${tests} · `}tool calls {run.actionsCount ?? 0}
            </span>
            <Link to={`/evaluations/${encodeURIComponent(eid)}/runs/${encodeURIComponent(task.runId)}`} className="ev-text-btn" data-testid="open-artifacts">
              Open artifacts →
            </Link>
          </div>
        ) : (
          <div className="ev-empty" data-testid="artifacts-empty">
            <strong>No files stored</strong>
            <span className="ev-dim">{selfDeclared ? 'Self-declared run: TestMyAgent stores numbers only.' : source === 'imported' ? 'Imported legacy run. Only the score and the grader result were kept.' : 'This run stored no artifact.'}</span>
          </div>
        )}
      </div>
    </div>
  )
}

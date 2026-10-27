/**
 * Run artifacts page (`/evaluations/:eid/runs/:runId`, plan TMA L14c). A human LOOKS at the real thing:
 * every output is rendered by its type (JSON tree, sandboxed HTML preview, markdown, image, diff, text)
 * and the raw input is at hand (inline when short, a link when long).
 *
 * Data (no API change, no invented value):
 *   GET /runs/:runId             the run record, the patch (owner only), the tests, the score rule.
 *   GET /runs/:runId/actions     the tool calls, pages of 200; 10 pages, then "Load more".
 *   GET /evaluations/:eid        owner only: the breadcrumb, the title, the task name and the duration.
 *                                404/403 → the run still renders, with a generic title.
 *   GET /public/tasks/:slug      the raw input (instruction, repository). 404 → only the link.
 *   GET /runs/:runId/artifacts   L17: the STORED outputs of a hosted run (owner only). 404 (not the owner,
 *                                legacy run, old API) or any error → the derived list alone, as in L14c.
 * Tabs: Summary · Artifacts (n) · Tests (n) · Log (n) · Patch, `?tab=` in the URL. The artifact list is
 * derived in ./run-artifacts/artifacts.ts (the run record, the patch, the files the patch adds), then
 * merged with the stored outputs (`mergeStoredArtifacts`): the stored entries come first, and a stored
 * file replaces the one rebuilt from the patch.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import type { EvaluationDetail, Run, RunAction, RunArtifactsResponse, TaskProfile } from '../lib/api/types'
import { DetailTabs, FieldTable, PASS_LINE, ResultDot, ScoreBar, fmtScore, useTabParam, wilson90, type FieldRow } from '../tma/detail'
import { AgentAvatar, Badge, Breadcrumb, Button, ModelLabel, middle } from '../tma/ui'
import { appendPage, EMPTY_FEED, type ActionFeed } from './running-evaluation/call-events'
import { artifactsOf, defaultTab, formatBytes, mergeStoredArtifacts, mmss, shortRunId, splitArtifacts, type Artifact } from './run-artifacts/artifacts'
import { ArtifactCard, DiffView } from './run-artifacts/renderers'
import './run-artifacts/run-artifacts.css'

export const TAB_IDS = ['summary', 'artifacts', 'tests', 'log', 'patch'] as const
export type TabId = (typeof TAB_IDS)[number]

/** Pages of 200 tool calls read on load; after that a "Load more" button reads the next page. */
const MAX_PAGES = 10
/** The instruction shows inline up to this length; longer, the first 3 lines and a link. */
const INLINE_INPUT_CHARS = 600

type EvalState = { kind: 'loading' } | { kind: 'ok'; detail: EvaluationDetail } | { kind: 'denied'; status: number }
type TaskState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ok'; task: TaskProfile } | { kind: 'notfound' }
type Feed = ActionFeed & { pages: number; hasMore: boolean }

const EMPTY: Feed = { ...EMPTY_FEED, pages: 0, hasMore: false }

function hhmmss(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toISOString().slice(11, 19)
}

/** A client-side download link: the text as a data: URL with a `download` name. Never opened in a tab. */
function dataHref(text: string, mime: string): string {
  return `data:${mime};charset=utf-8,${encodeURIComponent(text)}`
}

export function RunArtifactsPage() {
  const { eid = '', runId = '' } = useParams()
  const [run, setRun] = useState<Run | null>(null)
  const [runError, setRunError] = useState<{ status: number; message: string } | null>(null)
  const [ev, setEv] = useState<EvalState>({ kind: 'loading' })
  const [taskState, setTaskState] = useState<TaskState>({ kind: 'idle' })
  const [feed, setFeed] = useState<Feed>(EMPTY)
  const [feedBusy, setFeedBusy] = useState(false)
  /** L17: `undefined` = not answered yet; `null` = no stored list (404, 401, network, old API). */
  const [stored, setStored] = useState<RunArtifactsResponse | null | undefined>(undefined)

  useEffect(() => {
    let live = true
    setRun(null)
    setRunError(null)
    api
      .run(runId)
      .then((r) => live && setRun(r))
      .catch((e) => live && setRunError({ status: e instanceof ApiError ? e.status : 0, message: e instanceof Error ? e.message : String(e) }))
    return () => {
      live = false
    }
  }, [runId])

  useEffect(() => {
    let live = true
    setStored(undefined)
    api
      .runArtifacts(runId)
      .then((r) => live && setStored(r && Array.isArray(r.artifacts) ? r : null))
      .catch(() => live && setStored(null))
    return () => {
      live = false
    }
  }, [runId])

  useEffect(() => {
    let live = true
    setEv({ kind: 'loading' })
    api
      .evaluation(eid)
      .then((d) => live && setEv({ kind: 'ok', detail: d }))
      .catch((e) => live && setEv({ kind: 'denied', status: e instanceof ApiError ? e.status : 0 }))
    return () => {
      live = false
    }
  }, [eid])

  const evTask = ev.kind === 'ok' ? (ev.detail.tasks.find((t) => t.runId === runId) ?? null) : null
  const slug = evTask?.slug ?? null
  useEffect(() => {
    if (!slug) return
    let live = true
    setTaskState({ kind: 'loading' })
    api
      .publicTask(slug)
      .then((t) => live && setTaskState({ kind: 'ok', task: t }))
      .catch(() => live && setTaskState({ kind: 'notfound' }))
    return () => {
      live = false
    }
  }, [slug])

  // Tool calls: follow nextAfterSeq while hasMore, at most MAX_PAGES on load; then "Load more", one page per click.
  const pull = useCallback(
    async (start: Feed, maxPages: number) => {
      setFeedBusy(true)
      let f = start
      try {
        for (let i = 0; i < maxPages; i++) {
          const page = await api.runActions(runId, f.after)
          f = { ...appendPage(f, page, true), pages: f.pages + 1, hasMore: page.hasMore }
          if (!page.hasMore) break
        }
      } catch {
        // The log is decoration: a failed page leaves the lines as they were.
      } finally {
        setFeed(f)
        setFeedBusy(false)
      }
    },
    [runId],
  )
  useEffect(() => {
    setFeed(EMPTY)
    void pull(EMPTY, MAX_PAGES)
  }, [pull])

  const artifacts = useMemo<Artifact[]>(() => (run ? mergeStoredArtifacts(artifactsOf(run), stored ?? null) : []), [run, stored])
  const [tab, setTab] = useTabParam(TAB_IDS, defaultTab(artifacts))

  const crumbs = [{ label: 'Evaluations', to: '/evaluations' }, { label: ev.kind === 'ok' ? ev.detail.shortId : eid.slice(0, 8), to: `/evaluations/${encodeURIComponent(eid)}` }, { label: 'Artifacts' }]

  if (runError && !run) {
    return (
      <main className="tma-page tma-page--flow ra-page" data-testid="run-artifacts-page">
        <Breadcrumb items={crumbs} />
        <h1 className="tma-h1">Run</h1>
        <div className="tma-card tma-card--pad ra-empty" role="alert" data-testid="run-error">
          {runError.status === 404 ? 'Run not found. The link is wrong, or the run was removed.' : `Could not load the run: ${runError.message}`}
          <Link to={`/evaluations/${encodeURIComponent(eid)}`}>Back to the evaluation</Link>
        </div>
      </main>
    )
  }
  // The stored list decides the Artifacts count and the default tab: the page waits for both answers.
  if (!run || stored === undefined) {
    return (
      <main className="tma-page tma-page--flow ra-page" data-testid="run-artifacts-page" aria-busy="true">
        <Breadcrumb items={crumbs} />
        <h1 className="tma-h1">Run</h1>
        <div className="tma-card ra-skeleton" />
      </main>
    )
  }

  const owner = ev.kind === 'ok' || run.patch != null
  const selfDeclared = run.resultOrigin === 'self_declared' || (ev.kind === 'ok' && ev.detail.resultOrigin === 'self_declared')
  const hidden = run.tests?.hidden ?? null
  const pub = run.tests?.public ?? null
  const cases = pub?.cases ?? []
  const testsCount = (cases.length || pub?.total || 0) + (hidden?.total ?? 0)
  const actionsCount = run.actionsCount ?? feed.rows.length
  const score = evTask?.score ?? run.scoreTotal
  const ci = hidden ? wilson90(hidden.passed, hidden.total) : null
  const durationMs = evTask?.durationMs ?? run.durationMs ?? (run.completedAt && run.createdAt ? Date.parse(String(run.completedAt)) - Date.parse(String(run.createdAt)) : null)
  const outcome = run.result?.verdict ?? evTask?.outcome ?? run.status
  const agent = ev.kind === 'ok' ? ev.detail.agent : null
  const title = agent?.name ?? `Run ${shortRunId(runId)}`
  const modelId = ev.kind === 'ok' ? (typeof ev.detail.model === 'string' ? ev.detail.model : ev.detail.model.id) : null
  const taskName = evTask?.name ?? (taskState.kind === 'ok' ? taskState.task.name : run.benchmark?.id ? String(run.benchmark.id) : 'task')
  const subtitle = [taskName, fmtScore(score), hidden ? `hidden tests ${hidden.passed}/${hidden.total}` : null, mmss(durationMs)].filter(Boolean).join(' · ')
  const short = shortRunId(runId)
  const t0 = run.createdAt ? Date.parse(String(run.createdAt)) : NaN
  const { wide, narrow, rest } = splitArtifacts(artifacts)
  const fromPatch = artifacts.filter((a) => a.id !== 'run.json')
  const storedCount = artifacts.filter((a) => a.source === 'stored').length
  const noneStored = stored?.reason === 'none_stored' && storedCount === 0
  const emptyReason = selfDeclared || stored?.reason === 'self_declared' ? 'A self-declared run stores numbers only. TestMyAgent did not run it.' : !owner ? 'The patch is visible to the run owner only.' : 'No patch was stored for this run.'

  return (
    <main className="tma-page tma-page--flow ra-page" data-testid="run-artifacts-page" data-run-id={runId} data-owner={String(owner)}>
      <div className="ra-head">
        <Breadcrumb items={crumbs} />
        <div className="ra-head__row">
          <div className="ra-head__titles">
            <div className="ra-head__title">
              <AgentAvatar size={44} id={agent?.id ?? runId} name={title} src={agent?.avatarUrl ?? null} author={agent?.authorProfile ? { name: agent.authorProfile.displayName ?? agent.authorProfile.username ?? '', avatarUrl: agent.authorProfile.avatarUrl ?? null } : null} />
              <div className="ra-head__copy">
                <h1 className="tma-h1" data-testid="run-title">
                  {title}
                  {selfDeclared && (
                    <Badge tone="neutral" testId="self-declared-chip">
                      self-declared
                    </Badge>
                  )}
                </h1>
                <span className="dt-mono ra-head__sub" data-testid="run-subtitle">
                  <ResultDot outcome={outcome} /> · {subtitle}
                </span>
                {modelId && <ModelLabel model={modelId} size={16} className="ra-head__model" />}
              </div>
            </div>
          </div>
          <div className="ra-head__right">
            <details className="ra-download" data-testid="download-menu">
              <summary className="tma-btn tma-btn--primary">Download</summary>
              <div className="ra-download__menu">
                <a href={dataHref(artifacts[0]?.text ?? '', 'application/json')} download={`run-${short}.json`} data-testid="download-json">
                  run-{short}.json
                </a>
                {run.patch != null && (
                  <a href={dataHref(run.patch, 'text/x-diff')} download={`run-${short}.diff`} data-testid="download-diff">
                    run-{short}.diff
                  </a>
                )}
              </div>
            </details>
          </div>
        </div>
      </div>

      <DetailTabs
        items={[
          { id: 'summary', label: 'Summary' },
          { id: 'artifacts', label: 'Artifacts', count: artifacts.length },
          { id: 'tests', label: 'Tests', count: testsCount },
          { id: 'log', label: 'Log', count: actionsCount },
          { id: 'patch', label: 'Patch' },
        ]}
        value={tab}
        onChange={setTab}
        testId="run-tabs"
      />

      {tab === 'summary' && <SummaryTab run={run} score={score} ci={ci} durationMs={durationMs} selfDeclared={selfDeclared} owner={owner} taskState={taskState} slug={slug} />}

      {tab === 'artifacts' && (
        <div className="ra-tab" data-testid="tab-artifacts" data-stored-count={storedCount}>
          {noneStored && (
            <div className="ra-note-box" data-testid="artifacts-none-stored">
              No output files stored for this run. Runs before 2026-10-27 have only the patch.
            </div>
          )}
          {fromPatch.length === 0 && (
            <div className="ra-empty" data-testid="artifacts-empty">
              <strong>No files stored</strong>
              <span className="tma-muted">{emptyReason}</span>
            </div>
          )}
          {fromPatch.length > 0 ? (
            <div className="ra-split">
              {wide && <ArtifactCard artifact={wide} className="ra-split__wide" testId="artifact-wide" />}
              {narrow && <ArtifactCard artifact={narrow} className={wide ? 'ra-split__narrow' : 'ra-split__wide'} testId="artifact-narrow" />}
            </div>
          ) : (
            narrow && <ArtifactCard artifact={narrow} testId="artifact-narrow" />
          )}
          {rest.length > 0 && (
            <div className="ra-list" data-testid="artifact-list">
              {rest.map((a) => (
                <ArtifactCard key={a.id} artifact={a} collapsible defaultOpen={false} />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'tests' && (
        <div className="ra-tab" data-testid="tab-tests">
          {!run.tests ? (
            <div className="ra-empty" data-testid="tests-empty">
              <strong>No test result stored</strong>
              <span className="tma-muted">{selfDeclared ? 'A self-declared run stores numbers only.' : 'The run has no evidence log.'}</span>
            </div>
          ) : (
            <>
              <section className="tma-card dt-card" data-testid="tests-public">
                <div className="dt-card__head">
                  <div className="dt-card__title">
                    <strong>Public tests</strong>
                    <span className="dt-card__sub">
                      {pub ? `after patch ${pub.passed}/${pub.total}` : '—'}
                      {run.tests.publicBaseline ? ` · baseline ${run.tests.publicBaseline.passed}/${run.tests.publicBaseline.total}` : ''}
                    </span>
                  </div>
                </div>
                <div className="dt-card__body">
                  {cases.length > 0 ? (
                    <table className="ra-cases" data-testid="public-cases">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>File</th>
                          <th>Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cases.map((c, i) => (
                          <tr key={i} data-testid="public-case" data-passed={String(c.passed)}>
                            <td>{c.name}</td>
                            <td className="dt-mono dt-dim">{c.file}</td>
                            <td>
                              <ResultDot outcome={c.passed ? 'pass' : 'fail'} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <span className="tma-muted">The run stores the counts only.</span>
                  )}
                </div>
              </section>
              <section className="tma-card dt-card" data-testid="tests-hidden">
                <div className="dt-card__head">
                  <div className="dt-card__title">
                    <strong>Hidden tests</strong>
                    <span className="dt-card__sub" data-testid="hidden-count">
                      {hidden ? `${hidden.passed}/${hidden.total}` : '—'}
                    </span>
                  </div>
                  <span className="dt-mono dt-dim">the names are secret</span>
                </div>
                <div className="dt-card__body">
                  {hidden && hidden.total > 0 ? (
                    <div className="ra-squares" data-testid="hidden-squares" role="img" aria-label={`${hidden.passed} of ${hidden.total} hidden checks passed`}>
                      {Array.from({ length: hidden.total }, (_, i) => (
                        <span key={i} className={`ra-square ra-square--${i < hidden.passed ? 'pass' : 'fail'}`} data-testid="hidden-square" data-passed={String(i < hidden.passed)} />
                      ))}
                    </div>
                  ) : (
                    <span className="tma-muted">No hidden check was measured.</span>
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      )}

      {tab === 'log' && (
        <div className="ra-tab" data-testid="tab-log">
          {owner && (run.errors?.length ?? 0) > 0 && (
            <div className="ra-errors" role="alert" data-testid="log-errors">
              {run.errors!.map((e, i) => (
                <pre key={i} className="ra-errors__line">
                  {e}
                </pre>
              ))}
            </div>
          )}
          <section className="tma-card dt-card" data-testid="log-card">
            <div className="dt-card__head">
              <div className="dt-card__title">
                <strong>Tool calls</strong>
                <span className="dt-card__sub">
                  {feed.rows.length} of {actionsCount}
                  {Number.isFinite(t0) ? ' · time since the run started' : ' · UTC'}
                </span>
              </div>
            </div>
            <div className="dt-card__body">
              {feed.rows.length === 0 && !feedBusy && <span className="tma-muted">No tool call stored.</span>}
              {feed.rows.length > 0 && (
                <div className="ra-log" data-testid="log-lines">
                  {feed.rows.map((a) => (
                    <LogLine key={a.seq} a={a} t0={t0} />
                  ))}
                </div>
              )}
              {feedBusy && (
                <span className="tma-muted" data-testid="log-loading">
                  Loading…
                </span>
              )}
              {feed.hasMore && !feedBusy && (
                <div>
                  <Button variant="secondary" size={32} onClick={() => void pull(feed, 1)} data-testid="log-load-more">
                    Load more
                  </Button>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {tab === 'patch' && (
        <div className="ra-tab" data-testid="tab-patch">
          {run.patchScope && (
            <section className="tma-card dt-card" data-testid="patch-scope">
              <div className="dt-card__head">
                <div className="dt-card__title">
                  <strong>Patch scope</strong>
                  <span className="dt-card__sub">{run.patchScope.allowed ? 'allowed' : 'outside the allowed paths'}</span>
                </div>
                <Badge tone={run.patchScope.allowed ? 'success' : 'danger'}>{run.patchScope.allowed ? 'allowed' : 'not allowed'}</Badge>
              </div>
              <div className="dt-card__body">
                {run.patchScope.changedFiles.length > 0 ? (
                  <ul className="ra-files dt-mono" data-testid="changed-files">
                    {run.patchScope.changedFiles.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="tma-muted">{owner ? 'No changed file listed.' : 'The changed files are visible to the run owner only.'}</span>
                )}
              </div>
            </section>
          )}
          {run.patch != null ? (
            <section className="tma-card dt-card" data-testid="patch-card">
              <div className="dt-card__head">
                <div className="dt-card__title">
                  <strong>Patch</strong>
                  <span className="dt-card__sub">patch.diff · {formatBytes(artifacts.find((a) => a.id === 'patch.diff')?.bytes ?? 0)}</span>
                </div>
                <a className="ra-text-btn" href={dataHref(run.patch, 'text/x-diff')} download={`run-${short}.diff`}>
                  Download
                </a>
              </div>
              <div className="dt-card__body">
                <DiffView diff={run.patch} testId="patch-diff" />
              </div>
            </section>
          ) : (
            <div className="ra-empty" data-testid="patch-owner-only">
              <strong>{owner ? 'No patch stored' : 'The patch is visible to the run owner only.'}</strong>
              {owner && <span className="tma-muted">{selfDeclared ? 'A self-declared run stores numbers only.' : 'The run produced no patch.'}</span>}
            </div>
          )}
        </div>
      )}
    </main>
  )
}

function LogLine({ a, t0 }: { a: RunAction; t0: number }) {
  const at = Date.parse(a.occurredAt)
  const time = Number.isFinite(t0) && Number.isFinite(at) ? mmss(Math.max(0, at - t0)) : hhmmss(a.occurredAt)
  return (
    <div className={`ra-log__line dt-mono${a.ok === false ? ' ra-log__line--bad' : ''}`} data-testid="log-line" data-seq={a.seq} data-ok={String(a.ok)}>
      <span className="ra-log__seq">#{a.seq}</span>
      <span className="ra-log__time">{time}</span>
      <span className="ra-log__tool">{a.tool}</span>
      <span className="ra-log__target">{a.target ?? ''}</span>
      {a.ok === false && (
        <span className="ra-log__mark" aria-label="failed" title="failed">
          ✕
        </span>
      )}
    </div>
  )
}

function gateWord(v: boolean | null): string {
  return v === true ? 'holds' : v === false ? 'failed' : 'not measured'
}

function SummaryTab({ run, score, ci, durationMs, selfDeclared, owner, taskState, slug }: { run: Run; score: number | null; ci: ReturnType<typeof wilson90>; durationMs: number | null; selfDeclared: boolean; owner: boolean; taskState: TaskState; slug: string | null }) {
  const hidden = run.tests?.hidden ?? null
  const rule = run.score?.rule ?? null
  const parts = run.score?.parts ?? null
  const gates = rule?.gates ?? null
  const facts: FieldRow[] = [
    { field: 'result', type: 'state', value: `${run.result?.state ?? run.status}${run.result?.verdict ? ` · ${run.result.verdict}` : ''}${run.result?.scored === false ? ' · not scored' : ''}` },
    { field: 'duration', type: 'mm:ss', value: mmss(durationMs) },
    { field: 'model cost', type: 'USD', value: run.modelCostUsd != null ? `$${run.modelCostUsd.toFixed(4)}` : '—' },
    { field: 'model tokens', type: 'in / out', value: run.modelTokens ? `${run.modelTokens.in.toLocaleString('en-US')} / ${run.modelTokens.out.toLocaleString('en-US')}` : '—' },
    { field: 'origin', type: 'resultOrigin', value: selfDeclared ? 'self-declared' : 'hosted' },
    ...(rule?.formula ? [{ field: 'score rule', type: `v${run.score?.version ?? '—'}`, value: `${rule.formula}${rule.hidden ? ` · hidden ${rule.hidden}` : ''}` }] : []),
  ]
  const partRows: FieldRow[] = parts ? Object.entries(parts).map(([k, v]) => ({ field: k, type: 'part', value: 'diagnostic', weight: v })) : []
  const gateRows: FieldRow[] = gates ? Object.entries(gates).map(([k, v]) => ({ field: k, type: 'gate', value: gateWord(v), weight: v === true ? '✓' : v === false ? '✗' : '—' })) : []
  const instruction = taskState.kind === 'ok' ? taskState.task.input.instruction : null
  const text = instruction?.text ?? ''
  const long = text.length > INLINE_INPUT_CHARS || instruction?.truncated === true
  const head = long ? text.split('\n').slice(0, 3).join('\n') : text
  const inputLink = slug ? `/tasks/${encodeURIComponent(slug)}?tab=input` : null
  const repo = taskState.kind === 'ok' ? taskState.task.input.repository : null
  return (
    <div className="ra-tab" data-testid="tab-summary">
      {selfDeclared && (
        <div className="ra-note-box" data-testid="self-declared-note">
          TestMyAgent did not run this. It stores numbers only.
        </div>
      )}
      <div className="dt-cards">
        <section className="tma-card dt-card" data-testid="summary-score">
          <div className="dt-card__head">
            <div className="dt-card__title">
              <strong>Score</strong>
              <span className="dt-card__sub">{hidden ? `hidden ${hidden.passed}/${hidden.total}` : 'no hidden count'} · pass line {PASS_LINE}</span>
            </div>
            <span className="dt-mono ra-score" data-testid="summary-score-value">
              {fmtScore(score)}
            </span>
          </div>
          <div className="dt-card__body">
            <ScoreBar score={score} ci={ci} />
            <span className="dt-mono dt-dim">{ci ? `90% CI ${fmtScore(ci.lo)}–${fmtScore(ci.hi)} (Wilson, hidden checks)` : 'No interval: no hidden check measured.'}</span>
            <FieldTable rows={facts} testId="summary-facts" />
          </div>
        </section>
        <section className="tma-card dt-card" data-testid="summary-input">
          <div className="dt-card__head">
            <div className="dt-card__title">
              <strong>Input</strong>
              <span className="dt-card__sub">{taskState.kind === 'ok' ? `${taskState.task.slug} · instruction` : slug ? slug : 'task'}</span>
            </div>
            {inputLink && (
              <Link to={inputLink} className="ra-text-btn" data-testid="input-link">
                Open the full input
              </Link>
            )}
          </div>
          <div className="dt-card__body">
            {taskState.kind === 'ok' && text ? (
              <>
                <pre className="dt-pre ra-pre" data-testid="input-text" data-long={String(long)}>
                  {head}
                  {long ? '\n…' : ''}
                </pre>
                {long && inputLink && (
                  <Link to={inputLink} className="ra-text-btn" data-testid="input-full-link">
                    Open the full input ↗
                  </Link>
                )}
              </>
            ) : taskState.kind === 'ok' ? (
              <span className="tma-muted">The instruction is not published.</span>
            ) : taskState.kind === 'loading' ? (
              <span className="tma-muted">Loading the input…</span>
            ) : (
              <span className="tma-muted" data-testid="input-private">
                {slug ? 'The task is private: the input is on the task page, for its owner.' : 'The task of this run is not known on this page.'}
              </span>
            )}
            {repo?.repo && (
              <span className="dt-mono dt-dim" data-testid="input-repo">
                {repo.repo}
                {repo.path ? `/${repo.path}` : ''}
                {repo.commit ? `@${middle(repo.commit, 7, 0)}` : ''}
              </span>
            )}
          </div>
        </section>
      </div>
      {(partRows.length > 0 || gateRows.length > 0) && (
        <section className="tma-card dt-card" data-testid="summary-rule">
          <div className="dt-card__head">
            <div className="dt-card__title">
              <strong>Score parts and gates</strong>
              <span className="dt-card__sub">score v{run.score?.version ?? '—'} · the parts are diagnostics; the gates decide</span>
            </div>
          </div>
          <div className="dt-card__body">
            <FieldTable rows={[...gateRows, ...partRows]} testId="summary-parts" />
          </div>
        </section>
      )}
      {owner && run.evidence && (
        <section className="tma-card dt-card" data-testid="summary-evidence">
          <div className="dt-card__head">
            <div className="dt-card__title">
              <strong>Evidence</strong>
              <span className="dt-card__sub">owner only</span>
            </div>
          </div>
          <div className="dt-card__body">
            <FieldTable
              rows={[
                { field: 'executor', type: 'profile', value: run.evidence.executorProfile ?? '—' },
                { field: 'environment', type: 'digest', value: <span className="dt-mono">{run.evidence.environmentDigest ?? '—'}</span> },
                { field: 'contract', type: 'digest', value: <span className="dt-mono">{run.evidence.contractDigest ?? '—'}</span> },
              ]}
            />
            {run.evidence.limitations.length > 0 && (
              <ul className="ra-limits" data-testid="summary-limitations">
                {run.evidence.limitations.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
      {owner && (run.errors?.length ?? 0) > 0 && (
        <div className="ra-errors" role="alert" data-testid="summary-errors">
          {run.errors!.map((e, i) => (
            <pre key={i} className="ra-errors__line">
              {e}
            </pre>
          ))}
        </div>
      )}
    </div>
  )
}

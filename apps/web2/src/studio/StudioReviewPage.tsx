/**
 * S13 Review queue (plan 20261112-tma-c6-judge-calibration, task T3, ADR-6; book p128-132). Phone first.
 * One run per screen for one judge mode: the rubric of the judge (Pass when / Fail when), the split of the run, the task
 * summary, the folded structural trajectory, the judge verdict and the workflow label, and Pass / Fail / Defer.
 * Hotkeys on a desktop: p pass, f fail, d defer. No reason chips: the closed API reason codes belong to another check
 * (review.ts ReasonCode), so a label carries reason_code null.
 * Disagreements between the judge and the workflow label come first (the API orders the queue).
 * The ONE write of the studio: POST /grader-results/human. Defer writes nothing. The full trace stays on the host and
 * opens in S3: the serve resolves the run's case pin (GET /v1/pins/:sha, every selection day). When the run went up
 * without a task summary, the card shows the summary of the serve, marked as read from the host. Nothing that the
 * serve answers goes to the TMA API (parent ADR-1).
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { STUDIO_SERVE_URL } from '../config'
import { Badge, Card, Tip } from '../tma/ui'
import { Kbd, Section, StuButton, Tab, Tabs, themeClass } from './theme'
import { fetchPin, traceErrorText, traceHref, type PinLookup } from './traces'
import {
  JUDGES, JUDGE_RUBRICS, JUDGE_TITLES, LONG_GAP_MS, SPLIT_TEXT, floorMet, fmtDuration, foldSteps, gapBefore, getProgress, getReviewQueue, getRunSteps, isJudge, kindLetter,
  postLabel, progressText, type JudgeId, type ReasonCode, type ReviewProgress, type ReviewRun, type StepDetail, type Verdict,
} from './review'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'

const verdictText = (v: Verdict | null) => (v === null ? 'none' : v.pass ? 'pass' : 'fail')
function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  )
}

/** A verdict as colored text with a mark: green check for pass, red cross for fail, muted for none. The word carries the meaning. */
function Verdict({ v, testId }: { v: Verdict | null; testId: string }) {
  const tone = v === null ? 'stu-label' : v.pass ? 'stu-ok' : 'stu-bad'
  return (
    <span className={`rvw-verdict ${tone}`}>
      {v !== null && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {v.pass ? <path d="M20 6 9 17l-5-5" /> : <path d="M18 6 6 18M6 6l12 12" />}
        </svg>
      )}
      <span data-testid={testId}>{verdictText(v)}</span>
    </span>
  )
}

const verdictTone = (v: Verdict | null) => (v === null ? 'neutral' : v.pass ? 'success' : 'danger')

/** The detail behind the step boxes: every step in order, with the idle time before it, and the opened step in full. */
type StepsLoad = ReturnType<typeof useStudioLoad<{ run_id: string; steps: StepDetail[] }>>

/** The last four calls of the run (the canvas "Last 4 calls"): the tool, the redacted target, and a red bar on a failed call. */
function LastCalls({ loaded }: { loaded: StepsLoad }) {
  if (loaded.state === 'loading') return <p className="stu-label">Loading the calls…</p>
  if (loaded.state === 'error') return <p className="stu-label" data-testid="review-last-error">{loadErrorText(loaded.status)}</p>
  const last = loaded.data.steps.slice(-4)
  if (last.length === 0) return <p className="stu-label">No steps stored for this run.</p>
  return (
    <ol className="rvw-last" data-testid="review-last-calls" aria-label="Last 4 calls">
      {last.map((x) => (
        <li key={x.seq} className={`stu-row rvw-call${x.status !== 'ok' ? ' rvw-call--bad' : ''}`}>
          <span className="stu-row__key">{x.tool}</span>
          <span className="rvw-target">{x.target ?? '—'}</span>
          {x.status !== 'ok' && <span className="stu-bad rvw-status">{x.status ?? 'unknown'}</span>}
        </li>
      ))}
    </ol>
  )
}

function StepTimeline({ loaded, selected, onSelect }: { loaded: StepsLoad; selected: number | null; onSelect: (seq: number) => void }) {
  const rowRef = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    rowRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [selected, loaded.state])
  if (loaded.state === 'loading') return <p className="stu-label">Loading the steps…</p>
  if (loaded.state === 'error') return <p className="stu-bad" role="alert" data-testid="review-step-error">{loadErrorText(loaded.status)}</p>
  const steps = loaded.data.steps
  if (steps.length === 0) return <p className="stu-label">No steps stored for this run.</p>
  const open = steps.find((x) => x.seq === selected) ?? null
  const field = (label: string, value: string | null) => (
    <>
      <dt>{label}</dt>
      <dd>{value ?? '—'}</dd>
    </>
  )
  const startedAt = (x: StepDetail) => fmtDuration(x.startedMs)
  return (
    <div className="rvw-detail" data-testid="review-step-detail">
      {open && (
        <dl className="rvw-open" data-testid="review-step-open">
          {field('Step', `#${open.seq}`)}
          {field('Tool', open.tool)}
          {field('Target', open.target)}
          {field('Result', open.status === 'ok' ? 'ok' : [open.status, open.errorClass].filter(Boolean).join(' · ') || null)}
          {field('Took', fmtDuration(open.durationMs))}
          {field('Started', startedAt(open) ? `${startedAt(open)} into the run` : null)}
          {field('Idle before', fmtDuration(gapBefore(steps[steps.findIndex((x) => x.seq === open.seq) - 1], open)))}
          {field('Turn started by', open.turnOrigin)}
        </dl>
      )}
      <ol className="rvw-rows" aria-label="All steps">
        {steps.map((x, i) => {
          const gap = gapBefore(steps[i - 1], x)
          const long = gap !== null && gap >= LONG_GAP_MS
          const on = x.seq === selected
          return (
            <li key={x.seq} ref={on ? rowRef : undefined} className={`rvw-row${on ? ' rvw-row--on' : ''}${x.status !== 'ok' ? ' rvw-row--bad' : ''}`} data-testid="review-step-row" data-seq={x.seq}>
              {gap !== null && gap >= 1000 && (
                <span className={`rvw-idle${long ? ' rvw-idle--long' : ''}`} data-testid={long ? 'review-step-idle-long' : 'review-step-idle'}>
                  {long ? 'idle ' : '+'}
                  {fmtDuration(gap)}
                </span>
              )}
              <button type="button" className="rvw-rowbtn" onClick={() => onSelect(x.seq)} aria-pressed={on}>
                <span className="rvw-tool">{x.tool}</span>
                <span className="rvw-target">{x.target ?? ''}</span>
                {x.status !== 'ok' && <span className="stu-bad rvw-status">{x.status ?? 'unknown'}</span>}
                {x.durationMs !== null && (
                  <span className={x.durationMs >= LONG_GAP_MS ? 'rvw-dur--long rvw-took' : 'stu-label rvw-took'} data-testid={x.durationMs >= LONG_GAP_MS ? 'review-step-long' : undefined}>
                    {x.durationMs >= LONG_GAP_MS ? 'ran ' : ''}
                    {fmtDuration(x.durationMs)}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function FoldedSteps({ runId, steps }: { runId: string; steps: ReviewRun['steps'] }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const loaded = useStudioLoad(() => getRunSteps(runId), [runId])
  useEffect(() => {
    setOpen(false)
    setSelected(null)
  }, [runId])
  if (steps.length === 0) return <Section title="Last 4 calls"><p className="stu-label">No structural trajectory on this run.</p></Section>
  const f = foldSteps(steps)
  const pick = (seq: number) => {
    setSelected(seq)
    setOpen(true)
  }
  const cell = (s: ReviewRun['steps'][number], i: number) => (
    <button
      key={i}
      type="button"
      className={`rvw-step rvw-step--btn${s.ok === false ? ' rvw-step--bad' : ''}${selected === s.seq ? ' rvw-step--on' : ''}`}
      title={s.kind ?? 'unknown'}
      aria-label={`Step ${s.seq}, ${s.kind ?? 'unknown'}${s.ok === false ? ', failed' : ''}`}
      aria-pressed={selected === s.seq}
      onClick={() => pick(s.seq)}
      data-testid="review-step"
    >
      {kindLetter(s.kind)}
    </button>
  )
  return (
    <Section title="Last 4 calls" meta={`${steps.length} steps`}>
      <LastCalls loaded={loaded} />
      <div className="rvw-steps" data-testid="review-steps" aria-label={`${steps.length} steps`}>
        {f.head.map(cell)}
        {f.hidden > 0 && (
          <button type="button" className="rvw-gap" data-testid="review-steps-hidden" onClick={() => setOpen(true)} aria-label={`${f.hidden} more steps, show all`}>
            +{f.hidden}
          </button>
        )}
        {f.tail.map((s, i) => cell(s, i + 1000))}
      </div>
      <button type="button" className="rvw-toggle" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="review-steps-toggle">
        {open ? 'Hide the steps' : `Show all ${steps.length} steps`}
      </button>
      {open && <StepTimeline loaded={loaded} selected={selected} onSelect={setSelected} />}
    </Section>
  )
}

/** The rubric of the judge: what a Pass and a Fail mean. Open by default; a reviewer who knows it can close it. */
function Rubric({ judge }: { judge: JudgeId }) {
  const r = JUDGE_RUBRICS[judge]
  return (
    <details className="rvw-rubric" open data-testid="review-rubric">
      <summary className="stu-label">{`What counts · rubric ${r.version}`}</summary>
      <p className="tma-body-sm rvw-rubric__crit">{r.criterion}</p>
      <p className="stu-label stu-ok rvw-rubric__head">Pass when</p>
      <ul className="rvw-rubric__list" data-testid="review-rubric-pass">
        {r.pass.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <p className="stu-label stu-bad rvw-rubric__head">Fail when</p>
      <ul className="rvw-rubric__list" data-testid="review-rubric-fail">
        {r.fail.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </details>
  )
}

export function ReviewCard(props: {
  run: ReviewRun
  judge: JudgeId
  traceLink: string | null
  /** The serve answer for the run's pin: the host summary, the task name; or the text of a failed read. */
  host?: PinLookup | null
  hostError?: string | null
  busy: boolean
  error: string | null
  onLabel: (pass: boolean, reason: ReasonCode | null) => void
  onDefer: () => void
}) {
  const { run, judge, traceLink, host = null, hostError = null, busy, error, onLabel, onDefer } = props
  const apiSummary = run.taskSummary && (run.taskSummary.before || run.taskSummary.expected) ? run.taskSummary : null
  const hostSummary = !apiSummary && host?.task_summary && (host.task_summary.before || host.task_summary.expected) ? host.task_summary : null
  const summary = apiSummary ?? hostSummary
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement | null)?.tagName === 'INPUT') return
      if (e.key === 'p') onLabel(true, null)
      else if (e.key === 'f') onLabel(false, null)
      else if (e.key === 'd') onDefer()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onLabel, onDefer])
  return (
    <article className="rvw-card" data-testid="review-card" data-run-id={run.runId}>
      <div className="rvw-lead">
        <p className="stu-label rvw-judge">
          judge · {judge}
          <Tip text="Your answer becomes a label that teaches and checks the AI judge. It does not change the run itself." focusable={false}>
            <button type="button" className="rvw-info" aria-label="What your answer does">
              <InfoIcon />
            </button>
          </Tip>
        </p>
        <h1 className="stu-h1 rvw-question">{JUDGE_TITLES[judge]}?</h1>
        <Rubric judge={judge} />
      </div>
      <Section title="Context">
        <div className="rvw-top">
          {run.split && (
            <Badge tone="neutral" testId="review-split">
              {SPLIT_TEXT[run.split]}
            </Badge>
          )}
          {run.disagree && (
            <Badge tone="warning" testId="review-disagree">
              disagree
            </Badge>
          )}
          {run.mine && (
            <Badge tone={verdictTone(run.mine)} testId="review-mine">
              {`you: ${verdictText(run.mine)}`}
            </Badge>
          )}
        </div>
        <dl className="rvw-summary" data-testid="review-summary" data-source={apiSummary ? 'api' : hostSummary ? 'host' : 'none'}>
          {host?.task_name && (
            <>
              <dt>Task</dt>
              <dd data-testid="review-task-name">{host.task_name}</dd>
            </>
          )}
          <dt>Before</dt>
          <dd>{summary?.before ?? '—'}</dd>
          <dt>Expected</dt>
          <dd>{summary?.expected ?? '—'}</dd>
        </dl>
        {hostSummary && (
          <p className="stu-label" data-testid="review-summary-host">
            Task text read from the trace host (tailnet), not from the TMA server.
          </p>
        )}
        <p className="stu-label rvw-meta" data-testid="review-meta">
          <span className="rvw-meta__case">
            {run.useCaseKey} · {run.caseKey} ·
          </span>
          <span className="rvw-meta__model" title={run.modelId ?? undefined}>
            {run.modelId ?? 'model unknown'}
          </span>
        </p>
      </Section>
      <FoldedSteps runId={run.runId} steps={run.steps} />
      <Section title="Judge says">
        <p className="rvw-signals">
          <span className="stu-text-2">Judge</span> <Verdict v={run.judge} testId="review-judge" />
          <span className="stu-label"> · </span>
          <span className="stu-text-2">Workflow</span> <Verdict v={run.workflow} testId="review-workflow" />
          {run.workflow?.labeler && <span className="stu-label"> {run.workflow.labeler}</span>}
        </p>
        {traceLink && (
          <p className="rvw-trace">
            <Link to={traceLink} data-testid="review-trace-link">
              Open the full trace
            </Link>
          </p>
        )}
        {!traceLink && hostError && (
          <p className="stu-label" data-testid="review-trace-unavailable">
            {hostError}
          </p>
        )}
      </Section>
      {error && (
        <p role="alert" className="stu-bad">
          {error}
        </p>
      )}
      <div className="rvw-actions">
        <StuButton variant="primary" large disabled={busy} onClick={() => onLabel(true, null)} data-testid="review-pass">
          Pass <Kbd>p</Kbd>
        </StuButton>
        <StuButton variant="secondary" large disabled={busy} onClick={() => onLabel(false, null)} data-testid="review-fail">
          Fail <Kbd>f</Kbd>
        </StuButton>
        <StuButton variant="ghost" large disabled={busy} onClick={onDefer} data-testid="review-defer">
          Defer <Kbd>d</Kbd>
        </StuButton>
      </div>
    </article>
  )
}

export function StudioReviewPage() {
  const [params, setParams] = useSearchParams()
  const judgeParam = params.get('judge')
  const judge: JudgeId = isJudge(judgeParam) ? judgeParam : JUDGES[0]
  const loaded = useStudioLoad(() => getReviewQueue(judge), [judge])
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(0)
  // The serve answer per case pin: a lookup, or the user text of a failed read. Read once per pin, for the shown run.
  const [pins, setPins] = useState<Map<string, PinLookup | { error: string }>>(new Map())
  const [progress, setProgress] = useState<ReviewProgress | null>(null)
  const [weak, setWeak] = useState<string | null>(null)
  const judgeRef = useRef(judge)
  judgeRef.current = judge
  // A late answer for the judge of the other tab is dropped.
  const refreshProgress = (j: JudgeId) =>
    getProgress(j).then(
      (p) => judgeRef.current === j && setProgress(p),
      () => judgeRef.current === j && setProgress(null),
    )
  useEffect(() => {
    setIndex(0)
    setSaved(0)
    setProgress(null)
    setWeak(null)
    void refreshProgress(judge)
  }, [judge])
  const runs = loaded.state === 'ok' ? loaded.data.runs : []
  const run = runs[index] ?? null
  const pinSha = run?.originPinSha256 ?? null
  useEffect(() => {
    if (!STUDIO_SERVE_URL || !pinSha || pins.has(pinSha)) return
    let live = true
    fetchPin(pinSha).then(
      (p) => live && setPins((m) => new Map(m).set(pinSha, p)),
      (e: unknown) => live && setPins((m) => new Map(m).set(pinSha, { error: traceErrorText(e) })),
    )
    return () => {
      live = false
    }
  }, [pinSha, pins])
  const pinAnswer = pinSha ? pins.get(pinSha) : undefined
  const pin = pinAnswer && 'session_id' in pinAnswer ? pinAnswer : null
  const label = (pass: boolean, reason: ReasonCode | null) => {
    if (!run || busy) return
    setBusy(true)
    setError(null)
    postLabel({ run_id: run.runId, judge_id: judge, pass, reason_code: reason }).then(
      (l) => {
        setBusy(false)
        setSaved((n) => n + 1)
        setIndex((i) => i + 1)
        // A label of an agent or unknown login is stored but does not count for calibration (labeler not person:).
        setWeak(l.strength === 'strong' ? null : `The label was saved as ${l.labeler?.split(':')[0] ?? 'unknown'}, not as a person, so it does not count for calibration. Sign out and sign in again with your own DFL login.`)
        void refreshProgress(judge)
      },
      (e: unknown) => {
        setBusy(false)
        setError(e instanceof Error ? `The label was not saved: ${e.message}` : 'The label was not saved.')
      },
    )
  }
  return (
    <main className={themeClass('tma-page', 'rvw-page')} data-testid="studio-review">
      <header className="rvw-head">
        <Tabs label="Judge">
          {JUDGES.map((j) => (
            <Tab key={j} selected={j === judge} onClick={() => setParams({ judge: j })} data-testid={`review-judge-${j}`}>
              {j}
            </Tab>
          ))}
        </Tabs>
        {run && (
          <span className="stu-label rvw-queue">
            <span className="rvw-queue__label">review queue · </span>
            <span data-testid="review-position">{`${index + 1} of ${runs.length}`}</span>
          </span>
        )}
      </header>
      {progress && (
        <p className={`stu-label rvw-progress${floorMet(progress) ? ' stu-ok' : ''}`} data-testid="review-progress" title="Person labels of this judge in the test split; C6 needs 30 pass and 30 fail">
          {progressText(progress)}
        </p>
      )}
      {weak && (
        <p role="alert" className="stu-bad" data-testid="review-weak">
          {weak}
        </p>
      )}
      {loaded.state === 'loading' && <p className="stu-label">Loading the queue…</p>}
      {loaded.state === 'error' && (
        <Card pad data-testid="review-error">
          <p className="tma-body-sm">{loadErrorText(loaded.status)}</p>
        </Card>
      )}
      {loaded.state === 'ok' && runs.length === 0 && (
        <Card pad data-testid="review-empty">
          <span className="stu-label">The queue is empty</span>
          <p className="tma-body-sm tma-muted">A run appears here when a recorded session is uploaded as a trace review case.</p>
        </Card>
      )}
      {loaded.state === 'ok' && runs.length > 0 && run === null && (
        <Card pad data-testid="review-done">
          <span className="stu-label">Done for now</span>
          <p className="tma-body-sm tma-muted">{`You saved ${saved} label(s) in this pass.`}</p>
          <StuButton variant="secondary" onClick={() => setIndex(0)} data-testid="review-restart">
            Start again
          </StuButton>
        </Card>
      )}
      {run && (
        <ReviewCard
          run={run}
          judge={judge}
          traceLink={pin?.has_trajectory ? traceHref(pin.session_id, pin.agent_id) : null}
          host={pin}
          hostError={pinAnswer && 'error' in pinAnswer ? pinAnswer.error : null}
          busy={busy}
          error={error}
          onLabel={label}
          onDefer={() => setIndex((i) => i + 1)}
        />
      )}
    </main>
  )
}

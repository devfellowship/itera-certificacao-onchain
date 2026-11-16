/**
 * S13 Review queue (plan 20261112-tma-c6-judge-calibration, task T3, ADR-6; book p128-132). Phone first.
 * One run per screen for one judge mode: the task summary, the folded structural trajectory, the judge verdict and the
 * workflow label, and Pass / Fail / Defer with reason chips. Hotkeys on a desktop: p pass, f fail, d defer, 1-4 reason.
 * Disagreements between the judge and the workflow label come first (the API orders the queue).
 * The ONE write of the studio: POST /grader-results/human. Defer writes nothing. The full trace stays on the host and
 * opens in S3 when the run's case pin is in the `tma studio serve` index.
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { STUDIO_SERVE_URL } from '../config'
import { Badge, Button, Card } from '../tma/ui'
import { traceHref } from './traces'
import {
  JUDGES, JUDGE_TITLES, LONG_GAP_MS, REASONS, fmtDuration, foldSteps, gapBefore, getReviewQueue, getRunSteps, isJudge, kindLetter, pinIndex, postLabel,
  type JudgeId, type ReasonCode, type ReviewRun, type StepDetail, type Verdict,
} from './review'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'

const verdictText = (v: Verdict | null) => (v === null ? 'none' : v.pass ? 'pass' : 'fail')
const verdictTone = (v: Verdict | null) => (v === null ? 'neutral' : v.pass ? 'success' : 'danger')

/** The detail behind the step boxes: every step in order, with the idle time before it, and the opened step in full. */
function StepTimeline({ runId, selected, onSelect }: { runId: string; selected: number | null; onSelect: (seq: number) => void }) {
  const loaded = useStudioLoad(() => getRunSteps(runId), [runId])
  const rowRef = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    rowRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [selected, loaded.state])
  if (loaded.state === 'loading') return <p className="tma-body-sm tma-muted">Loading the steps…</p>
  if (loaded.state === 'error') return <p className="tma-body-sm" role="alert" data-testid="review-step-error">{loadErrorText(loaded.status)}</p>
  const steps = loaded.data.steps
  if (steps.length === 0) return <p className="tma-body-sm tma-muted">No steps stored for this run.</p>
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
        <dl className="stu-dl rvw-open" data-testid="review-step-open">
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
                <span className="rvw-step">{kindLetter(x.kind)}</span> <strong>{x.tool}</strong> <span className="tma-mono">{x.target ?? ''}</span>
                {x.status !== 'ok' && <span className="tma-muted"> {x.status ?? 'unknown'}</span>}
                {x.durationMs !== null && <span className="tma-muted"> {fmtDuration(x.durationMs)}</span>}
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
  useEffect(() => {
    setOpen(false)
    setSelected(null)
  }, [runId])
  if (steps.length === 0) return <p className="tma-body-sm tma-muted">No structural trajectory on this run.</p>
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
    <div>
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
        {open ? 'Hide the steps' : `Show what the agent did (${steps.length} steps)`}
      </button>
      {open && <StepTimeline runId={runId} selected={selected} onSelect={setSelected} />}
    </div>
  )
}

export function ReviewCard(props: {
  run: ReviewRun
  judge: JudgeId
  position: string
  traceLink: string | null
  busy: boolean
  error: string | null
  onLabel: (pass: boolean, reason: ReasonCode | null) => void
  onDefer: () => void
}) {
  const { run, judge, position, traceLink, busy, error, onLabel, onDefer } = props
  const [reason, setReason] = useState<ReasonCode | null>(null)
  useEffect(() => setReason(null), [run.runId])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement | null)?.tagName === 'INPUT') return
      if (e.key === 'p') onLabel(true, reason)
      else if (e.key === 'f') onLabel(false, reason)
      else if (e.key === 'd') onDefer()
      else if (['1', '2', '3', '4'].includes(e.key)) setReason(REASONS[Number(e.key) - 1]!.code)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, reason, onLabel, onDefer])
  return (
    <Card pad className="rvw-card" data-testid="review-card" data-run-id={run.runId}>
      <div className="rvw-top">
        <span className="tma-label" data-testid="review-position">
          {position}
        </span>
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
      <p className="tma-body-sm tma-mono rvw-meta">
        {run.useCaseKey} · {run.caseKey} · {run.modelId ?? 'model unknown'}
      </p>
      <dl className="stu-dl rvw-summary" data-testid="review-summary">
        <dt>Before</dt>
        <dd>{run.taskSummary?.before ?? '—'}</dd>
        <dt>Expected</dt>
        <dd>{run.taskSummary?.expected ?? '—'}</dd>
      </dl>
      <FoldedSteps runId={run.runId} steps={run.steps} />
      <p className="tma-body-sm rvw-signals">
        Judge <Badge tone={verdictTone(run.judge)} testId="review-judge">{verdictText(run.judge)}</Badge> · Workflow{' '}
        <Badge tone={verdictTone(run.workflow)} testId="review-workflow">{verdictText(run.workflow)}</Badge>
        {run.workflow?.labeler && <span className="tma-mono tma-muted"> {run.workflow.labeler}</span>}
      </p>
      {traceLink && (
        <p className="tma-body-sm">
          <Link to={traceLink} data-testid="review-trace-link">
            Open the full trace
          </Link>
        </p>
      )}
      <p className="tma-body-sm rvw-question">{JUDGE_TITLES[judge]}?</p>
      <div className="rvw-chips" role="group" aria-label="Reason">
        {REASONS.map((r, i) => (
          <button
            key={r.code}
            type="button"
            className={`rvw-chip${reason === r.code ? ' rvw-chip--on' : ''}`}
            aria-pressed={reason === r.code}
            onClick={() => setReason(reason === r.code ? null : r.code)}
            data-testid={`review-reason-${r.code}`}
          >
            <span className="rvw-key">{i + 1}</span> {r.text}
          </button>
        ))}
      </div>
      <div className="rvw-actions">
        <Button variant="primary" disabled={busy} onClick={() => onLabel(true, reason)} data-testid="review-pass">
          Pass <span className="rvw-key">p</span>
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => onLabel(false, reason)} data-testid="review-fail">
          Fail <span className="rvw-key">f</span>
        </Button>
        <Button variant="text" disabled={busy} onClick={onDefer} data-testid="review-defer">
          Defer <span className="rvw-key">d</span>
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
    </Card>
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
  const [pins, setPins] = useState<Map<string, { sessionId: string; agentId: string | null }>>(new Map())
  useEffect(() => {
    setIndex(0)
    setSaved(0)
  }, [judge])
  useEffect(() => {
    if (!STUDIO_SERVE_URL) return
    let live = true
    pinIndex().then((m) => live && setPins(m), () => undefined)
    return () => {
      live = false
    }
  }, [])
  const runs = loaded.state === 'ok' ? loaded.data.runs : []
  const run = runs[index] ?? null
  const pin = run?.originPinSha256 ? pins.get(run.originPinSha256) : undefined
  const label = (pass: boolean, reason: ReasonCode | null) => {
    if (!run || busy) return
    setBusy(true)
    setError(null)
    postLabel({ run_id: run.runId, judge_id: judge, pass, reason_code: reason }).then(
      () => {
        setBusy(false)
        setSaved((n) => n + 1)
        setIndex((i) => i + 1)
      },
      (e: unknown) => {
        setBusy(false)
        setError(e instanceof Error ? `The label was not saved: ${e.message}` : 'The label was not saved.')
      },
    )
  }
  return (
    <main className="tma-page rvw-page" data-testid="studio-review">
      <div className="stu-head">
        <h1 className="tma-h1">Review</h1>
        <p className="stu-sub">Label one run at a time for one judge. Your label is the only thing this page saves.</p>
        <div className="rvw-judges" role="tablist" aria-label="Judge">
          {JUDGES.map((j) => (
            <button
              key={j}
              type="button"
              role="tab"
              aria-selected={j === judge}
              className={`rvw-chip${j === judge ? ' rvw-chip--on' : ''}`}
              onClick={() => setParams({ judge: j })}
              data-testid={`review-judge-${j}`}
            >
              {j}
            </button>
          ))}
        </div>
      </div>
      {loaded.state === 'loading' && <p className="tma-body-sm tma-muted">Loading the queue…</p>}
      {loaded.state === 'error' && (
        <Card pad data-testid="review-error">
          <p className="tma-body-sm">{loadErrorText(loaded.status)}</p>
        </Card>
      )}
      {loaded.state === 'ok' && runs.length === 0 && (
        <Card pad data-testid="review-empty">
          <span className="tma-label">The queue is empty</span>
          <p className="tma-body-sm tma-muted">A run appears here when a recorded session is uploaded as a trace review case.</p>
        </Card>
      )}
      {loaded.state === 'ok' && runs.length > 0 && run === null && (
        <Card pad data-testid="review-done">
          <span className="tma-label">Done for now</span>
          <p className="tma-body-sm tma-muted">{`You saved ${saved} label(s) in this pass.`}</p>
          <Button variant="secondary" onClick={() => setIndex(0)} data-testid="review-restart">
            Start again
          </Button>
        </Card>
      )}
      {run && (
        <ReviewCard
          run={run}
          judge={judge}
          position={`${index + 1} of ${runs.length}`}
          traceLink={pin ? traceHref(pin.sessionId, pin.agentId) : null}
          busy={busy}
          error={error}
          onLabel={label}
          onDefer={() => setIndex((i) => i + 1)}
        />
      )}
    </main>
  )
}

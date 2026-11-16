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
import { Badge, Card, Tip } from '../tma/ui'
import { Chip, Kbd, Section, StuButton, Tab, Tabs, themeClass } from './theme'
import { traceHref } from './traces'
import {
  JUDGES, JUDGE_TITLES, LONG_GAP_MS, REASONS, fmtDuration, foldSteps, gapBefore, getReviewQueue, getRunSteps, isJudge, kindLetter, pinIndex, postLabel,
  type JudgeId, type ReasonCode, type ReviewRun, type StepDetail, type Verdict,
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
function StepTimeline({ runId, selected, onSelect }: { runId: string; selected: number | null; onSelect: (seq: number) => void }) {
  const loaded = useStudioLoad(() => getRunSteps(runId), [runId])
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
  useEffect(() => {
    setOpen(false)
    setSelected(null)
  }, [runId])
  if (steps.length === 0) return <Section title="What the agent did"><p className="stu-label">No structural trajectory on this run.</p></Section>
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
    <Section title="What the agent did" meta={`${steps.length} steps`}>
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
        {open ? 'Hide the steps' : `Show the steps (${steps.length})`}
      </button>
      {open && <StepTimeline runId={runId} selected={selected} onSelect={setSelected} />}
    </Section>
  )
}

export function ReviewCard(props: {
  run: ReviewRun
  judge: JudgeId
  traceLink: string | null
  busy: boolean
  error: string | null
  onLabel: (pass: boolean, reason: ReasonCode | null) => void
  onDefer: () => void
}) {
  const { run, judge, traceLink, busy, error, onLabel, onDefer } = props
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
    <article className="rvw-card" data-testid="review-card" data-run-id={run.runId}>
      <div className="rvw-lead">
        <p className="stu-label rvw-judge">
          judge · {judge}
          <Tip text="Your answer becomes a label that teaches and checks the AI judge. It does not change the run itself.">
            <span className="rvw-info" role="img" aria-label="What your answer does">
              <InfoIcon />
            </span>
          </Tip>
        </p>
        <h1 className="stu-h1 rvw-question">{JUDGE_TITLES[judge]}?</h1>
      </div>
      <Section title="Context">
        <div className="rvw-top">
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
        <dl className="rvw-summary" data-testid="review-summary">
          <dt>Before</dt>
          <dd>{run.taskSummary?.before ?? '—'}</dd>
          <dt>Expected</dt>
          <dd>{run.taskSummary?.expected ?? '—'}</dd>
        </dl>
        <p className="stu-label rvw-meta">
          {run.useCaseKey} · {run.caseKey} · {run.modelId ?? 'model unknown'}
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
      </Section>
      <div className="rvw-chips" role="group" aria-label="Reason">
        {REASONS.map((r, i) => (
          <Chip key={r.code} on={reason === r.code} onClick={() => setReason(reason === r.code ? null : r.code)} data-testid={`review-reason-${r.code}`}>
            <Kbd>{i + 1}</Kbd> {r.text}
          </Chip>
        ))}
      </div>
      {error && (
        <p role="alert" className="stu-bad">
          {error}
        </p>
      )}
      <div className="rvw-actions">
        <StuButton variant="primary" large disabled={busy} onClick={() => onLabel(true, reason)} data-testid="review-pass">
          Pass <Kbd>p</Kbd>
        </StuButton>
        <StuButton variant="secondary" large disabled={busy} onClick={() => onLabel(false, reason)} data-testid="review-fail">
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
            review queue · <span data-testid="review-position">{`${index + 1} of ${runs.length}`}</span>
          </span>
        )}
      </header>
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

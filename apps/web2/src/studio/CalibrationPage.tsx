/**
 * S11 Judge calibration (plan 20261112-tma-c6-judge-calibration, task T6; canvas S11). Read only, no write control.
 * One card per judge: the label counts, the newest measured version (TPR and TNR against the 90 % bar with the interval, the 2x2
 * counts, the split sizes), the contamination note and the trend over versions. A judge with no version shows an empty state
 * that says what makes the first record appear. Data: GET /grader-versions, GET /grader-versions/:id, GET /review-queue.
 */
import { Link } from 'react-router-dom'
import { Card, CardHeader } from '../tma/ui'
import { JUDGE_BAR, loadCalibration, type JudgeCalibration } from './calibration'
import { MeasuredVersion, VersionTrend } from './CalibrationParts'
import { JUDGE_TITLES } from './review'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'

export function JudgeCard({ c }: { c: JudgeCalibration }) {
  const newest = c.versions.length ? c.versions[c.versions.length - 1]! : null
  return (
    <Card data-testid="calibration-judge" data-judge={c.judge}>
      <CardHeader title={c.judge} meta={`${c.versions.length} ${c.versions.length === 1 ? 'version' : 'versions'}`} />
      <div className="stu-pad cal-body">
        <p className="tma-body-sm">{JUDGE_TITLES[c.judge]}</p>
        <dl className="stu-dl cal-counts" data-testid="calibration-counts">
          <dt>Runs to review</dt>
          <dd data-testid="cal-to-review">{c.queue ? c.queue.toReview : 'unavailable'}</dd>
          <dt>With a workflow label</dt>
          <dd data-testid="cal-workflow-labels">{c.queue ? c.queue.workflowLabels : 'unavailable'}</dd>
          <dt>Label rows, all sources</dt>
          <dd data-testid="cal-label-rows">{c.labelRows ?? 0}</dd>
        </dl>
        {newest ? (
          <MeasuredVersion v={newest} />
        ) : (
          <div data-testid="calibration-empty">
            <span className="tma-label">No calibration yet</span>
            <p className="tma-body-sm tma-muted">
              No version of this judge has a calibration record. The first one appears here after <span className="tma-mono">tma eval judge calibrate</span> measures
              the judge on a clean test split and the result is uploaded. A decisive judge needs TPR and TNR of at least {Math.round(JUDGE_BAR * 100)}%.
            </p>
          </div>
        )}
        <p className="tma-body-sm tma-muted" data-testid="calibration-contamination">
          Contamination check: the eval repo CI refuses a golden set that shares an item with a calibration set, and a few-shot example from the test split. The result
          store does not keep the check result.
        </p>
        {c.versions.length > 1 && <VersionTrend versions={c.versions} />}
        <p className="tma-body-sm">
          <Link to={`/studio/calibration/${encodeURIComponent(c.judge)}`} data-testid="calibration-judge-link">
            Judge definition
          </Link>
          {' · '}
          <Link to={`/studio/review?judge=${encodeURIComponent(c.judge)}`} data-testid="calibration-review-link">
            Review runs
          </Link>
        </p>
      </div>
    </Card>
  )
}

export function CalibrationPage({ judges }: { judges?: JudgeCalibration[] }) {
  const loaded = useStudioLoad(judges ? null : loadCalibration, [judges ? 'prop' : 'api'])
  const list = judges ?? (loaded.state === 'ok' ? loaded.data : null)
  return (
    <main className="tma-page" data-testid="studio-calibration">
      <div className="stu-head">
        <h1 className="tma-h1">Judge calibration</h1>
        <p className="stu-sub">How well each AI judge agrees with labeled runs. A judge decides only when TPR and TNR are both at least {Math.round(JUDGE_BAR * 100)}%. Read only.</p>
        <p className="tma-body-sm">
          <Link to="/studio" data-testid="calibration-back">
            Studio
          </Link>
          {' · '}
          <Link to="/studio/graders" data-testid="calibration-graders-link">
            Graders
          </Link>
        </p>
      </div>
      {!judges && loaded.state === 'loading' && (
        <Card pad data-testid="calibration-loading">
          <span className="tma-body-sm tma-muted">Loading calibration…</span>
        </Card>
      )}
      {!judges && loaded.state === 'error' && (
        <Card pad data-testid="calibration-unavailable">
          <span className="tma-label">Calibration is not available</span>
          <p className="tma-body-sm tma-muted">{loadErrorText(loaded.status)}</p>
        </Card>
      )}
      {list && (
        <div className="stu-groups">
          {list.map((c) => (
            <JudgeCard key={c.judge} c={c} />
          ))}
        </div>
      )}
    </main>
  )
}

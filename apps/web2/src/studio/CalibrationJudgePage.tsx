/**
 * S11a AI judge (plan 20261112-tma-c6-judge-calibration, task T6; canvas S11a). Read only. One judge: the version, its model
 * (only a name from the A11 Q1 = B list is printed), the rubric, params and test split digests, the 90 % bar and the measured rates.
 * The canvas write button is a copy command: the studio never changes a judge. A judge changes by a pull request in dfl-evals.
 * The "try it" panel is the dry run of S10a (GraderDryRunPanel); it shows only when `tma studio serve` has a dry run route.
 */
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Card, CardHeader } from '../tma/ui'
import { CopyCommand } from './CopyCommand'
import { calibrateCommand, isKnownJudge, JUDGE_BAR, loadJudge, shownModel, type JudgeCalibration } from './calibration'
import { MeasuredVersion, RateBar, VersionTrend } from './CalibrationParts'
import { GraderDryRunPanel } from './GraderDryRunPanel'
import { JUDGE_TITLES } from './review'
import { shortDigest } from './graders'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'

export function JudgeDefinition({ c, version }: { c: JudgeCalibration; version?: string | null }) {
  const v = (version ? c.versions.find((x) => x.semver === version) : null) ?? (c.versions.length ? c.versions[c.versions.length - 1]! : null)
  return (
    <>
      <Card data-testid="judge-definition">
        <CardHeader title={c.judge} meta={v ? `v${v.semver}` : 'no version yet'} />
        <div className="stu-pad cal-body">
          <p className="tma-body-sm">{JUDGE_TITLES[c.judge]}</p>
          {v ? (
            <dl className="stu-dl">
              <dt>Model</dt>
              <dd className="tma-mono" data-testid="judge-model">
                {shownModel(v.judgeModelId)}
              </dd>
              <dt>Rubric digest</dt>
              <dd className="tma-mono" title={v.rubricSha256 ?? undefined} data-testid="judge-rubric">
                {v.rubricSha256 ? shortDigest(v.rubricSha256) : 'not recorded'}
              </dd>
              <dt>Params digest</dt>
              <dd className="tma-mono" title={v.paramsSha256 ?? undefined} data-testid="judge-params">
                {v.paramsSha256 ? shortDigest(v.paramsSha256) : 'not recorded'}
              </dd>
              <dt>Code digest</dt>
              <dd className="tma-mono" title={v.codeSha256}>
                {shortDigest(v.codeSha256)}
              </dd>
              <dt>Created</dt>
              <dd>{v.createdAt}</dd>
              {v.note && (
                <>
                  <dt>Note</dt>
                  <dd>{v.note}</dd>
                </>
              )}
            </dl>
          ) : (
            <div data-testid="judge-empty">
              <span className="tma-label">No version uploaded yet</span>
              <p className="tma-body-sm tma-muted">
                The judge definition lives in the eval repo (<span className="tma-mono">judges/{c.judge}/</span>). A version shows here after its first calibration result is
                uploaded.
              </p>
            </div>
          )}
        </div>
      </Card>
      <Card data-testid="judge-bar">
        <CardHeader title="Bar" meta={`${Math.round(JUDGE_BAR * 100)}%`} />
        <div className="stu-pad cal-body">
          <p className="tma-body-sm" data-testid="judge-bar-text">
            A judge is decisive only when TPR and TNR are both at least {Math.round(JUDGE_BAR * 100)}% on a clean test split.
          </p>
          {v ? <MeasuredVersion v={v} /> : (
            <>
              <RateBar label="TPR" value={null} k={null} n={null} testId="cal-tpr" />
              <RateBar label="TNR" value={null} k={null} n={null} testId="cal-tnr" />
            </>
          )}
        </div>
      </Card>
      {c.versions.length > 1 && (
        <Card data-testid="judge-trend">
          <CardHeader title="Versions" meta={`${c.versions.length}`} />
          <VersionTrend versions={c.versions} />
        </Card>
      )}
      <Card pad>
        <span className="tma-label">Measure on your host</span>
        <p className="tma-body-sm tma-muted">The studio is read only. Copy this command and run it where the eval repo is checked out.</p>
        <CopyCommand command={calibrateCommand(c.judge, v?.semver ?? null, v?.judgeModelId ?? null)} title="Calibrate" testId="judge-command" />
      </Card>
      {v && <GraderDryRunPanel grader={`${v.graderId}@${v.semver}`} kind="judge" />}
    </>
  )
}

export function CalibrationJudgePage({ judge: judgeProp, loaded: loadedProp }: { judge?: string; loaded?: JudgeCalibration }) {
  const params = useParams()
  const [search] = useSearchParams()
  const judge = judgeProp ?? params.judgeId ?? ''
  const known = isKnownJudge(judge)
  const loaded = useStudioLoad(loadedProp || !known ? null : () => loadJudge(judge), [judge, loadedProp ? 'prop' : 'api'])
  const data = loadedProp ?? (loaded.state === 'ok' ? loaded.data : null)
  return (
    <main className="tma-page" data-testid="studio-calibration-judge">
      <div className="stu-head">
        <h1 className="tma-h1">AI judge</h1>
        <p className="stu-sub">
          <Link to="/studio/calibration" data-testid="judge-back">
            All judges
          </Link>
        </p>
      </div>
      {!known && (
        <Card pad data-testid="judge-unknown">
          <span className="tma-label">Unknown judge</span>
          <p className="tma-body-sm tma-muted">This judge does not exist. Open a judge from the calibration list.</p>
        </Card>
      )}
      {known && !loadedProp && loaded.state === 'loading' && (
        <Card pad data-testid="calibration-loading">
          <span className="tma-body-sm tma-muted">Loading judge…</span>
        </Card>
      )}
      {known && !loadedProp && loaded.state === 'error' && (
        <Card pad data-testid="calibration-unavailable">
          <span className="tma-label">The judge is not available</span>
          <p className="tma-body-sm tma-muted">{loadErrorText(loaded.status)}</p>
        </Card>
      )}
      {known && data && <JudgeDefinition c={data} version={search.get('version')} />}
    </main>
  )
}

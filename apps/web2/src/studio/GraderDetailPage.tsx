/**
 * S10a Grader detail (plan 20261112-tma-c5-studio-area-web2, task C5-T5). Read only. The canvas write buttons are
 * replaced by a copy command: the studio never writes; the user runs `tma eval` on their own host.
 * Data: GET /grader-versions/:id. Judge calibration screens (S11, S11a) are not here.
 * C5-T10: when VITE_TMA_STUDIO_SERVE_URL is set, the "Try this grader (dry run)" panel (GraderDryRunPanel) shows
 * under the copy command. It only does a dry run on `tma studio serve`; nothing is stored.
 */
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Card, CardHeader } from '../tma/ui'
import { failedState, getGraderVersion, gradeCommand, shortDigest, type GraderVersionDetail, type Loaded } from './graders'
import { GraderDryRunPanel } from './GraderDryRunPanel'
import { GraderEmpty } from './GraderLibraryPage'
import './studio.css'

/** A copy control: the command is in `data-copy-command`; a click copies it; the <pre> stays selectable. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
    } catch {
      /* clipboard blocked: the <pre> below is selectable */
    }
  }
  return (
    <div className="stu-copy" data-copy-command={command} data-testid="copy-command">
      <pre className="tma-mono">{command}</pre>
      <button type="button" onClick={copy} aria-label="Copy command">
        {copied ? 'Copied' : 'Copy command'}
      </button>
    </div>
  )
}

const pct = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v * 1000) / 10}%`)

export function GraderDetailView({ g, serveUrl }: { g: GraderVersionDetail; /** Override of VITE_TMA_STUDIO_SERVE_URL (tests). */ serveUrl?: string }) {
  return (
    <>
      <Card data-testid="grader-detail">
        <CardHeader title={`${g.graderId}@${g.semver}`} meta={g.kind} />
        <dl className="stu-dl">
          <dt>Code digest</dt>
          <dd className="tma-mono" title={g.codeSha256} data-testid="grader-digest">{shortDigest(g.codeSha256)}</dd>
          <dt>Used by</dt>
          <dd data-testid="grader-used-by">{g.usedByCount}</dd>
          <dt>Created</dt>
          <dd>{g.createdAt}</dd>
          {g.author && (<><dt>Author</dt><dd>{g.author}</dd></>)}
          {g.note && (<><dt>Note</dt><dd>{g.note}</dd></>)}
          {g.proof && (<><dt>Mutation proof</dt><dd data-testid="grader-proof">{g.proof.caught} of {g.proof.total} planted bugs caught</dd></>)}
        </dl>
      </Card>
      {g.kind === 'judge' && (
        <Card data-testid="grader-judge">
          <CardHeader title="Judge" />
          <dl className="stu-dl">
            <dt>Model</dt>
            <dd className="tma-mono">{g.judgeModelId ?? 'n/a'}</dd>
            <dt>TPR</dt>
            <dd>{pct(g.tpr)}</dd>
            <dt>TNR</dt>
            <dd>{pct(g.tnr)}</dd>
            {g.rubricSha256 && (<><dt>Rubric</dt><dd className="tma-mono" title={g.rubricSha256}>{shortDigest(g.rubricSha256)}</dd></>)}
            {g.calibration && (
              <>
                <dt>Labels</dt>
                <dd>{g.calibration.nLabels} ({g.calibration.nTest} in the test split; tp {g.calibration.tp}, fn {g.calibration.fn}, tn {g.calibration.tn}, fp {g.calibration.fp})</dd>
              </>
            )}
          </dl>
        </Card>
      )}
      <Card data-testid="grader-recent-runs">
        <CardHeader title="Latest gradings" />
        {g.recentRuns.length === 0 ? (
          <p className="tma-body-sm tma-muted">No grading yet.</p>
        ) : (
          <ul className="stu-cases">
            {g.recentRuns.map((r) => (
              <li key={`${r.runId}-${r.gradedAt}`} data-testid="grader-recent-run">
                <Link to={r.evaluationId ? `/evaluations/${r.evaluationId}/runs/${r.runId}` : `/evaluations`} className="tma-mono">
                  run {r.runId.slice(0, 8)}
                </Link>{' '}
                {r.pass ? 'pass' : 'fail'}
                {r.caseId && <span className="tma-mono tma-muted"> case {r.caseId.slice(0, 8)}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card pad>
        <span className="tma-label">Grade again on your host</span>
        <p className="tma-body-sm tma-muted">The studio is read only. Copy this command and run it where your case folder is.</p>
        <CopyCommand command={gradeCommand()} />
      </Card>
      <GraderDryRunPanel grader={`${g.graderId}@${g.semver}`} kind={g.kind} {...(serveUrl !== undefined ? { serveUrl } : {})} />
    </>
  )
}

export function GraderDetailPage() {
  const { id = '' } = useParams()
  const [s, setS] = useState<Loaded<GraderVersionDetail>>({ state: 'loading' })
  useEffect(() => {
    let live = true
    setS({ state: 'loading' })
    getGraderVersion(id).then(
      (r) => live && setS({ state: 'ready', data: r }),
      (e) => live && setS(failedState(e)),
    )
    return () => {
      live = false
    }
  }, [id])
  return (
    <main className="tma-page" data-testid="studio-grader-detail">
      <div className="stu-head">
        <h1 className="tma-h1">Grader version</h1>
        <p className="stu-sub">
          <Link to="/studio/graders" data-testid="graders-back">All graders</Link>
        </p>
      </div>
      {s.state === 'loading' && <p className="tma-body-sm tma-muted">Loading grader…</p>}
      {s.state === 'ready' && <GraderDetailView g={s.data} />}
      {s.state === 'unavailable' && <GraderEmpty text="The grader library is not available yet on this server." />}
      {s.state === 'not-found' && <GraderEmpty text="This grader version does not exist, or it is not yours to read." />}
      {s.state === 'error' && <p role="alert">{s.message}</p>}
    </main>
  )
}

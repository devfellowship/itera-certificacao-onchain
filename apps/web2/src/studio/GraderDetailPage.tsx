/**
 * S10a Grader detail (plan 20261112-tma-c5-studio-area-web2, tasks C5-T5 and C5-RD-S10-S11). Read only. Layout from the
 * canvas artboard "S10a Code grader details": the trail, the title with its kind, version and "can decide" marks, the
 * description, the tabs (Definition, Proof, Versions), the facts strip, and a side panel with the latest gradings of this
 * version. The canvas write buttons (Duplicate, Save as) are a copy command: the studio never writes; the user runs
 * `tma eval` on their own host.
 * C5-T10: when VITE_TMA_STUDIO_SERVE_URL is set and VITE_TMA_STUDIO_DRY_RUN is 'true' (C5-T6), the "Try this grader (dry run)"
 * panel (GraderDryRunPanel) shows in the side panel. It only does a dry run on `tma studio serve`; nothing is stored.
 * Data: GET /grader-versions/:id, and GET /grader-versions for the other versions of the same grader.
 * Gaps against the artboard: the grader source, runtime, sandbox, timeout and inputs are not in the result store (the code
 * stays in the eval repo; the store keeps its digest), so the page says so instead of showing them.
 */
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { STUDIO_SCREENS } from './links'
import { failedState, getGraderVersion, gradeCommand, listGraderVersions, shortDigest, type GraderVersionDetail, type GraderVersionItem, type Loaded } from './graders'
import { isKnownJudge, pct, shownModel } from './calibration'
import { GraderDryRunPanel } from './GraderDryRunPanel'
import { decideOf, groupTitle, plural, whatItChecks, type GroupKey } from './grader-library'
import { DecideMark, LibraryShell, StateBox } from './GraderLibraryParts'
import { GraderEmpty } from './GraderLibraryPage'

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
      <div className="stu-copy__head">
        <span className="tma-label">Grade again on your host</span>
        <button type="button" className="stu-copy__btn" onClick={copy} aria-label="Copy command">
          {copied ? 'Copied' : 'Copy command'}
        </button>
      </div>
      <pre className="stu-copy__pre">{command}</pre>
    </div>
  )
}

type TabKey = 'definition' | 'proof' | 'versions'

function Fact({ k, children, title, testId }: { k: string; children: React.ReactNode; title?: string; testId?: string }) {
  return (
    <div className="grd-fact">
      <dt>{k}</dt>
      <dd title={title} data-testid={testId}>
        {children}
      </dd>
    </div>
  )
}

function Definition({ g }: { g: GraderVersionDetail }) {
  return (
    <>
      <dl className="grd-facts" data-testid="grader-facts">
        <Fact k="Kind">{g.kind}</Fact>
        <Fact k="Digest" title={g.codeSha256} testId="grader-digest">
          {shortDigest(g.codeSha256)}
        </Fact>
        <Fact k="Used by" testId="grader-used-by">
          {g.usedByCount}
        </Fact>
        <Fact k="Created">{g.createdAt.slice(0, 10)}</Fact>
        <Fact k="Author">{g.author ?? 'not recorded'}</Fact>
      </dl>
      {g.proof && (
        <p className="tma-body-sm" data-testid="grader-proof">
          Mutation proof: {g.proof.caught} of {g.proof.total} planted bugs caught.
        </p>
      )}
      {g.kind === 'judge' && (
        <section className="grd-box" data-testid="grader-judge">
          <h2 className="grd-caps">Judge</h2>
          <dl className="grd-box__rows">
            <dt>Model</dt>
            <dd className="tma-mono">{shownModel(g.judgeModelId)}</dd>
            <dt>TPR</dt>
            <dd>{pct(g.tpr)}</dd>
            <dt>TNR</dt>
            <dd>{pct(g.tnr)}</dd>
            {g.rubricSha256 && (
              <>
                <dt>Rubric</dt>
                <dd className="tma-mono" title={g.rubricSha256}>
                  {shortDigest(g.rubricSha256)}
                </dd>
              </>
            )}
            {g.calibration && (
              <>
                <dt>Labels</dt>
                <dd>
                  {g.calibration.nLabels} ({g.calibration.nTest} in the test split; tp {g.calibration.tp}, fn {g.calibration.fn}, tn {g.calibration.tn}, fp {g.calibration.fp})
                </dd>
              </>
            )}
          </dl>
          {STUDIO_SCREENS.S11.built && isKnownJudge(g.graderId) && (
            <Link to={`/studio/calibration/${encodeURIComponent(g.graderId)}?version=${encodeURIComponent(g.semver)}`} className="stu-link" data-testid="grader-calibration-link">
              Open this judge
            </Link>
          )}
        </section>
      )}
      <div className="grd-boxes">
        <section className="grd-box" aria-label="What it returns">
          <h2 className="grd-caps">What it returns</h2>
          <dl className="grd-box__rows">
            <dt>Verdict</dt>
            <dd>
              pass / fail
            </dd>
            <dt>Score</dt>
            <dd>
              a number, or none
            </dd>
            <dt>Version</dt>
            <dd className="tma-mono">
              {g.graderId}@{g.semver}
            </dd>
          </dl>
        </section>
        <section className="grd-box" aria-label="Where it lives">
          <h2 className="grd-caps">Where it lives</h2>
          <p className="tma-body-sm">
            The grader code stays in the eval repo. The result store keeps its digest <span className="grd-code">{shortDigest(g.codeSha256)}</span>, so this page
            cannot show the source, the runtime or the timeout.
          </p>
          {g.note && <p className="tma-body-sm tma-muted">Note: {g.note}</p>}
        </section>
      </div>
    </>
  )
}

function ProofTab({ g }: { g: GraderVersionDetail }) {
  if (g.kind === 'judge')
    return <StateBox title="Proven against labels" text="An AI judge is proven against human labels, not planted bugs. Its calibration is on the judge page." />
  if (!g.proof || g.proof.total === 0)
    return <StateBox title="No mutation proof yet" text="No planted-bug proof is recorded for this version. A grader we trust turns red on every planted bug." testId="grader-no-proof" />
  return (
    <div className="grd-tally" data-testid="grader-proof-tab">
      <span>
        <b>{g.proof.caught}</b>caught
      </span>
      <span>
        <b>{g.proof.total - g.proof.caught}</b>missed
      </span>
      <span>
        <b>{g.proof.total}</b>planted
      </span>
    </div>
  )
}

function VersionsTab({ g, versions }: { g: GraderVersionDetail; versions: GraderVersionItem[] }) {
  const list = versions.length ? versions : [g]
  return (
    <ul className="grd-runs" data-testid="grader-versions">
      {list.map((v) => (
        <li key={v.id} className="grd-run">
          <span className="grd-run__main">
            {v.id === g.id ? (
              <b>
                {v.graderId}@{v.semver}
              </b>
            ) : (
              <Link to={`/studio/graders/${v.id}`}>
                {v.graderId}@{v.semver}
              </Link>
            )}
          </span>
          <span className="grd-run__sub">
            {shortDigest(v.codeSha256)} · {v.createdAt.slice(0, 10)}
          </span>
          <span className="grd-run__verdict">{plural(v.usedByCount, 'result')}</span>
        </li>
      ))}
    </ul>
  )
}

/** The side panel: the latest gradings of this version, then the copy command and the dry run. */
function GradingsPanel({ g, serveUrl, dryRunEnabled }: { g: GraderVersionDetail; serveUrl?: string; dryRunEnabled?: boolean }) {
  const pass = g.recentRuns.filter((r) => r.pass).length
  return (
    <div className="grd-panel" data-testid="grader-recent-runs">
      <div className="grd-aside__head">
        <h2 className="grd-aside__title">Latest gradings</h2>
        <p className="grd-aside__sub">The last runs this version graded. Read only: nothing here grades or stores.</p>
      </div>
      {g.recentRuns.length === 0 ? (
        <p className="tma-body-sm tma-muted">No grading yet.</p>
      ) : (
        <>
          <div className="grd-tally" data-testid="grader-recent-tally">
            <span>
              <b className="grd-pass">{pass}</b>pass
            </span>
            <span>
              <b className="grd-fail">{g.recentRuns.length - pass}</b>fail
            </span>
          </div>
          <ul className="grd-runs">
            {g.recentRuns.map((r) => (
              <li key={`${r.runId}-${r.gradedAt}`} className="grd-run" data-testid="grader-recent-run">
                <span className="grd-run__main">
                  <Link to={r.evaluationId ? `/evaluations/${r.evaluationId}/runs/${r.runId}` : `/evaluations`} className="tma-mono">
                    run {r.runId.slice(0, 8)}
                  </Link>
                </span>
                <span className="grd-run__sub">
                  {r.caseId ? `case ${r.caseId.slice(0, 8)} · ` : ''}
                  {r.gradedAt.slice(0, 16).replace('T', ' ')}
                </span>
                <span className={`grd-run__verdict ${r.pass ? 'grd-pass' : 'grd-fail'}`}>{r.pass ? 'pass' : 'fail'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="grd-aside__actions">
        <div className="grd-full">
          <CopyCommand command={gradeCommand()} />
        </div>
      </div>
      <GraderDryRunPanel grader={`${g.graderId}@${g.semver}`} kind={g.kind} {...(serveUrl !== undefined ? { serveUrl } : {})} {...(dryRunEnabled !== undefined ? { enabled: dryRunEnabled } : {})} />
    </div>
  )
}

/** The main column of S10a (no page shell): head, tabs and the tab content. */
export function GraderDetailMain({ g, versions = [] }: { g: GraderVersionDetail; versions?: GraderVersionItem[] }) {
  const [tab, setTab] = useState<TabKey>('definition')
  const kind = g.kind as GroupKey
  const decide = decideOf(kind, g)
  const what = whatItChecks(g.graderId, g.note)
  const tabs: Array<{ key: TabKey; label: string; n?: string }> = [
    { key: 'definition', label: 'Definition' },
    { key: 'proof', label: 'Proof', n: g.proof && g.proof.total > 0 ? `${g.proof.caught}/${g.proof.total}` : undefined },
    { key: 'versions', label: 'Versions', n: String(Math.max(1, versions.length)) },
  ]
  return (
    <div className="grd-head" data-testid="grader-detail">
      <p className="stu-label grd-crumb">
        <Link to="/studio/graders" data-testid="graders-back">
          Graders
        </Link>{' '}
        / {groupTitle(kind)} / <span className="stu-text-2">{g.graderId}</span>
      </p>
      <div className="grd-title">
        <h1 className="tma-h1">{g.graderId}</h1>
        <span className="grd-pill">{g.kind}</span>
        <span className="grd-pill" title={`${g.graderId}@${g.semver}`}>
          v{g.semver}
        </span>
        <DecideMark d={{ ...decide, text: decide.title }} testId="grader-decide" />
      </div>
      <p className="grd-lead">{what ?? 'No description is recorded for this version. The definition lives in the eval repo.'}</p>
      <div className="grd-tabs" role="tablist" aria-label="Grader">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className="grd-tab" onClick={() => setTab(t.key)} data-testid={`grader-tab-${t.key}`}>
            {t.label}
            {t.n && <span className="grd-tab__n">{t.n}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="grd-head">
        {tab === 'definition' && <Definition g={g} />}
        {tab === 'proof' && <ProofTab g={g} />}
        {tab === 'versions' && <VersionsTab g={g} versions={versions} />}
      </div>
    </div>
  )
}

/** S10a content, main column and side panel (used by tests without the page shell). */
export function GraderDetailView({
  g,
  versions,
  serveUrl,
  dryRunEnabled,
}: {
  g: GraderVersionDetail
  versions?: GraderVersionItem[]
  /** Override of VITE_TMA_STUDIO_SERVE_URL (tests). */
  serveUrl?: string
  /** Override of VITE_TMA_STUDIO_DRY_RUN (tests). */
  dryRunEnabled?: boolean
}) {
  return (
    <>
      <GraderDetailMain g={g} versions={versions} />
      <GradingsPanel g={g} {...(serveUrl !== undefined ? { serveUrl } : {})} {...(dryRunEnabled !== undefined ? { dryRunEnabled } : {})} />
    </>
  )
}

export function GraderDetailPage() {
  const { id = '' } = useParams()
  const [s, setS] = useState<Loaded<GraderVersionDetail>>({ state: 'loading' })
  const [versions, setVersions] = useState<GraderVersionItem[]>([])
  useEffect(() => {
    let live = true
    setS({ state: 'loading' })
    getGraderVersion(id).then(
      (r) => {
        if (!live) return
        setS({ state: 'ready', data: r })
        listGraderVersions().then(
          (l) => live && setVersions(Array.isArray(l?.graderVersions) ? l.graderVersions.filter((v) => v.graderId === r.graderId && v.kind === r.kind) : []),
          () => undefined,
        )
      },
      (e) => live && setS(failedState(e)),
    )
    return () => {
      live = false
    }
  }, [id])
  const ready = s.state === 'ready'
  return (
    <LibraryShell testId="studio-grader-detail" asideLabel="Latest gradings" aside={ready ? <GradingsPanel g={s.data} /> : null}>
      {s.state === 'loading' && <p className="tma-body-sm tma-muted">Loading grader…</p>}
      {ready && <GraderDetailMain g={s.data} versions={versions} />}
      {s.state === 'unavailable' && <GraderEmpty text="The grader library is not available yet on this server." />}
      {s.state === 'not-found' && <GraderEmpty text="This grader version does not exist, or it is not yours to read." />}
      {s.state === 'error' && <p role="alert">{s.message}</p>}
      {!ready && s.state !== 'loading' && (
        <p className="tma-body-sm">
          <Link to="/studio/graders" data-testid="graders-back">
            All graders
          </Link>
        </p>
      )}
    </LibraryShell>
  )
}


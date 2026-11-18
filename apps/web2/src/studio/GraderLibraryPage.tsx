/**
 * S10 Grader library (plan 20261112-tma-c5-studio-area-web2, tasks C5-T5 and C5-RD-S10-S11). Read only.
 * Layout from the canvas artboard "S10-S11 Grader library + judge calibration": the graders grouped by kind (code graders,
 * AI judges, human labels), one row per grader with its newest version (type, version, proven, used by, can decide), and a
 * side panel for the selected row (what it checks, can it decide, the agreement bars of a judge, technical details).
 * Data: GET /grader-versions, then GET /grader-versions/:id for the newest version of each grader (proof and calibration).
 * A known judge of the review queue with no version yet still gets a row, so the AI judges group is never hidden.
 * Gaps against the artboard: "New grader" is not here (ADR-5: the studio writes nothing; a grader is added by a pull request
 * in the eval repo); "used by" counts graded results, not cases (the API has no per-case count).
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { InfoTip, TitleRow } from './chrome'
import { getGraderVersion, failedState, listGraderVersions, shortDigest, type GraderVersionDetail, type GraderVersionItem, type Loaded } from './graders'
import { GROUPS, TYPE_TEXT, decideOf, isDetail, libraryRows, newestOf, plural, provenText, whatItChecks, labelJudgeOf, type GroupKey, type LibraryRow } from './grader-library'
import { DecideMark, GroupHeading, HeadRow, LibraryShell, StateBox, TrustBox, TypeFilter } from './GraderLibraryParts'
import { shownModel } from './calibration'
import { JUDGES } from './review'

const ABOUT = 'A grader decides if a run passed. Code graders are exact. An AI judge may decide a score only after it agrees with human labels often enough. Every grader has a version and a content digest. Read only: a grader changes by a pull request in the eval repo.'
const PROVEN_TIP = 'We plant known bugs. A grader we can trust turns red on every one. AI judges are proven against human labels instead.'
export const LIBRARY_COLS = ['grader', 'type', 'version', 'proven', 'used by', 'can decide']

type Details = Record<string, GraderVersionDetail | null>

/** The detail page of a row: S11a for a known judge, S10a for every other grader version. */
export function rowHref(r: LibraryRow): string | null {
  if (r.kind === 'judge' && (JUDGES as readonly string[]).includes(r.graderId)) {
    const v = newestOf(r)
    return `/studio/calibration/${encodeURIComponent(r.graderId)}${v ? `?version=${encodeURIComponent(v.semver)}` : ''}`
  }
  const v = newestOf(r)
  return v ? `/studio/graders/${v.id}` : null
}

function LibraryLine({ r, d, on, onPick }: { r: LibraryRow; d: GraderVersionDetail | null; on: boolean; onPick: () => void }) {
  const v = newestOf(r)
  const href = v ? `/studio/graders/${v.id}` : rowHref(r)
  return (
    <div role="row" className={`grd-row${on ? ' grd-row--on' : ''}`} data-testid={`grader-row-${r.graderId}`} data-selected={on ? 'true' : undefined} onClick={onPick} onFocus={onPick}>
      <span role="cell" className="grd-cell">
        {href ? (
          <Link to={href} className="grd-name" data-testid="grader-link">
            {r.graderId}
          </Link>
        ) : (
          <span className="grd-name">{r.graderId}</span>
        )}
      </span>
      <span role="cell" className="grd-cell">{TYPE_TEXT[r.kind]}</span>
      <span role="cell" className="grd-cell grd-mono">
        {v ? (
          <>
            <span title={v.codeSha256}>
              {r.graderId}@{v.semver}
            </span>
            {r.versions.length > 1 && <span className="grd-more">+{r.versions.length - 1}</span>}
          </>
        ) : (
          'no version yet'
        )}
      </span>
      <span role="cell" className="grd-cell" data-testid="grader-proven">
        {provenText(r.kind, d)}
      </span>
      <span role="cell" className="grd-cell grd-cell--num">
        {v ? (
          <>
            <span data-testid="grader-used-by">{v.usedByCount}</span> {r.kind === 'human' ? (v.usedByCount === 1 ? 'label' : 'labels') : v.usedByCount === 1 ? 'result' : 'results'}
          </>
        ) : (
          '—'
        )}
      </span>
      <span role="cell" className="grd-cell">
        <DecideMark d={decideOf(r.kind, d, !!v)} testId="grader-decide" />
      </span>
    </div>
  )
}

/** The side panel: the selected grader. */
export function GraderPanel({ r, d }: { r: LibraryRow; d: GraderVersionDetail | null }) {
  const v = newestOf(r)
  const decide = decideOf(r.kind, d, !!v)
  const what = whatItChecks(r.graderId, d?.note)
  const href = rowHref(r)
  const reviewJudge = r.kind === 'judge' && (JUDGES as readonly string[]).includes(r.graderId) ? r.graderId : labelJudgeOf(r.graderId)
  return (
    <div className="grd-panel" data-testid="grader-panel" data-grader={r.graderId}>
      <div className="grd-aside__head">
        <span className="grd-eyebrow">{TYPE_TEXT[r.kind]}</span>
        <h2 className="grd-aside__title">{r.graderId}</h2>
      </div>
      <section className="stu-section" aria-label="What it checks">
        <h3 className="grd-caps">What it checks</h3>
        <p className="grd-prose" data-testid="grader-what">
          {what ?? 'No description is recorded for this version. The definition lives in the eval repo.'}
        </p>
      </section>
      <TrustBox d={decide} judge={r.kind === 'judge' ? { tpr: d?.tpr ?? null, tnr: d?.tnr ?? null } : undefined} />
      {v && (
        <details className="grd-details">
          <summary>Technical details</summary>
          <dl className="grd-kv">
            <dt>Version</dt>
            <dd className="grd-mono">
              {r.graderId}@{v.semver}
            </dd>
            <dt>Digest</dt>
            <dd className="grd-mono" title={v.codeSha256}>
              {shortDigest(v.codeSha256)}
            </dd>
            <dt>Versions</dt>
            <dd>{r.versions.length}</dd>
            <dt>Created</dt>
            <dd>{v.createdAt.slice(0, 10)}</dd>
            {d?.author && (
              <>
                <dt>Author</dt>
                <dd>{d.author}</dd>
              </>
            )}
            {r.kind === 'judge' && (
              <>
                <dt>Judge model</dt>
                <dd className="grd-mono">{shownModel(v.judgeModelId)}</dd>
              </>
            )}
            {d?.calibration && (
              <>
                <dt>Labels</dt>
                <dd>
                  {d.calibration.nTest} in the test split, {d.calibration.nLabels} in all
                </dd>
              </>
            )}
          </dl>
        </details>
      )}
      <div className="grd-aside__actions">
        {href && (
          <Link to={href} className="stu-btn stu-btn--primary" data-testid="grader-panel-open">
            Open details
          </Link>
        )}
        {reviewJudge && (
          <Link to={`/studio/review?judge=${encodeURIComponent(reviewJudge)}`} className="stu-btn stu-btn--secondary" data-testid="grader-panel-review">
            Label more runs
          </Link>
        )}
      </div>
    </div>
  )
}

export function GraderEmpty({ text }: { text: string }) {
  return <StateBox title="No grader versions yet" text={text} testId="graders-empty" />
}

/** The groups to show (the Type filter keeps one) and the selected row: the picked one, else the first. */
export function libraryView(items: GraderVersionItem[], type: GroupKey | null, sel: string | null) {
  const rows = libraryRows(items)
  const shown = type ? rows.filter((r) => r.kind === type) : rows
  const groups = GROUPS.map((g) => ({ ...g, rows: shown.filter((r) => r.kind === g.key) })).filter((g) => g.rows.length > 0)
  const ordered = groups.flatMap((g) => g.rows)
  return { groups, cur: ordered.find((r) => r.key === sel) ?? ordered[0] ?? null }
}

const detailOf = (details: Details, r: LibraryRow) => {
  const v = newestOf(r)
  return v ? details[v.id] ?? null : null
}

/** The grouped list. The page holds the selection (`sel`, `onSel`) and shows the selected row in its side panel. */
export function GraderLibraryView({ items, details = {}, type = null, sel = null, onSel }: { items: GraderVersionItem[]; details?: Details; type?: GroupKey | null; sel?: string | null; onSel?: (key: string) => void }) {
  const [own, setOwn] = useState<string | null>(null)
  const { groups, cur } = useMemo(() => libraryView(items, type, onSel ? sel : own), [items, type, sel, own, onSel])
  if (items.length === 0) return <GraderEmpty text="A grader version appears here when a result that it graded is uploaded with the tma command." />
  const pick = onSel ?? setOwn
  return (
    <div className="grd-tablewrap">
      <div role="table" aria-label="Grader library" className="grd-table" data-testid="grader-table">
        <HeadRow cols={LIBRARY_COLS} tips={{ proven: PROVEN_TIP }} />
        {groups.map((g) => (
          <div role="rowgroup" key={g.key}>
            <GroupHeading group={g.key} count={g.rows.length} />
            {g.rows.map((r) => (
              <LibraryLine key={r.key} r={r} d={detailOf(details, r)} on={cur?.key === r.key} onPick={() => pick(r.key)} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

async function loadLibrary(): Promise<{ items: GraderVersionItem[]; details: Details }> {
  const r = await listGraderVersions()
  const items = Array.isArray(r?.graderVersions) ? r.graderVersions : []
  const newest = libraryRows(items)
    .map(newestOf)
    .filter((v): v is GraderVersionItem => v !== null)
  const got = await Promise.all(
    newest.map((v) =>
      getGraderVersion(v.id).then(
        (d) => [v.id, isDetail(d) ? d : null] as const,
        () => [v.id, null] as const,
      ),
    ),
  )
  return { items, details: Object.fromEntries(got) }
}

const TYPE_PARAM: Record<string, GroupKey> = { code: 'code', human: 'human' }

export function GraderLibraryPage() {
  const [params] = useSearchParams()
  const type = TYPE_PARAM[params.get('type') ?? ''] ?? null
  const [s, setS] = useState<Loaded<{ items: GraderVersionItem[]; details: Details }>>({ state: 'loading' })
  const [sel, setSel] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    loadLibrary().then(
      (data) => live && setS({ state: 'ready', data }),
      (e) => live && setS(failedState(e)),
    )
    return () => {
      live = false
    }
  }, [])
  const cur = s.state === 'ready' && s.data.items.length > 0 ? libraryView(s.data.items, type, sel).cur : null
  return (
    <LibraryShell testId="studio-graders" asideLabel="Selected grader" aside={cur && s.state === 'ready' ? <GraderPanel r={cur} d={detailOf(s.data.details, cur)} /> : null}>
      <p className="stu-label grd-crumb">
        <Link to="/studio">Studio</Link> / graders
      </p>
      <TitleRow tip={<InfoTip label="About graders" text={ABOUT} />} actions={
        <TypeFilter
          items={[
            { label: 'all', to: '/studio/graders', on: type === null },
            { label: 'code', to: '/studio/graders?type=code', on: type === 'code' },
            { label: 'AI judges', to: '/studio/calibration', on: false, testId: 'graders-calibration-link' },
            { label: 'human labels', to: '/studio/graders?type=human', on: type === 'human' },
          ]}
        />
      }>
        <h1 className="tma-h1">Graders</h1>
      </TitleRow>
      {s.state === 'loading' && <p className="tma-body-sm tma-muted">Loading graders…</p>}
      {s.state === 'ready' && <GraderLibraryView items={s.data.items} details={s.data.details} type={type} sel={sel} onSel={setSel} />}
      {(s.state === 'unavailable' || s.state === 'not-found') && <GraderEmpty text="The grader library is not available yet on this server." />}
      {s.state === 'error' && <p role="alert">{s.message}</p>}
      {s.state === 'ready' && <p className="stu-gap">{plural(s.data.items.length, 'grader version')} in this account. The grader code stays in the eval repo; this page shows its digest.</p>}
    </LibraryShell>
  )
}

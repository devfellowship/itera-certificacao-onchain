/**
 * S9 Trajectory wall and path map (plan 20261112-tma-c5-studio-area-web2, task C5-T9 and UI-S2S3S9; plan
 * 20261112-tma-c9-trajectory-analytics ADR-6, Q-T20 = A). TMA runs only: the public hosted runs plus the caller's own
 * runs (GET /trajectories). No fleet run; the fleet-wide wall is a link to Decision Graph analytics (FLEET_WALL_URL).
 *
 *   wall      one row per run, one cell per step colored by its letter (legend from trajectory-shapes/spec.json), an end
 *             cell for how the run ended, the first failed step outlined; rows longest first inside a band; a row links
 *             to the canonical run page /evaluations/:eid/runs/:runId.
 *   path map  the spec's pruned prefix tree (trunk + branches) with n and pass rate per node.
 *
 * Shapes: while the spec's named_shapes is false (gate C9-T2 failed, fallback wall-only) no run is labeled by shape and a
 * note says why; the wall then groups its rows by how the run ended (pass, fail, ...), which is real data. When a spec
 * bump sets named_shapes to true, the wall groups its rows into one band per shape (the API sends `shape` then). Read
 * only (Q-T18 = A): no Save and no Run control. The `data` and `spec` props are test seams.
 * Query filters pass through to the API: ?agent=, ?task=, ?origin=.
 *
 * Layout from the canvas artboard "S9 Trajectory anatomy": the legend, the filter row, the bands with one thin row per
 * run on a shared step axis, and a label per band (name, runs, pass rate, step range). Gaps against the artboard (the
 * API has no such field or parameter): the use case, agent, outcome, length and sort dropdowns, the 30 day window, and
 * the shape names (the spec says named_shapes is false). The origin filter is the one the API supports.
 */
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { FLEET_WALL_URL } from '../config'
import { Card } from '../tma/ui'
import { InfoTip } from './TraceParts'
import { Toggle, ToggleItem, themeClass } from './theme'
import {
  SHAPES_SPEC,
  axisTicks,
  bandStats,
  endTone,
  listTrajectories,
  pathTree,
  rateTone,
  rowHeight,
  runHref,
  sortRuns,
  wallGroups,
  wallWidth,
  type PathTreeNode,
  type ShapesSpecView,
  type TrajectoriesResponse,
  type TrajectoryRun,
  type WallGroup,
} from './trajectories'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'
import './trajectories.css'

const LETTERS = ['R', 'S', 'W', 'T', 'M', 'X'] as const
const ABOUT = 'The steps of TMA runs: public hosted runs and your own uploaded runs. Each row is one run, each cell one step. Read only.'

export function KindLegend({ spec }: { spec: ShapesSpecView }) {
  return (
    <ul className="s9-legend" data-testid="s9-legend">
      {LETTERS.map((l) => (
        <li key={l}>
          <span className={`s9-key s9-k-${l}`} aria-hidden="true">
            {l}
          </span>{' '}
          {spec.alphabet[l] ?? ''}
        </li>
      ))}
      <li className="s9-legend__end">
        <span className="s9-key s9-end-pass" aria-hidden="true">
          ✓
        </span>{' '}
        end: pass
      </li>
      <li>
        <span className="s9-key s9-end-fail" aria-hidden="true">
          ✗
        </span>{' '}
        end: fail
      </li>
    </ul>
  )
}

const STATUS_TEXT: Record<string, string> = { pass: 'pass', fail: 'fail' }

function WallRow({ run, max }: { run: TrajectoryRun; max: number }) {
  const href = runHref(run)
  const status = STATUS_TEXT[run.status] ?? run.status
  const origin = run.resultOrigin === 'hosted' ? 'hosted' : 'uploaded'
  const label = `${status} · ${run.steps} ${run.steps === 1 ? 'step' : 'steps'} · ${origin}`
  const body = (
    <>
      <span className="s9-sr" data-testid="s9-status">
        {status}
      </span>
      <span className="s9-cells" data-testid="s9-cells">
        {[...run.kinds].map((l, i) => (
          <span
            key={i}
            className={`s9-cell s9-k-${l}${i === run.firstFailure ? ' s9-cell--first-fail' : ''}`}
            data-kind={l}
            data-first-failure={i === run.firstFailure ? 'true' : undefined}
            title={`step ${i + 1}: ${SHAPES_SPEC.alphabet[l] ?? l}${i === run.firstFailure ? ' (first failure)' : ''}`}
          />
        ))}
        {run.truncated && (
          <span className="s9-more" title={`${run.steps - run.kinds.length} more steps`}>
            …
          </span>
        )}
        <span className={`s9-cell-end s9-end-${endTone(run.status)}`} data-end={endTone(run.status)} aria-hidden="true" />
      </span>
      <span className={`s9-endcell s9-end-${endTone(run.status)}`} aria-hidden="true" />
      <span className="s9-sr">{` ${run.steps} ${run.steps === 1 ? 'step' : 'steps'}, ${origin}`}</span>
    </>
  )
  const style = { ['--s9-max' as string]: max }
  return href ? (
    <Link to={href} className="s9-row" style={style} data-testid="s9-row" data-run-id={run.id} data-status={run.status} title={label}>
      {body}
    </Link>
  ) : (
    <div className="s9-row" style={style} data-testid="s9-row" data-run-id={run.id} data-status={run.status} title={`${label} · This run has no evaluation page.`}>
      {body}
    </div>
  )
}

function Axis({ max }: { max: number }) {
  return (
    <div className="s9-axis" aria-hidden="true">
      <span className="s9-axis__ticks">
        {axisTicks(max).map((t) => (
          <span key={t} className="s9-axis__tick" style={{ ['--t' as string]: t - 1 }}>
            step {t}
          </span>
        ))}
        <span className="s9-axis__end">end</span>
      </span>
    </div>
  )
}

function BandLabel({ g }: { g: WallGroup }) {
  const s = bandStats(g.runs)
  const tone = g.kind === 'shape' ? rateTone(s.passRate) : g.key === 'pass' ? 'ok' : g.key === 'fail' ? 'bad' : 'warn'
  return (
    <div className={`s9-band__label s9-band__label--${tone}`}>
      <h2 className="s9-band__name">{g.label}</h2>
      <p className="stu-label s9-band__line">
        {s.n} {s.n === 1 ? 'run' : 'runs'}
        {g.kind === 'shape' && (
          <>
            {' · '}
            <span className={`stu-${tone}`}>{Math.round(s.passRate * 100)}% pass</span>
          </>
        )}
      </p>
      <p className="stu-label s9-band__steps">{s.minSteps === s.maxSteps ? `${s.maxSteps} ${s.maxSteps === 1 ? 'step' : 'steps'}` : `${s.minSteps}-${s.maxSteps} steps`}</p>
    </div>
  )
}

function Band({ g, max, dense }: { g: WallGroup; max: number; dense: boolean }) {
  const rh = rowHeight(g.runs.length)
  return (
    <section
      className="s9-band"
      data-testid={g.kind === 'shape' ? 's9-band' : 's9-group'}
      data-shape={g.kind === 'shape' ? g.key : undefined}
      data-outcome={g.kind === 'outcome' ? g.key : undefined}
      style={{ ['--s9-rh' as string]: `${dense ? rh : 14}px` }}
    >
      <div className="s9-rows">
        {g.runs.map((r) => (
          <WallRow key={r.id} run={r} max={max} />
        ))}
      </div>
      <BandLabel g={g} />
    </section>
  )
}

export function TrajectoryWall({ runs, spec = SHAPES_SPEC }: { runs: readonly TrajectoryRun[]; spec?: ShapesSpecView }) {
  const [dense, setDense] = useState(true)
  const groups = wallGroups(sortRuns(runs), spec)
  const max = wallWidth(runs)
  return (
    <div className="s9-wall" data-testid="s9-wall">
      <div className="s9-wall__head">
        <h2 className="s9-wall__title">Trajectory wall</h2>
        <span className="stu-label" data-testid="s9-count">
          {runs.length} {runs.length === 1 ? 'run' : 'runs'}
        </span>
        <Toggle label="Row height" className="s9-density">
          <ToggleItem on={dense} onClick={() => setDense(true)}>
            Compact
          </ToggleItem>
          <ToggleItem on={!dense} onClick={() => setDense(false)}>
            Comfortable
          </ToggleItem>
        </Toggle>
      </div>
      <KindLegend spec={spec} />
      {!spec.named_shapes && (
        <p className="stu-label" data-testid="s9-no-shapes">
          Runs are grouped by how they ended. Shape names show when enough runs share a shape.
        </p>
      )}
      <div className="s9-chart">
        <div className="s9-chart__in" style={{ ['--s9-max' as string]: max }}>
          {groups.map((g) => (
            <Band key={g.key} g={g} max={max} dense={dense} />
          ))}
          <Axis max={max} />
        </div>
      </div>
    </div>
  )
}

function PathNode({ node, parentPath }: { node: PathTreeNode; parentPath: string }) {
  const letter = node.path.slice(-1)
  const trunk = node.children.length === 1
  const tone = rateTone(node.passRate)
  return (
    <li className={trunk ? 's9-node s9-node--trunk' : 's9-node'}>
      <span className="s9-node-label" data-testid="s9-path-node" data-path={node.path} data-n={node.n}>
        <span className={`s9-key s9-k-${letter}`} aria-hidden="true">
          {letter}
        </span>{' '}
        <span className="s9-node-path" title={node.path}>
          <span className="stu-label">{parentPath}</span>
          {letter}
        </span>{' '}
        <span className="stu-label">
          · {node.n} {node.n === 1 ? 'run' : 'runs'} · <span className={`stu-${tone}`}>{Math.round(node.passRate * 100)}% pass</span>
        </span>
      </span>
      {node.children.length > 0 && (
        <ul className="s9-tree">
          {node.children.map((c) => (
            <PathNode key={c.path} node={c} parentPath={node.path} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function PathMap({ pathMap }: { pathMap: TrajectoriesResponse['pathMap'] }) {
  const roots = pathTree(pathMap.nodes, pathMap.edges)
  return (
    <section className="s9-map" data-testid="s9-path-map">
      <div className="s9-wall__head">
        <h2 className="s9-wall__title">Path map</h2>
        <span className="stu-label">
          {pathMap.nodes.length} nodes of {pathMap.totalRuns} runs
        </span>
      </div>
      <p className="tma-body-sm tma-muted">Repeated steps are collapsed into one node. A node is kept when enough runs share it (trajectory-shapes/1 prune rules).</p>
      {roots.length === 0 ? (
        <p className="tma-body-sm tma-muted" data-testid="s9-path-empty">
          No path is shared by enough runs yet.
        </p>
      ) : (
        <ul className="s9-tree s9-tree--root">
          {roots.map((n) => (
            <PathNode key={n.path} node={n} parentPath="" />
          ))}
        </ul>
      )}
    </section>
  )
}

export function FleetWallLink() {
  return (
    <a href={FLEET_WALL_URL} target="_blank" rel="noreferrer" data-testid="s9-fleet-link">
      Fleet-wide wall
    </a>
  )
}

export function TrajectoriesView({ data, spec = SHAPES_SPEC }: { data: TrajectoriesResponse; spec?: ShapesSpecView }) {
  if (data.runs.length === 0) {
    return (
      <Card pad data-testid="s9-empty">
        <span className="tma-label">No runs yet</span>
        <p className="tma-body-sm tma-muted">A run appears here when a public evaluation is issued, or when you upload a result with the tma command.</p>
      </Card>
    )
  }
  return (
    <div className="s9-groups">
      <TrajectoryWall runs={data.runs} spec={spec} />
      {data.truncated && (
        <p className="stu-label" data-testid="s9-truncated">
          Showing the newest {data.limit} runs.
        </p>
      )}
      <PathMap pathMap={data.pathMap} />
    </div>
  )
}

const ORIGINS: Array<[string | null, string]> = [
  [null, 'all'],
  ['hosted', 'hosted'],
  ['self_declared', 'uploaded'],
]

function OriginFilter({ params }: { params: URLSearchParams }) {
  const current = params.get('origin')
  return (
    <div className="s9-filters" data-testid="s9-filters">
      <span className="stu-label">origin</span>
      {ORIGINS.map(([v, label]) => {
        const on = (v ?? null) === (current ?? null)
        const p = new URLSearchParams(params)
        if (v) p.set('origin', v)
        else p.delete('origin')
        const q = p.toString()
        return (
          <Link key={label} to={`/studio/trajectories${q ? `?${q}` : ''}`} className={`stu-chip stu-chip--sm${on ? ' stu-chip--on' : ''}`} aria-current={on ? 'true' : undefined} data-origin={v ?? 'all'}>
            {label}
          </Link>
        )
      })}
    </div>
  )
}

export function StudioTrajectoriesPage({ data, spec }: { data?: TrajectoriesResponse; spec?: ShapesSpecView }) {
  const [params] = useSearchParams()
  const query = { agent: params.get('agent'), task: params.get('task'), origin: params.get('origin') }
  const loaded = useStudioLoad(data ? null : () => listTrajectories(query), [data ? 'prop' : 'api', query.agent, query.task, query.origin])
  const shown = data ?? (loaded.state === 'ok' ? loaded.data : null)
  return (
    <main className={themeClass('tma-page', 's9-page')} data-testid="studio-trajectories">
      <div className="s9-head">
        <p className="stu-label">
          <Link to="/studio">Studio</Link> / trajectories
        </p>
        <div className="s9-title">
          <h1 className="tma-h1">Trajectories</h1>
          <InfoTip label="About trajectories" text={ABOUT} />
          <span className="s9-fleet">
            This wall shows TMA runs only. <FleetWallLink />
          </span>
        </div>
      </div>
      <OriginFilter params={params} />
      {shown ? (
        <TrajectoriesView data={shown} spec={spec} />
      ) : loaded.state === 'error' ? (
        <Card pad data-testid="s9-empty">
          <span className="tma-label">No trajectories</span>
          <p className="tma-body-sm tma-muted" data-testid="s9-load-error">
            {loaded.status === 503 ? 'Trajectories are not available yet: the step kinds are not migrated on this server.' : loadErrorText(loaded.status)}
          </p>
        </Card>
      ) : (
        <Card pad data-testid="s9-loading">
          <span className="tma-body-sm tma-muted">Loading trajectories…</span>
        </Card>
      )}
    </main>
  )
}

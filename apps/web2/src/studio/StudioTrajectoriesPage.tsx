/**
 * S9 Trajectory wall and path map (plan 20261112-tma-c5-studio-area-web2, task C5-T9; plan
 * 20261112-tma-c9-trajectory-analytics ADR-6, Q-T20 = A). TMA runs only: the public hosted runs plus the caller's own
 * runs (GET /trajectories). No fleet run; the fleet-wide wall is a link to Decision Graph analytics (FLEET_WALL_URL).
 *
 *   wall      one row per run, one cell per step colored by its letter (legend from trajectory-shapes/spec.json),
 *             rows sorted by status then length, a pass/fail marker, the first failed step outlined; a row links to
 *             the canonical run page /evaluations/:eid/runs/:runId.
 *   path map  the spec's pruned prefix tree (trunk + branches) with n and pass rate per node.
 *
 * Shapes: while the spec's named_shapes is false (gate C9-T2 failed, fallback wall-only) no run is labeled by shape
 * and a note says why. When a spec bump sets it to true, the wall groups its rows into one band per shape (the API
 * sends `shape` then). Read only (Q-T18 = A): no Save and no Run control. The `data` and `spec` props are test seams.
 * Query filters pass through to the API: ?agent=, ?task=, ?origin=.
 */
import { Link, useSearchParams } from 'react-router-dom'
import { FLEET_WALL_URL } from '../config'
import { Card, CardHeader } from '../tma/ui'
import {
  SHAPES_SPEC,
  listTrajectories,
  pathTree,
  runHref,
  shapeBands,
  sortRuns,
  type PathTreeNode,
  type ShapesSpecView,
  type TrajectoriesResponse,
  type TrajectoryRun,
} from './trajectories'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'

const LETTERS = ['R', 'S', 'W', 'T', 'M', 'X'] as const

export function KindLegend({ spec }: { spec: ShapesSpecView }) {
  return (
    <ul className="s9-legend" data-testid="s9-legend">
      {LETTERS.map((l) => (
        <li key={l}>
          <span className={`s9-cell s9-k-${l}`} aria-hidden="true" /> <span className="tma-mono">{l}</span> {spec.alphabet[l] ?? ''}
        </li>
      ))}
    </ul>
  )
}

function WallRow({ run }: { run: TrajectoryRun }) {
  const href = runHref(run)
  const pass = run.status === 'pass'
  const body = (
    <>
      <span className={`s9-marker ${pass ? 's9-marker--pass' : 's9-marker--fail'}`} data-testid="s9-status" title={run.status}>
        {pass ? 'pass' : run.status === 'fail' ? 'fail' : run.status}
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
        {run.truncated && <span className="tma-muted s9-more">…{run.steps - run.kinds.length} more</span>}
      </span>
      <span className="tma-muted tma-mono s9-meta">
        {run.steps} {run.steps === 1 ? 'step' : 'steps'} · {run.resultOrigin === 'hosted' ? 'hosted' : 'uploaded'}
      </span>
    </>
  )
  return href ? (
    <Link to={href} className="s9-row" data-testid="s9-row" data-run-id={run.id} data-status={run.status}>
      {body}
    </Link>
  ) : (
    <div className="s9-row" data-testid="s9-row" data-run-id={run.id} data-status={run.status} title="This run has no evaluation page.">
      {body}
    </div>
  )
}

export function TrajectoryWall({ runs, spec = SHAPES_SPEC }: { runs: readonly TrajectoryRun[]; spec?: ShapesSpecView }) {
  const sorted = sortRuns(runs)
  return (
    <Card data-testid="s9-wall">
      <CardHeader title="Trajectory wall" meta={`${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`} />
      <div className="stu-pad">
        <KindLegend spec={spec} />
        {spec.named_shapes ? (
          shapeBands(sorted, spec).map((b) => (
            <section key={b.shape} className="s9-band" data-testid="s9-band" data-shape={b.shape}>
              <h2 className="stu-subtype">
                {b.shape} <span className="tma-muted">({b.runs.length})</span>
              </h2>
              {b.runs.map((r) => (
                <WallRow key={r.id} run={r} />
              ))}
            </section>
          ))
        ) : (
          <>
            <p className="tma-body-sm tma-muted" data-testid="s9-no-shapes">
              Runs are not labeled by shape: not enough runs to name shapes; see plan C5-T8.
            </p>
            <div className="s9-rows">
              {sorted.map((r) => (
                <WallRow key={r.id} run={r} />
              ))}
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

function PathNode({ node, parentPath }: { node: PathTreeNode; parentPath: string }) {
  const letter = node.path.slice(-1)
  const trunk = node.children.length === 1
  return (
    <li className={trunk ? 's9-node s9-node--trunk' : 's9-node'}>
      <span className="s9-node-label" data-testid="s9-path-node" data-path={node.path} data-n={node.n}>
        <span className={`s9-cell s9-k-${letter}`} aria-hidden="true" />{' '}
        <span className="tma-mono" title={node.path}>
          <span className="tma-muted">{parentPath}</span>
          {letter}
        </span>{' '}
        <span className="tma-muted">
          · {node.n} {node.n === 1 ? 'run' : 'runs'} · {Math.round(node.passRate * 100)}% pass
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
    <Card data-testid="s9-path-map">
      <CardHeader title="Path map" meta={`${pathMap.nodes.length} nodes of ${pathMap.totalRuns} runs`} />
      <div className="stu-pad">
        <p className="tma-body-sm tma-muted">
          Repeated steps are collapsed into one node. A node is kept when enough runs share it (trajectory-shapes/1 prune rules).
        </p>
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
      </div>
    </Card>
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
    <div className="stu-groups">
      <TrajectoryWall runs={data.runs} spec={spec} />
      {data.truncated && (
        <p className="tma-body-sm tma-muted" data-testid="s9-truncated">
          Showing the newest {data.limit} runs.
        </p>
      )}
      <PathMap pathMap={data.pathMap} />
    </div>
  )
}

export function StudioTrajectoriesPage({ data, spec }: { data?: TrajectoriesResponse; spec?: ShapesSpecView }) {
  const [params] = useSearchParams()
  const query = { agent: params.get('agent'), task: params.get('task'), origin: params.get('origin') }
  const loaded = useStudioLoad(data ? null : () => listTrajectories(query), [data ? 'prop' : 'api', query.agent, query.task, query.origin])
  const shown = data ?? (loaded.state === 'ok' ? loaded.data : null)
  return (
    <main className="tma-page" data-testid="studio-trajectories">
      <div className="stu-head">
        <p className="tma-body-sm">
          <Link to="/studio">Studio</Link> / trajectories
        </p>
        <h1 className="tma-h1">Trajectories</h1>
        <p className="stu-sub">The steps of TMA runs: public hosted runs and your own uploaded runs. Read only.</p>
        <p className="tma-body-sm">
          This wall shows TMA runs only. <FleetWallLink />
        </p>
      </div>
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

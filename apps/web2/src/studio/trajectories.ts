/**
 * Types, call and pure helpers of studio S9, the trajectory wall and path map (plan 20261112-tma-c5-studio-area-web2,
 * C5-T9). Data: GET /trajectories (TMA runs only: public hosted runs + the caller's own runs).
 * The rules (step-kind letters, kind string, first failure, path-map prune) run on the API through
 * packages/contracts/trajectory-shapes.js; this module only reads the spec for the legend, the named_shapes flag and
 * the band order. It never computes a shape: while named_shapes is false nothing labels a run by shape.
 */
import specJson from '@itera/contracts/trajectory-shapes/spec.json'
import { request } from '../lib/api'

export type RunStatus = 'pass' | 'fail' | 'timeout' | 'invalid' | 'infra_error'

export interface TrajectoryRun {
  id: string
  evaluationId: string | null
  agentId: string | null
  status: RunStatus
  resultOrigin: 'hosted' | 'self_declared'
  /** One letter per step (R S W T M X), cut at the spec's max_chars. */
  kinds: string
  truncated: boolean
  steps: number
  /** 0-based index of the first failed step, or null. */
  firstFailure: number | null
  /** Sent by the API only while the spec's named_shapes is true. */
  shape?: string
}

export interface PathMapNode {
  path: string
  n: number
  pass: number
  passRate: number
}

export interface TrajectoriesResponse {
  schema: string
  namedShapes: boolean
  fallback: string
  runs: TrajectoryRun[]
  pathMap: { totalRuns: number; nodes: PathMapNode[]; edges: Array<{ from: string; to: string }> }
  limit: number
  truncated: boolean
}

/** The part of trajectory-shapes/spec.json that the screen reads. */
export interface ShapesSpecView {
  schema: string
  alphabet: Record<string, string>
  named_shapes: boolean
  fallback: string
  shape_rules: Array<{ name: string }>
  empty_shape: string
}

export const SHAPES_SPEC: ShapesSpecView = specJson as ShapesSpecView

export type TrajectoriesQuery = { agent?: string | null; task?: string | null; origin?: string | null; limit?: number | null }

export const listTrajectories = (q: TrajectoriesQuery = {}) => request<TrajectoriesResponse>('/trajectories', { query: q })

const STATUS_ORDER: RunStatus[] = ['pass', 'fail', 'timeout', 'invalid', 'infra_error']

/** Wall order: status (pass, fail, timeout, invalid, infra_error), then step count, then id. */
export function sortRuns(runs: readonly TrajectoryRun[]): TrajectoryRun[] {
  const rank = (s: RunStatus) => {
    const i = STATUS_ORDER.indexOf(s)
    return i < 0 ? STATUS_ORDER.length : i
  }
  return [...runs].sort((a, b) => rank(a.status) - rank(b.status) || a.steps - b.steps || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The canonical run page, or null when the run has no evaluation. */
export function runHref(r: Pick<TrajectoryRun, 'id' | 'evaluationId'>): string | null {
  return r.evaluationId ? `/evaluations/${encodeURIComponent(r.evaluationId)}/runs/${encodeURIComponent(r.id)}` : null
}

/** Bands of the wall, only while the spec names shapes: spec rule order, then the empty shape, then anything else. */
export function shapeBands(runs: readonly TrajectoryRun[], spec: ShapesSpecView): Array<{ shape: string; runs: TrajectoryRun[] }> {
  const order = [...spec.shape_rules.map((r) => r.name), spec.empty_shape]
  const by = new Map<string, TrajectoryRun[]>()
  for (const r of runs) {
    const key = r.shape ?? spec.empty_shape
    by.set(key, [...(by.get(key) ?? []), r])
  }
  const rank = (s: string) => {
    const i = order.indexOf(s)
    return i < 0 ? order.length : i
  }
  return [...by].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([shape, list]) => ({ shape, runs: list }))
}

export interface PathTreeNode extends PathMapNode {
  depth: number
  children: PathTreeNode[]
}

/** The path-map nodes as a tree (roots = depth-1 paths), children by count then path. */
export function pathTree(nodes: readonly PathMapNode[], edges: ReadonlyArray<{ from: string; to: string }>): PathTreeNode[] {
  const byPath = new Map<string, PathTreeNode>(nodes.map((n) => [n.path, { ...n, depth: n.path.length, children: [] }]))
  const hasParent = new Set<string>()
  for (const e of edges) {
    const parent = byPath.get(e.from)
    const child = byPath.get(e.to)
    if (parent && child) {
      parent.children.push(child)
      hasParent.add(e.to)
    }
  }
  const order = (a: PathTreeNode, b: PathTreeNode) => b.n - a.n || (a.path < b.path ? -1 : 1)
  for (const n of byPath.values()) n.children.sort(order)
  return [...byPath.values()].filter((n) => !hasParent.has(n.path)).sort(order)
}

// ---------- Layout helpers of the S9 wall (UI-S2S3S9; canvas artboard "S9 Trajectory anatomy") ----------

/** How a run ended on the wall's end strip: green pass, red fail, amber for a timeout or an error. */
export type EndTone = 'pass' | 'fail' | 'other'
export const endTone = (s: RunStatus): EndTone => (s === 'pass' ? 'pass' : s === 'fail' ? 'fail' : 'other')

/** Longest first, then id: the order of the rows inside a band. */
export function longestFirst(runs: readonly TrajectoryRun[]): TrajectoryRun[] {
  return [...runs].sort((a, b) => b.steps - a.steps || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export interface WallGroup {
  key: string
  /** `shape` bands exist only while the spec names shapes; `outcome` groups are the fallback (the status is real data). */
  kind: 'shape' | 'outcome'
  label: string
  runs: TrajectoryRun[]
}

const OUTCOME_LABEL: Record<RunStatus, string> = { pass: 'Passed', fail: 'Failed', timeout: 'Timed out', invalid: 'Invalid', infra_error: 'Infra error' }

/** The wall's bands: one per shape when the spec names shapes, else one per outcome (pass, fail, ...). Runs longest first. */
export function wallGroups(runs: readonly TrajectoryRun[], spec: ShapesSpecView): WallGroup[] {
  if (spec.named_shapes) return shapeBands(runs, spec).map((b) => ({ key: b.shape, kind: 'shape', label: b.shape, runs: longestFirst(b.runs) }))
  const by = new Map<RunStatus, TrajectoryRun[]>()
  for (const r of runs) by.set(r.status, [...(by.get(r.status) ?? []), r])
  const rank = (s: RunStatus) => {
    const i = STATUS_ORDER.indexOf(s)
    return i < 0 ? STATUS_ORDER.length : i
  }
  return [...by].sort(([a], [b]) => rank(a) - rank(b)).map(([s, list]) => ({ key: s, kind: 'outcome', label: OUTCOME_LABEL[s] ?? s, runs: longestFirst(list) }))
}

export interface BandStats {
  n: number
  /** 0..1 */
  passRate: number
  minSteps: number
  maxSteps: number
}

export function bandStats(runs: readonly TrajectoryRun[]): BandStats {
  const steps = runs.map((r) => r.steps)
  return {
    n: runs.length,
    passRate: runs.length ? runs.filter((r) => r.status === 'pass').length / runs.length : 0,
    minSteps: steps.length ? Math.min(...steps) : 0,
    maxSteps: steps.length ? Math.max(...steps) : 0,
  }
}

/** The step count of the widest row on the wall (the shared x scale of every band). At least 1. */
export const wallWidth = (runs: readonly TrajectoryRun[]): number => Math.max(1, ...runs.map((r) => r.kinds.length))

/** Axis ticks (1-based step numbers): 1, then every 5, 10, 20, 50 or 100 steps, at most 9 ticks. */
export function axisTicks(max: number): number[] {
  const step = [5, 10, 20, 50, 100].find((s) => max / s <= 8) ?? 100
  const ticks = [1]
  for (let t = step; t <= max; t += step) ticks.push(t)
  return ticks
}

/** Row height in px of a band: 3 to 8 px, so a band stays near 320 px tall. */
export const rowHeight = (n: number): number => Math.min(8, Math.max(3, Math.floor(320 / Math.max(1, n))))

/** The pass rate as a tone: 80% and up is good, 50% and up needs a look, below that is bad. */
export const rateTone = (rate: number): 'ok' | 'warn' | 'bad' => (rate >= 0.8 ? 'ok' : rate >= 0.5 ? 'warn' : 'bad')

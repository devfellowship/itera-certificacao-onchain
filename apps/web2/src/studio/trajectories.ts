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

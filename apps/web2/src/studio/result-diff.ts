/**
 * S7 result diff (plan 20261112-tma-c5-studio-area-web2, task C5-T4). Pure: no React, no network.
 *
 * Which pair of runs S7 shows, from its query:
 *   ?baseRun=<run id>&run=<run id>                  the two runs, as given;
 *   ?case=<case id>&base=<variant id>&variant=<id>  the newest counted run of each variant on that case;
 *   ?evaluation=<evaluation id>                     the "Compare with baseline" link of /evaluations/:eid: the run of
 *                                                   that evaluation against the newest counted run of the case baseline.
 * Rows per data type group the run artifacts (artifacts.ts of the run page) by their kind. The steps come from
 * step-alignment.ts; its `none` row reads as `removed` (base only) or `inserted` (variant only).
 */
import type { EvalRun, RunAction } from '../lib/api/types'
import type { Artifact, ArtifactKind } from '../pages/run-artifacts/artifacts'
import type { AlignableStep, AlignmentRow } from '../tma/compare/step-alignment'
import { isInfraFailure } from './experiment-matrix'

export type DiffQuery = { baseRun: string | null; run: string | null; caseId: string | null; base: string | null; variant: string | null; evaluation: string | null }

export function diffQueryOf(p: URLSearchParams): DiffQuery {
  const one = (k: string) => p.get(k) || null
  return { baseRun: one('baseRun'), run: one('run'), caseId: one('case'), base: one('base'), variant: one('variant'), evaluation: one('evaluation') }
}

/** The newest run of a variant on a case; a run with a platform fault only when there is no other. */
export function newestRunOf(runs: EvalRun[], caseId: string, variantId: string): EvalRun | null {
  const mine = runs.filter((r) => r.caseId === caseId && r.variant.id === variantId).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || (b.seq ?? 0) - (a.seq ?? 0))
  return mine.find((r) => !isInfraFailure(r)) ?? mine[0] ?? null
}

export type Pair = { baseRunId: string; variantRunId: string }
export type PairResult = { ok: true; pair: Pair } | { ok: false; reason: string }

/** The pair from ?case&base&variant over the GET /eval-runs rows of that case. */
export function pairFromVariants(runs: EvalRun[], caseId: string, base: string, variant: string): PairResult {
  const b = newestRunOf(runs, caseId, base)
  const v = newestRunOf(runs, caseId, variant)
  if (!b) return { ok: false, reason: 'The base variant has no uploaded run on this case.' }
  if (!v) return { ok: false, reason: 'The variant has no uploaded run on this case.' }
  return { ok: true, pair: { baseRunId: b.id, variantRunId: v.id } }
}

export type AlignmentWord = 'same' | 'changed' | 'inserted' | 'removed'

export function alignmentWord(row: AlignmentRow): AlignmentWord {
  if (row.label !== 'none') return row.label
  return row.base ? 'removed' : 'inserted'
}

/**
 * The step list of a run from GET /runs/:id/actions. That public read carries the tool and the sanitized target,
 * not the target kind: the kind is the same placeholder on both sides, so the alignment keys on (tool, target).
 */
export function stepsOfActions(actions: RunAction[]): AlignableStep[] {
  return actions
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((a) => ({ seq: a.seq, tool: a.tool, target_kind: 'none' as const, target_redacted: a.target }))
}

/** The data types in the order S7 shows them. */
export const KIND_ORDER: ArtifactKind[] = ['diff', 'json', 'markdown', 'html', 'image', 'ndjson', 'text', 'binary']
export const KIND_LABEL: Record<ArtifactKind, string> = {
  diff: 'Code diff',
  json: 'JSON',
  markdown: 'Markdown',
  html: 'HTML',
  image: 'Image',
  ndjson: 'Trace',
  text: 'Text',
  binary: 'Binary',
}

export interface KindRow {
  kind: ArtifactKind
  base: Artifact[]
  variant: Artifact[]
}

/** One row per data type present in either run. */
export function rowsByKind(base: Artifact[], variant: Artifact[]): KindRow[] {
  return KIND_ORDER.map((kind) => ({ kind, base: base.filter((a) => a.kind === kind), variant: variant.filter((a) => a.kind === kind) })).filter(
    (r) => r.base.length || r.variant.length,
  )
}

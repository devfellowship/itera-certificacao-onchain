import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Table, TableEmpty } from '../ui'
import { ResultDot } from './ResultDot'
import { ScoreBar } from './ScoreBar'
import { PASS_LINE, fmtScore, halfWidth, wilson90 } from './score'

export type RunSource = 'run here' | 'imported'

export interface RunRow {
  key: string
  rank: number
  /** The agent cell: avatar + name + owner. The page builds it; the table keeps it generic. */
  agent: ReactNode
  /** The model cell (ModelLabel), or null. */
  model?: ReactNode
  source: RunSource
  score: number | null
  /**
   * Checks passed / total of this run. `undefined` = still loading (bar without band);
   * `null` = unknown (bar without band). The 90% CI band comes from `wilson90`.
   */
  checks?: { passed: number; total: number } | null
  outcome: string | null | undefined
  /** Where the row leads (evaluation page). */
  href?: string
}

/**
 * The runs table of a detail page: rank · agent · model · source · score bar with the 90% CI band and
 * the pass line · score ±half-width · checks k/n · result dot. A row links to `href`.
 */
export function RunsTable({ rows, testId = 'runs-table', empty, passLine = PASS_LINE }: { rows: RunRow[]; testId?: string; empty?: ReactNode; passLine?: number }) {
  const navigate = useNavigate()
  return (
    <div className="dt-runs">
      <Table<RunRow>
        testId={testId}
        rows={rows}
        rowKey={(r) => r.key}
        gap={16}
        onRowClick={(r) => r.href && navigate(r.href)}
        empty={empty ?? <TableEmpty title="No run yet." />}
        columns={[
          { key: 'rank', header: '#', width: '28px', render: (r) => <span className="dt-mono dt-dim">{r.rank}</span> },
          { key: 'agent', header: 'Agent', width: 'minmax(140px, 1.6fr)', render: (r) => r.agent },
          { key: 'model', header: 'Model', width: 'minmax(100px, 1fr)', render: (r) => r.model ?? <span className="dt-dim">—</span> },
          { key: 'source', header: 'Source', width: '72px', render: (r) => <span className="dt-chip" data-testid="run-source">{r.source}</span> },
          {
            key: 'bar',
            header: (
              <span>
                Score · 90% CI · <span className="dt-dim">┆ pass {fmtScore(passLine)}</span>
              </span>
            ),
            width: 'minmax(120px, 1.4fr)',
            render: (r) => <ScoreBar score={r.score} ci={r.checks ? wilson90(r.checks.passed, r.checks.total) : null} passLine={passLine} />,
          },
          {
            key: 'score',
            header: 'Score',
            width: '84px',
            align: 'right',
            render: (r) => {
              const hw = r.checks ? halfWidth(wilson90(r.checks.passed, r.checks.total)) : null
              return (
                <span className="dt-mono dt-score" data-testid="run-score">
                  {fmtScore(r.score)}
                  {hw != null && <span className="dt-dim"> ±{fmtScore(hw)}</span>}
                </span>
              )
            },
          },
          {
            key: 'checks',
            header: 'Checks',
            width: '64px',
            align: 'right',
            render: (r) => (
              <span className="dt-mono" data-testid="run-checks">
                {r.checks && r.checks.total > 0 ? `${r.checks.passed}/${r.checks.total}` : '—'}
              </span>
            ),
          },
          { key: 'result', header: 'Result', width: '72px', render: (r) => <ResultDot outcome={r.outcome} /> },
        ]}
      />
    </div>
  )
}

/** The agent cell: avatar, a name that links to the row target, and the owner line. */
export function RunAgentCell({ avatar, name, owner, href, testId }: { avatar?: ReactNode; name: string; owner?: ReactNode; href?: string; testId?: string }) {
  return (
    <span className="dt-agent">
      {avatar}
      <span className="dt-agent__copy">
        {href ? (
          <Link to={href} className="dt-agent__name" data-testid={testId ?? 'run-link'} onClick={(e) => e.stopPropagation()}>
            {name}
          </Link>
        ) : (
          <span className="dt-agent__name">{name}</span>
        )}
        {owner != null && <span className="dt-agent__owner">{owner}</span>}
      </span>
    </span>
  )
}

import type { ReactNode } from 'react'

export interface Column<Row> {
  key: string
  header: ReactNode
  /** CSS grid track, e.g. "1fr", "120px", "minmax(0,2fr)". */
  width: string
  align?: 'left' | 'right'
  render: (row: Row, index: number) => ReactNode
}

/**
 * Table of design brief 1.5: a card with a surface-raised header row (mono 11 uppercase) and body
 * rows divided by 1px line. Rows are CSS grid so every lane gets the exact column tracks of its mock.
 */
export function Table<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  gap = 20,
  rowHeight,
  testId,
}: {
  columns: Column<Row>[]
  rows: Row[]
  rowKey: (row: Row, index: number) => string
  onRowClick?: (row: Row) => void
  empty?: ReactNode
  gap?: number
  rowHeight?: number
  testId?: string
}) {
  const template = columns.map((c) => c.width).join(' ')
  return (
    <div className="tma-table" data-testid={testId}>
      <div className="tma-table__head" style={{ gridTemplateColumns: template, gap }} role="row">
        {columns.map((c) => (
          <span key={c.key} className={c.align === 'right' ? 'tma-table__num' : undefined} role="columnheader">
            {c.header}
          </span>
        ))}
      </div>
      {rows.length === 0 && empty}
      {rows.map((row, i) => (
        <div
          key={rowKey(row, i)}
          role="row"
          data-testid={testId ? `${testId}-row` : undefined}
          className={onRowClick ? 'tma-table__row tma-table__row--click' : 'tma-table__row'}
          style={{ gridTemplateColumns: template, gap, ...(rowHeight ? { height: rowHeight, paddingTop: 0, paddingBottom: 0 } : {}) }}
          onClick={onRowClick ? () => onRowClick(row) : undefined}
        >
          {columns.map((c) => (
            <span key={c.key} className={c.align === 'right' ? 'tma-table__num' : undefined}>
              {c.render(row, i)}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

/** Empty state inside a table: pad 48 20 centered, title 15/600, optional green text action. */
export function TableEmpty({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="tma-table__empty">
      <span className="tma-table__empty-title">{title}</span>
      {children}
    </div>
  )
}

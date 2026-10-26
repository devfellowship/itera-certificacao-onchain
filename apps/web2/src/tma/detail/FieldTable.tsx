import type { ReactNode } from 'react'

export interface FieldRow {
  field: string
  type?: string
  value: ReactNode
  weight?: ReactNode
}

/** Field | Type | Value | Weight. Field names in mono, type in dim mono, value in sans, weight right-aligned mono. */
export function FieldTable({ rows, testId }: { rows: FieldRow[]; testId?: string }) {
  return (
    <table className="dt-fields" data-testid={testId ?? 'field-table'}>
      <thead>
        <tr>
          <th>Field</th>
          <th>Type</th>
          <th>Value</th>
          <th className="dt-fields__w">Weight</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.field}-${i}`} data-testid="field-row">
            <td className="dt-fields__f">{r.field}</td>
            <td className="dt-fields__t">{r.type ?? ''}</td>
            <td className="dt-fields__v">{r.value}</td>
            <td className="dt-fields__w">{r.weight ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

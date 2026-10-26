import { useState } from 'react'

/**
 * A collapsible JSON tree. Object and array nodes show `object · N keys` / `array · N items` while
 * collapsed. Strings in quotes; numbers, booleans and null coloured with tokens. Pure React.
 * Nodes at depth ≥ `collapsedDepth` start collapsed (default 1: the root is open, its children closed).
 */
export function JsonTree({ value, collapsedDepth = 1, testId }: { value: unknown; collapsedDepth?: number; testId?: string }) {
  return (
    <div className="dt-json" data-testid={testId ?? 'json-tree'}>
      <Node value={value} depth={0} collapsedDepth={collapsedDepth} />
    </div>
  )
}

function summary(value: object): string {
  if (Array.isArray(value)) return `array · ${value.length} item${value.length === 1 ? '' : 's'}`
  const n = Object.keys(value).length
  return `object · ${n} key${n === 1 ? '' : 's'}`
}

function Leaf({ value }: { value: unknown }) {
  if (value === null) return <span className="dt-json__null">null</span>
  if (typeof value === 'string') return <span className="dt-json__s">"{value}"</span>
  if (typeof value === 'number') return <span className="dt-json__n">{String(value)}</span>
  if (typeof value === 'boolean') return <span className="dt-json__b">{String(value)}</span>
  if (value === undefined) return <span className="dt-json__null">undefined</span>
  return <span className="dt-json__s">{String(value)}</span>
}

function Node({ value, depth, collapsedDepth, name }: { value: unknown; depth: number; collapsedDepth: number; name?: string }) {
  const isObj = typeof value === 'object' && value !== null
  const [open, setOpen] = useState(depth < collapsedDepth)
  const key = name != null && <span className="dt-json__k">{name}: </span>
  if (!isObj) {
    return (
      <div className="dt-json__line" style={{ paddingLeft: depth * 14 }}>
        {key}
        <Leaf value={value} />
      </div>
    )
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>)
  return (
    <div className="dt-json__node" data-testid="json-node" data-open={String(open)}>
      <div className="dt-json__line" style={{ paddingLeft: depth * 14 }}>
        <button type="button" className="dt-json__toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> {key}
          <span className="dt-json__sum">{summary(value)}</span>
        </button>
      </div>
      {open && entries.map(([k, v]) => <Node key={k} name={k} value={v} depth={depth + 1} collapsedDepth={collapsedDepth} />)}
      {entries.length === 0 && open && (
        <div className="dt-json__line dt-json__empty" style={{ paddingLeft: (depth + 1) * 14 }}>
          {Array.isArray(value) ? '[]' : '{}'}
        </div>
      )}
    </div>
  )
}

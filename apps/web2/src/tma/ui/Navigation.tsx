import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

export interface TabItem<T extends string> {
  id: T
  label: ReactNode
  count?: number
}

/** Underline tabs: h40, 14/500, active text + 1px bottom line, mono count. */
export function Tabs<T extends string>({ items, value, onChange }: { items: TabItem<T>[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tma-tabs" role="tablist">
      {items.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} className="tma-tab" onClick={() => onChange(t.id)}>
          {t.label}
          {t.count != null && <span className="tma-tab__count">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

/** Segmented control (source filter): container pad 3, buttons h28, active bg line. */
export function Segmented<T extends string>({ items, value, onChange }: { items: TabItem<T>[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tma-segmented" role="group">
      {items.map((t) => (
        <button key={t.id} type="button" aria-pressed={t.id === value} className="tma-segmented__btn" onClick={() => onChange(t.id)}>
          {t.label}
          {t.count != null && <span className="tma-segmented__count">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

/** Inline stepper (02/03): mono number + label; current green number, done muted, future subtle. */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="tma-stepper">
      {steps.map((label, i) => (
        <span key={label} className={['tma-step', i < current && 'tma-step--done', i === current && 'tma-step--current'].filter(Boolean).join(' ')}>
          <span className="tma-step__n">{String(i + 1).padStart(2, '0')}</span>
          {label}
        </span>
      ))}
    </div>
  )
}

/** Breadcrumb 13 px muted, "/" separator subtle, current item text. */
export function Breadcrumb({ items }: { items: Array<{ label: ReactNode; to?: string }> }) {
  return (
    <nav className="tma-breadcrumb" aria-label="Breadcrumb">
      {items.map((it, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="tma-breadcrumb__sep">/</span>}
          {it.to && i < items.length - 1 ? <Link to={it.to}>{it.label}</Link> : <span className={i === items.length - 1 ? 'tma-breadcrumb__current' : undefined}>{it.label}</span>}
        </Fragment>
      ))}
    </nav>
  )
}

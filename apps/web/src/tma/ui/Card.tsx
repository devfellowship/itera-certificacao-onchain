import type { HTMLAttributes, ReactNode } from 'react'

/** Card: surface bg, 1px line, radius 12. `pad` adds the default 24 px padding. */
export function Card({ pad, className, ...rest }: HTMLAttributes<HTMLDivElement> & { pad?: boolean }) {
  return <div className={['tma-card', pad && 'tma-card--pad', className].filter(Boolean).join(' ')} {...rest} />
}

/** Card header row: pad 16 20, bottom border, title 15/600 left, mono meta right. */
export function CardHeader({ title, meta, children }: { title: ReactNode; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="tma-card__header">
      <span className="tma-card__title">{title}</span>
      {children ?? (meta != null && <span className="tma-card__meta">{meta}</span>)}
    </div>
  )
}

export function SectionLabel({ children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className="tma-label" {...rest}>
      {children}
    </span>
  )
}

/** Key/value panel: grid auto 1fr; key mono 11 uppercase muted; value 13 px right-aligned. */
export function KeyValue({ rows }: { rows: Array<{ key: ReactNode; value: ReactNode; testId?: string }> }) {
  return (
    <div className="tma-kv">
      {rows.flatMap((r, i) => [
        <div className="tma-kv__key" key={`k${i}`}>
          {r.key}
        </div>,
        <div className="tma-kv__value" key={`v${i}`} data-testid={r.testId}>
          {r.value}
        </div>,
      ])}
    </div>
  )
}

/**
 * Code panel: surface-code bg, radius 12; header mono 11 uppercase; body mono 13/1.6 (json) or
 * 12/1.75 (yaml). Children may use spans with classes k (key) s (string) b (boolean) n (null) c (comment).
 */
export function CodePanel({ title, meta, kind = 'json', children }: { title: ReactNode; meta?: ReactNode; kind?: 'json' | 'yaml'; children: ReactNode }) {
  return (
    <div className="tma-code">
      <div className="tma-code__header">
        <span className="tma-label">{title}</span>
        {meta != null && <span className="tma-label tma-subtle">{meta}</span>}
      </div>
      <pre className={kind === 'yaml' ? 'tma-code__body tma-code__body--yaml' : 'tma-code__body'}>{children}</pre>
    </div>
  )
}

export type EventTone = 'ok' | 'live' | 'idle' | 'bad'

/** One row of the run event log (04): grid 52px 6px 1fr, mono 12. */
export function EventLogRow({ time, tone, label, detail }: { time: ReactNode; tone: EventTone; label: ReactNode; detail?: ReactNode }) {
  return (
    <div className="tma-event" data-testid="event-row">
      <span className="tma-event__time">{time}</span>
      <span className={`tma-event__dot tma-event__dot--${tone}`} />
      <span>
        {label}
        {detail != null && <span className="tma-event__detail"> {detail}</span>}
      </span>
    </div>
  )
}

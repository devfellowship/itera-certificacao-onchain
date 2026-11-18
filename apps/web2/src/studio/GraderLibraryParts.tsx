/**
 * Shared pieces of the grader library screens on the canvas artboards (plan 20261112-tma-c5-studio-area-web2,
 * C5-RD-S10-S11): the "can decide" mark, the group heading, the column heads, the Type filter, the trust box with the
 * agreement bars, and the page shell (the main column and the full-height side panel). The look lives in graders.css.
 */
import type { HTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { InfoTip } from './chrome'
import { JUDGE_BAR, pct } from './calibration'
import { GROUPS, type Decide, type GroupKey } from './grader-library'
import { themeClass } from './theme'
import './studio.css'
import './graders.css'

const PATH: Record<Decide['tone'], string> = { ok: 'm8 12 3 3 5-6', warn: 'M12 7v6M12 16.5h.01', muted: 'M8 12h8' }

export function DecideIcon({ tone, size = 14 }: { tone: Decide['tone']; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d={PATH[tone]} />
    </svg>
  )
}

/** The "can decide" cell: an icon and a word (the word carries the meaning; the colour only repeats it). */
export function DecideMark({ d, testId }: { d: Decide; testId?: string }) {
  return (
    <span className={`grd-decide grd-decide--${d.tone}`} data-testid={testId} data-tone={d.tone}>
      <DecideIcon tone={d.tone} />
      {d.text}
    </span>
  )
}

export function GroupHeading({ group, count }: { group: GroupKey; count: number }) {
  const g = GROUPS.find((x) => x.key === group)!
  return (
    <div className="grd-group" data-testid={`grader-group-${group}`}>
      <h2 className="grd-group__title">{g.title}</h2>
      <span className="grd-group__count">{count}</span>
      <InfoTip label={`About ${g.title}`} text={g.note} />
    </div>
  )
}

/** Column heads of the grid. The 6 labels must match the 6 grid columns of `.grd-row`. */
export function HeadRow({ cols, tips = {} }: { cols: string[]; tips?: Record<string, string> }) {
  return (
    <div role="row" className="grd-row grd-row--head">
      {cols.map((c, i) => (
        <span key={c} role="columnheader" className={i === 4 ? 'grd-cell grd-cell--num' : 'grd-cell'}>
          {c}
          {tips[c] && <InfoTip label={`About ${c}`} text={tips[c]!} />}
        </span>
      ))}
    </div>
  )
}

/** The Type filter of the artboard, as links (no form field: the studio is read only). */
export function TypeFilter({ items }: { items: Array<{ label: string; to: string; on: boolean; testId?: string }> }) {
  return (
    <nav className="grd-types" aria-label="Type">
      <span className="stu-label">Type</span>
      {items.map((t) => (
        <Link key={t.label} to={t.to} className={`stu-chip stu-chip--sm${t.on ? ' stu-chip--on' : ''}`} aria-current={t.on ? 'page' : undefined} data-testid={t.testId}>
          {t.label}
        </Link>
      ))}
    </nav>
  )
}

/** One agreement bar of the artboard ("catches real failures 93%"), with a tick at the 90 % bar. */
export function AgreeBar({ label, value, testId }: { label: string; value: number | null; testId?: string }) {
  const tone = value === null ? '' : value >= JUDGE_BAR ? ' grd-agree__fill--ok' : ' grd-agree__fill--warn'
  return (
    <div className="grd-agree" data-testid={testId}>
      <div className="grd-agree__head">
        <span>{label}</span>
        <b>{pct(value)}</b>
      </div>
      <span className="grd-agree__track" role="img" aria-label={`${label}: ${pct(value)}, bar ${Math.round(JUDGE_BAR * 100)}%`}>
        <span className={`grd-agree__fill${tone}`} style={{ width: `${Math.round((value ?? 0) * 1000) / 10}%` }} />
        <span className="grd-agree__mark" style={{ left: `${JUDGE_BAR * 100}%` }} />
      </span>
    </div>
  )
}

/**
 * The trust box of the side panel. For a judge it carries the two agreement bars: TNR is "catches real failures" (a
 * run people labeled fail, judged fail) and TPR is "confirms real passes" (labeled pass, judged pass).
 */
export function TrustBox({ d, judge, children }: { d: Decide; judge?: { tpr: number | null; tnr: number | null }; children?: ReactNode }) {
  return (
    <section className={`grd-trust grd-trust--${d.tone}`} data-testid="grader-trust" aria-label="Can it decide a score">
      <span className={`grd-trust__title grd-decide--${d.tone}`}>
        <DecideIcon tone={d.tone} size={16} />
        <span>{d.title}</span>
      </span>
      <p>{d.note}</p>
      {judge && (
        <div className="grd-agree-list" data-testid="grader-agreement">
          <AgreeBar label="catches real failures" value={judge.tnr} testId="agree-tnr" />
          <AgreeBar label="confirms real passes" value={judge.tpr} testId="agree-tpr" />
        </div>
      )}
      {children}
    </section>
  )
}

/** The page shell: the main column and the side panel next to it, full height. */
export function LibraryShell({ testId, aside, asideLabel, wide, children, ...rest }: { testId: string; aside: ReactNode; asideLabel: string; wide?: boolean; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <main className={themeClass('tma-page', 'stu-page', 'grd-page')} data-testid={testId} {...rest}>
      <div className="grd-shell">
        <div className="grd-col">{children}</div>
        {aside != null && (
          <aside className={`grd-aside${wide ? ' grd-aside--wide' : ''}`} aria-label={asideLabel}>
            <div className="grd-aside__in">{aside}</div>
          </aside>
        )}
      </div>
    </main>
  )
}

export function StateBox({ title, text, testId }: { title: string; text: string; testId?: string }) {
  return (
    <div className="grd-state" data-testid={testId}>
      <span className="tma-label">{title}</span>
      <p className="tma-body-sm tma-muted">{text}</p>
    </div>
  )
}

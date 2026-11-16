/**
 * Studio theme components (plan 20261112-tma-c5-studio-area-web2, UI-S13). They only add the canvas class names of
 * theme.css; the look lives in the CSS. A studio page puts `stu-theme` on its root element and reuses these.
 */
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import './theme.css'

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ')

/** The scope class. Spread it into a page root: `<main className={themeClass('tma-page')}>`. */
export const THEME_CLASS = 'stu-theme'
export const themeClass = (...extra: Array<string | false | null | undefined>) => cx(THEME_CLASS, ...extra)

/** A section: 13/500 heading, optional mono meta at the right, then the content. */
export function Section({ title, meta, children, className, ...rest }: { title: ReactNode; meta?: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <section className={cx('stu-section', className)} {...rest}>
      <h2 className="stu-section__title">
        {title}
        {meta != null && <span className="stu-section__meta">{meta}</span>}
      </h2>
      {children}
    </section>
  )
}

/** A toggle chip. `on` sets aria-pressed; use `Tab` for a control that switches a view. */
export function Chip({ on, small, className, type = 'button', ...rest }: { on?: boolean; small?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} aria-pressed={on} className={cx('stu-chip', small && 'stu-chip--sm', className)} {...rest} />
}

/** One joined toggle group (S3 Waterfall / Where time went, S9 Compact / Comfortable). Items set aria-pressed. */
export function Toggle({ label, children, className, ...rest }: { label: string } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span role="group" aria-label={label} className={cx('stu-toggle', className)} {...rest}>
      {children}
    </span>
  )
}

export function ToggleItem({ on, className, type = 'button', ...rest }: { on: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} aria-pressed={on} className={cx('stu-toggle__item', className)} {...rest} />
}

export function Tabs({ label, children, className, ...rest }: { label: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div role="tablist" aria-label={label} className={cx('stu-tabs', className)} {...rest}>
      {children}
    </div>
  )
}

export function Tab({ selected, className, type = 'button', ...rest }: { selected: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} role="tab" aria-selected={selected} className={cx('stu-tab', className)} {...rest} />
}

export type StuButtonVariant = 'primary' | 'secondary' | 'ghost'

export function StuButton({ variant = 'secondary', large, className, type = 'button', ...rest }: { variant?: StuButtonVariant; large?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={cx('stu-btn', `stu-btn--${variant}`, large && 'stu-btn--lg', className)} {...rest} />
}

/** A key hint. It hides on a touch screen (no hover), where the key does nothing. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="stu-kbd stu-kbd--keyboard">{children}</kbd>
}

export function Dot({ tone }: { tone?: 'ok' | 'bad' | 'warn' | 'merged' }) {
  return <span aria-hidden="true" className={cx('stu-dot', tone && `stu-dot--${tone}`)} />
}

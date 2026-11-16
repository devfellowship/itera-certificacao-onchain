/**
 * Page chrome of the studio canvas screens (plan 20261112-tma-c5-studio-area-web2, UI-S4S6S7): the breadcrumb bar,
 * the (i) help tip and the numbered step heading of the artboards. The look lives in chrome.css, on the tokens of theme.css.
 */
import type { HTMLAttributes, ReactNode } from 'react'
import { Tip } from '../tma/ui'
import './chrome.css'

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ')

/** The bar over a page: the trail at the left (muted, the last item bright), the page actions at the right. */
export function StudioBar({ trail, actions, ...rest }: { trail: ReactNode; actions?: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="stu-bar" {...rest}>
      <nav className="stu-crumbs" aria-label="Breadcrumb">
        {trail}
      </nav>
      {actions != null && <div className="stu-bar__actions">{actions}</div>}
    </div>
  )
}

/** One crumb. The last one is the page (`current`): it is bright and not a link. */
export function Crumb({ current, children }: { current?: boolean; children: ReactNode }) {
  return current ? <b className="stu-crumb stu-crumb--current" aria-current="page">{children}</b> : <span className="stu-crumb">{children}</span>
}

export const CrumbSep = () => <span className="stu-crumbs__sep" aria-hidden="true">/</span>

/** The canvas (i): help text lives in a tooltip, not in the page copy. */
export function InfoTip({ label, text }: { label: string; text: string }) {
  return (
    <Tip text={text} className="stu-info">
      <svg role="img" aria-label={label} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
      </svg>
    </Tip>
  )
}

/** The title row: the h1, an optional (i), then the actions at the right. */
export function TitleRow({ children, tip, actions, className }: { children: ReactNode; tip?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cx('stu-titlerow', className)}>
      {children}
      {tip}
      {actions != null && <div className="stu-titlerow__actions">{actions}</div>}
    </div>
  )
}

/** A numbered step of a page (artboard S4: "1 Start from a real trace"). */
export function Step({ n, title, children, className, ...rest }: { n: number; title: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <section className={cx('stu-step', className)} {...rest}>
      <h2 className="stu-step__title">
        <span className="stu-step__n" aria-hidden="true">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  )
}

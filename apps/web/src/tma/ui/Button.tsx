import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router-dom'

export type ButtonVariant = 'primary' | 'secondary' | 'secondary-dark' | 'inverse' | 'text' | 'muted'
export type ButtonSize = 40 | 36 | 32 | 30

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 40, block = false, extra?: string) {
  return ['tma-btn', `tma-btn--${variant}`, size !== 40 && `tma-btn--h${size}`, block && 'tma-btn--block', extra]
    .filter(Boolean)
    .join(' ')
}

interface CommonProps {
  variant?: ButtonVariant
  size?: ButtonSize
  block?: boolean
  children?: ReactNode
}

/** Buttons of design brief 1.5: primary (one per view), secondary, inverse, text. Heights 40/36/32/30. */
export function Button({ variant, size, block, className, type = 'button', ...rest }: CommonProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={buttonClass(variant, size, block, className)} {...rest} />
}

/** A router link that looks like a button. External URLs (http…) render a plain anchor. */
export function ButtonLink({ variant, size, block, className, href, ...rest }: CommonProps & AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const cls = buttonClass(variant, size, block, className)
  if (/^https?:/.test(href)) return <a className={cls} href={href} target="_blank" rel="noreferrer" {...rest} />
  return <Link className={cls} to={href} {...rest} />
}

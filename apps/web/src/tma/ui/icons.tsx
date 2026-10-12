// 16 px line icons, 1.5 px stroke, currentColor (design brief 1.1). Chevrons are 12 px.
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>

export const IconSearch = (p: P) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" strokeLinecap="round" />
  </svg>
)
export const IconChevronDown = (p: P) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" {...p}>
    <path d="M3 4.5 6 7.5 9 4.5" />
  </svg>
)
export const IconChevronRight = (p: P) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" {...p}>
    <path d="M4.5 3 7.5 6 4.5 9" />
  </svg>
)
export const IconCheck = (p: P) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true" {...p}>
    <path d="m2.5 6.2 2.3 2.3 4.7-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
export const IconClose = (p: P) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" {...p}>
    <path d="m3 3 6 6M9 3 3 9" strokeLinecap="round" />
  </svg>
)
export const IconFilter = (p: P) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" {...p}>
    <path d="M2.5 4.5h11M2.5 11.5h11" strokeLinecap="round" />
    <circle cx="10" cy="4.5" r="1.75" fill="var(--tma-bg)" />
    <circle cx="6" cy="11.5" r="1.75" fill="var(--tma-bg)" />
  </svg>
)
export const IconLink = (p: P) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" {...p}>
    <path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1" strokeLinecap="round" />
  </svg>
)

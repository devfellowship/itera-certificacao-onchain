/**
 * Result origin (plan 20261026-tma-local-runner-and-self-declared-results, task L11; Q4 = C).
 * A `self_declared` result ran on its owner's machine: TestMyAgent did not run, grade or attest it.
 * The API shows such a row to its owner only, so every badge here is an owner-view element.
 * Absent `resultOrigin` = hosted. Any value other than `self_declared` = no badge.
 */
import { useId, useState, type ReactNode } from 'react'

export const SELF_DECLARED_TOOLTIP = 'TestMyAgent did not run or verify this result'
export const SELF_DECLARED_NOTE = "Run on the owner's machine. TestMyAgent did not run or verify it."

/** True only for `resultOrigin: 'self_declared'`. Null, absent, `hosted` or an unknown value → false. */
export function isSelfDeclared(x: { resultOrigin?: unknown } | null | undefined): boolean {
  return x?.resultOrigin === 'self_declared'
}

/** True only for `connector: 'local'` (an agent that runs on its owner's machine). */
export function isLocalAgent(a: { connector?: unknown } | null | undefined): boolean {
  return a?.connector === 'local'
}

/** The bubble's largest width (ui.css: max-width min(260px, 100vw - 32px)) and its margin to the viewport edge. */
const TIP_MAX_WIDTH = 260
const TIP_MARGIN = 16

/** Horizontal offset (px, relative to the trigger's left edge) that keeps a bubble of `width` inside the viewport. */
export function tipShift(triggerLeft: number, viewportWidth: number, width = TIP_MAX_WIDTH): number {
  const w = Math.min(width, viewportWidth - 2 * TIP_MARGIN)
  const left = Math.min(Math.max(triggerLeft, TIP_MARGIN), Math.max(TIP_MARGIN, viewportWidth - TIP_MARGIN - w))
  return Math.round(left - triggerLeft)
}

/**
 * Text + tooltip wrapper: the bubble opens on hover and on keyboard focus, and `aria-describedby` reads it out.
 * On open, the bubble is shifted so it stays inside the viewport (a badge near the right edge of a 375 px screen).
 */
export function Tip({ text, children, className }: { text: string; children: ReactNode; className?: string }) {
  const id = useId()
  const [shift, setShift] = useState(0)
  const place = (el: HTMLElement) => setShift(tipShift(el.getBoundingClientRect().left, window.innerWidth))
  return (
    <span
      className={['tma-tip', className].filter(Boolean).join(' ')}
      tabIndex={0}
      aria-describedby={id}
      onMouseEnter={(e) => place(e.currentTarget)}
      onFocus={(e) => place(e.currentTarget)}
    >
      {children}
      <span className="tma-tip__bubble" role="tooltip" id={id} style={shift ? { left: shift } : undefined}>
        {text}
      </span>
    </span>
  )
}

/** "Self-declared" pill. Text, not color alone; `data-origin="self_declared"` for tests and CSS. */
export function SelfDeclaredBadge({ testId }: { testId?: string }) {
  return (
    <Tip text={SELF_DECLARED_TOOLTIP}>
      <span className="tma-badge tma-badge--warning tma-badge--origin" data-origin="self_declared" data-testid={testId}>
        Self-declared
      </span>
    </Tip>
  )
}

/** "Local agent" pill for `connector: 'local'`. Renders nothing for a hosted (GitHub or endpoint) agent. */
export function AgentOriginPill({ connector, testId }: { connector?: unknown; testId?: string }) {
  if (connector !== 'local') return null
  return (
    <span className="tma-badge tma-badge--neutral tma-badge--origin" data-connector="local" data-testid={testId}>
      Local agent
    </span>
  )
}

/** One-line explanation under the header of a self-declared evaluation. */
export function SelfDeclaredNote({ testId = 'self-declared-note' }: { testId?: string }) {
  return (
    <div className="tma-origin-note" data-testid={testId}>
      <SelfDeclaredBadge />
      <span>{SELF_DECLARED_NOTE}</span>
    </div>
  )
}

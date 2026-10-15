import type { ReactNode } from 'react'
import { IconClose } from './icons'

export type Tone = 'success' | 'warning' | 'danger' | 'neutral'

/** Status badge: pill, mono 11/500 uppercase. Text is a state word only; color is never the only signal. */
export function Badge({ tone, dot, children, testId }: { tone: Tone; dot?: boolean; children: ReactNode; testId?: string }) {
  return (
    <span className={`tma-badge tma-badge--${tone}`} data-testid={testId}>
      {dot && <span className="tma-badge__dot" />}
      {children}
    </span>
  )
}

/** Every state word the app shows, mapped to its tone and label. Lanes use StatusChip, not raw Badge. */
export const STATUS_WORDS = {
  // run outcome (ADR-5)
  PASS: { tone: 'success', label: 'PASS' },
  FAIL: { tone: 'danger', label: 'FAIL' },
  INVALID: { tone: 'neutral', label: 'INVALID' },
  // run status (API) — infra_error is a platform fault, shown as Review, never FAIL
  queued: { tone: 'neutral', label: 'Queued' },
  running: { tone: 'warning', label: 'Running' },
  pass: { tone: 'success', label: 'PASS' },
  fail: { tone: 'danger', label: 'FAIL' },
  invalid: { tone: 'neutral', label: 'INVALID' },
  timeout: { tone: 'neutral', label: 'INVALID' },
  infra_error: { tone: 'warning', label: 'Review' },
  // run phase
  preparing: { tone: 'warning', label: 'Preparing' },
  agent_running: { tone: 'warning', label: 'Agent running' },
  grading: { tone: 'warning', label: 'Grading' },
  done: { tone: 'neutral', label: 'Done' },
  // evaluation status
  pending: { tone: 'warning', label: 'Pending' },
  in_progress: { tone: 'warning', label: 'In progress' },
  review: { tone: 'warning', label: 'Review' },
  issuing: { tone: 'warning', label: 'Issuing' },
  issued: { tone: 'success', label: 'Issued' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  failed: { tone: 'danger', label: 'Failed' },
  // proof / record / payment
  confirmed: { tone: 'success', label: 'Confirmed' },
  expired: { tone: 'neutral', label: 'Expired' },
  refunded: { tone: 'neutral', label: 'Refunded' },
  not_issued: { tone: 'warning', label: 'Not issued' },
  // integrity / identity
  verified: { tone: 'success', label: 'Verified' },
  mismatch: { tone: 'danger', label: 'Mismatch' },
  unavailable: { tone: 'warning', label: 'Unavailable' },
  declared: { tone: 'neutral', label: 'Declared' },
  illustrative: { tone: 'warning', label: 'Illustrative' },
  platform_run: { tone: 'success', label: 'Platform-run' },
  available: { tone: 'success', label: 'Available' },
  // agent / task lifecycle
  draft: { tone: 'neutral', label: 'Draft' },
  active: { tone: 'success', label: 'Active' },
  listed: { tone: 'success', label: 'Listed' },
  private: { tone: 'neutral', label: 'Private' },
  validating: { tone: 'warning', label: 'Validating' },
  ready: { tone: 'success', label: 'Ready' },
} as const satisfies Record<string, { tone: Tone; label: string }>

export type StatusWord = keyof typeof STATUS_WORDS

/** Status chip for any run / evaluation / proof / task state. Unknown words render neutral. */
export function StatusChip({ status, dot }: { status: StatusWord | (string & {}); dot?: boolean }) {
  const entry = (STATUS_WORDS as Record<string, { tone: Tone; label: string }>)[status] ?? { tone: 'neutral' as Tone, label: status }
  return (
    <Badge tone={entry.tone} dot={dot} testId={`status-${status}`}>
      {entry.label}
    </Badge>
  )
}

/** Tag pill h22 (or h28 `large` on profile hero), optional mono count. */
export function TagPill({ children, count, large }: { children: ReactNode; count?: number; large?: boolean }) {
  return (
    <span className={large ? 'tma-tag tma-tag--lg' : 'tma-tag'}>
      {children}
      {count != null && <span className="tma-tag__count">{count}</span>}
    </span>
  )
}

/** Filter chip h26: selected = primary-soft bg + primary-text. */
export function Chip({ selected, onToggle, children, count }: { selected: boolean; onToggle: () => void; children: ReactNode; count?: number }) {
  return (
    <button type="button" className="tma-chip" aria-pressed={selected} onClick={onToggle}>
      {children}
      {count != null && <span className="tma-tag__count">{count}</span>}
    </button>
  )
}

/** Removable "Ranked on" chip h28 with a 20 px × button. */
export function RemovableChip({ children, onRemove, removeLabel = 'Remove' }: { children: ReactNode; onRemove: () => void; removeLabel?: string }) {
  return (
    <span className="tma-chip tma-chip--removable">
      {children}
      <button type="button" className="tma-chip__x" aria-label={removeLabel} onClick={onRemove}>
        <IconClose width={10} height={10} />
      </button>
    </span>
  )
}

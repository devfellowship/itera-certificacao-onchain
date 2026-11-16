/**
 * Shared parts of S2 (trace picker) and S3 (trace view) (plan 20261112-tma-c5-studio-area-web2, task C5-T6).
 * Plain text only: every value goes through React escaping. No dangerouslySetInnerHTML.
 */
import { useEffect, useState } from 'react'
import { Card, Tip } from '../tma/ui'
import { agentChip, signalLabel, traceErrorText, type PinStatus, type TaskSummary, type TraceRow } from './traces'

export type TraceLoaded<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'error'; error: unknown }

/** Loads one trace resource; keeps the error object so traceErrorText can read its kind and code. */
export function useTraceLoad<T>(load: () => Promise<T>, deps: unknown[]): TraceLoaded<T> {
  const [v, setV] = useState<TraceLoaded<T>>({ state: 'loading' })
  useEffect(() => {
    let live = true
    setV({ state: 'loading' })
    load().then(
      (data) => live && setV({ state: 'ok', data }),
      (error: unknown) => live && setV({ state: 'error', error }),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return v
}

const DASH = '—'

/** Before / Expected / Outcome of a task summary (parent ADR-27). A null field shows "—". */
export function TaskSummaryBlock({ summary, showOutcome = true }: { summary: TaskSummary; showOutcome?: boolean }) {
  return (
    <dl className="trc-task" data-task-summary="">
      <dt>Before</dt>
      <dd data-field="before">{summary.before ?? DASH}</dd>
      <dt>Expected</dt>
      <dd data-field="expected">{summary.expected ?? DASH}</dd>
      {showOutcome && (
        <>
          <dt>Outcome</dt>
          <dd data-field="outcome">{summary.outcome ?? DASH}</dd>
        </>
      )}
    </dl>
  )
}

export type PinState = 'complete' | 'incomplete' | 'none'

export function pinState(pin: PinStatus | null): PinState {
  if (!pin) return 'none'
  return pin.complete === true ? 'complete' : 'incomplete'
}

export function PinBadge({ pin }: { pin: PinStatus | null }) {
  const s = pinState(pin)
  const text = s === 'complete' ? 'pinned complete' : s === 'incomplete' ? `pinned incomplete (${pin!.missing.length} missing)` : 'not pinned'
  return (
    <span className={`trc-pin trc-pin--${s}`} data-pin={s} title={s === 'incomplete' && pin!.missing.length ? `missing: ${pin!.missing.join(', ')}` : undefined}>
      {text}
    </span>
  )
}

export function WhyBadge({ why }: { why: string | null }) {
  if (!why) return null
  return (
    <span className="trc-why" data-why={why}>
      {why}
    </span>
  )
}

/** The true signals as plain words, comma separated; "none" when there is none (canvas "signal" column). */
export function SignalChips({ signals, empty = 'none' }: { signals: Record<string, boolean | null> | null; empty?: string }) {
  const on = Object.entries(signals ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k)
  if (on.length === 0) return <span className="trc-none">{empty}</span>
  return (
    <span className="trc-signals">
      {on.map((k, i) => (
        <span key={k} data-signal={k}>
          {signalLabel(k)}
          {i < on.length - 1 ? ',' : ''}
        </span>
      ))}
    </span>
  )
}

/** Agent avatar: two letters on the harness ground (canvas S2 "agent" column). */
export function AgentAvatar({ row }: { row: Pick<TraceRow, 'executor' | 'harness' | 'host'> }) {
  const a = agentChip(row)
  return (
    <span className={`trc-avatar trc-avatar--${a.key}`} aria-hidden="true">
      {a.letters}
    </span>
  )
}

export function InfoIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  )
}

/** The (i) button of the canvas with its tooltip. */
export function InfoTip({ text, label }: { text: string; label: string }) {
  return (
    <Tip text={text} className="trc-info">
      <span aria-label={label}>
        <InfoIcon />
      </span>
    </Tip>
  )
}

export function TraceErrorCard({ error, testId }: { error: unknown; testId: string }) {
  return (
    <Card pad data-testid={testId}>
      <span className="tma-label">No traces</span>
      <p className="tma-body-sm tma-muted" data-testid="trace-error" role="alert">
        {traceErrorText(error)}
      </p>
    </Card>
  )
}

/** 2026-11-01T10:00:00.000Z -> 2026-11-01 10:00:00 (UTC). Anything else is shown as given. */
export function fmtTime(ts: string | null): string {
  if (!ts) return DASH
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(ts)
  return m ? `${m[1]} ${m[2]}` : ts
}

/** Seconds -> "1h 2m 3s" / "2m 3s" / "3s". */
export function fmtDuration(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return DASH
  const t = Math.round(s)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = t % 60
  return h ? `${h}h ${m}m ${sec}s` : m ? `${m}m ${sec}s` : `${sec}s`
}

export const dash = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? DASH : String(v))

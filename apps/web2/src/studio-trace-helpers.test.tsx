// @vitest-environment jsdom
/**
 * Helpers and views behind the S2 / S3 redesign (UI-S2S3S9): the span kind, the waterfall layout, the time profile,
 * the replay cell, the agent avatar, and the S3 views that need a bigger trace (profile, show all). Fixture text is synthetic.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { TraceView } from './studio/StudioTracePage'
import { agentChip, buildProfile, buildWaterfall, dayOf, fmtMs, replayOf, spanKind, trueSignals, type Trace, type TraceRun, type TraceSpan } from './studio/traces'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
})

const T0 = Date.parse('2026-11-01T10:00:00.000Z')
const at = (ms: number) => new Date(T0 + ms).toISOString()
const span = (seq: number, startMs: number, durMs: number, over: Partial<TraceSpan> = {}): TraceSpan => ({
  seq, turn_seq: 1, ts: at(startMs), ts_end: at(startMs + durMs), dur_ms: durMs, tool: 'Read', shape: null, intent: null, family: null, target_kind: null, target: `target-${seq}`, ok: true, retry_of: null, child_run: null, preview: null, bytes_out: null, ...over,
})
const run = (spans: TraceSpan[], over: Partial<TraceRun> = {}): TraceRun => ({
  agent_id: null, parent_agent_id: null, is_subagent: false, spawn_depth: 0, agent_type: null, description: null, title: null, started_at: at(0), ended_at: at(1_000_000), duration_s: 1000, models: [], n_tool_calls: spans.length, errors: 0, spans, ...over,
})

describe('spanKind', () => {
  it('maps the tool, intent and family to the canvas kinds, and never reads the preview', () => {
    const k = (tool: string | null, intent: string | null = null, family: string | null = null) => spanKind({ tool, intent, family })
    expect(k('Read')).toBe('read')
    expect(k('Grep')).toBe('search')
    expect(k('Edit')).toBe('write')
    expect(k('Bash', 'test-run')).toBe('test')
    expect(k('Bash', 'git-read')).toBe('read')
    expect(k('Bash', 'ops-change')).toBe('other')
    expect(k('mcp__dfl__get_plan')).toBe('tool')
    expect(k('Task')).toBe('tool')
    expect(k(null)).toBe('other')
  })
})

describe('buildWaterfall', () => {
  it('puts the runs and spans on one axis; no timestamp means no bar', () => {
    const wf = buildWaterfall([run([span(0, 0, 100), span(1, 500, 250, { ok: false, tool: 'Bash', intent: 'test-run' }), span(2, 0, 0, { ts: null, ts_end: null, dur_ms: null })])])
    expect(wf.totalMs).toBe(1_000_000)
    expect(wf.steps).toBe(3)
    const steps = wf.rows.filter((r) => r.type === 'step')
    expect(steps).toHaveLength(3)
    const s1 = steps[1]!
    expect(s1.type === 'step' && s1.failed).toBe(true)
    expect(s1.type === 'step' && s1.kind).toBe('test')
    expect(s1.type === 'step' && s1.left).toBeCloseTo(0.05)
    expect(s1.type === 'step' && s1.width).toBeCloseTo(0.4)
    const s2 = steps[2]!
    expect(s2.type === 'step' && s2.left).toBeNull()
    expect(wf.rows[0]!.type).toBe('run')
  })

  it('is empty-safe', () => {
    expect(buildWaterfall([])).toEqual({ totalMs: 0, rows: [], steps: 0 })
    const wf = buildWaterfall([run([span(0, 0, 0, { ts: null, ts_end: null })], { started_at: null, ended_at: null, duration_s: null })])
    expect(wf.totalMs).toBe(0)
    const s = wf.rows[1]!
    expect(s.type === 'step' && s.left).toBeNull()
  })
})

describe('buildProfile', () => {
  it('sums tool time by kind, adds the time between calls, and names the slowest calls', () => {
    const spans = [span(0, 0, 2000, { tool: 'Bash', intent: 'test-run' }), span(1, 3000, 1000, { tool: 'Bash', intent: 'test-run' }), span(2, 5000, 100)]
    const p = buildProfile([run(spans)], 10)
    expect(p.wallMs).toBe(10_000)
    const byKey = Object.fromEntries(p.lines.map((l) => [l.key, l]))
    expect(byKey.test).toMatchObject({ calls: 2, ms: 3000, pct: 30 })
    expect(byKey.read).toMatchObject({ calls: 1, ms: 100, pct: 1 })
    expect(byKey.between).toMatchObject({ calls: 0, ms: 6900, pct: 69 })
    expect(p.lines[0]!.key).toBe('between')
    expect(p.slowest.map((s) => s.seq)).toEqual([0, 1, 2])
  })

  it('has no between line when the calls explain the wall time or the wall time is unknown', () => {
    const p = buildProfile([run([span(0, 0, 5000)])], 4)
    expect(p.lines.find((l) => l.key === 'between')).toBeUndefined()
    expect(buildProfile([run([])], null).lines).toEqual([])
  })
})

describe('row helpers', () => {
  it('formats a duration', () => {
    expect([fmtMs(null), fmtMs(850), fmtMs(2400), fmtMs(41_000), fmtMs(7 * 60_000), fmtMs(90_000), fmtMs(3_900_000)]).toEqual(['—', '850 ms', '2.4 s', '41 s', '7 min', '1.5 min', '1h 5m'])
  })
  it('reads the day, the true signals, the replay cell and the avatar', () => {
    expect(dayOf('2026-11-01T10:00:00.000Z')).toBe('2026-11-01')
    expect(dayOf(null)).toBeNull()
    expect(trueSignals({ a: true, b: false, c: null, d: true })).toEqual(['a', 'd'])
    expect(trueSignals(null)).toEqual([])
    const pin = (complete: boolean) => ({ pin_sha256: null, complete, missing: [], layer1: null })
    expect(replayOf({ replayable: true, pin: pin(true) })).toBe('yes')
    expect(replayOf({ replayable: true, pin: pin(false) })).toBe('partly')
    expect(replayOf({ replayable: null, pin: null })).toBe('unpinned')
    expect(replayOf({ replayable: false, pin: pin(true) })).toBe('no')
    expect(agentChip({ executor: null, harness: 'claude-code', host: 'h' })).toEqual({ key: 'cc', letters: 'CC', name: 'Claude Code' })
    expect(agentChip({ executor: 'x', harness: 'codex', host: 'h' }).key).toBe('cx')
    expect(agentChip({ executor: null, harness: 'opencode', host: null }).name).toBe('opencode')
    expect(agentChip({ executor: null, harness: 'claude-code', host: 'alien01' }).key).toBe('al')
    expect(agentChip({ executor: 'zed-agent', harness: null, host: null })).toEqual({ key: 'other', letters: 'ZE', name: 'zed-agent' })
  })
})

describe('S3 views', () => {
  const trace = (spans: TraceSpan[]): Trace => ({
    session_id: 'sid', agent_id: null,
    index: { host: null, harness: null, kind: null, first_ts: null, last_ts: null, message_count: null, models: [], state: null },
    candidate: null, pin: null, task_summary: null,
    summary: { title: 'fixture-title', started_at: at(0), ended_at: at(10_000), duration_s: 10, active_s: null, channel: null, models: [], n_runs: 1, n_subagent_runs: 0, n_tool_calls: spans.length, tool_counts: null, intent_counts: null, errors: 0, outcome_signals: null, closure_confidence: null, cost_usd: null, extractor_version: null },
    runs: [run(spans)], first_failure: null,
  })
  const mount = (t: Trace) => {
    const c = document.createElement('div')
    document.body.appendChild(c)
    root = createRoot(c)
    act(() => root!.render(<MemoryRouter><TraceView t={t} /></MemoryRouter>))
    return c
  }

  it('shows 200 calls first and all of them on request', () => {
    const c = mount(trace(Array.from({ length: 250 }, (_, i) => span(i, i * 10, 5))))
    expect(c.querySelectorAll('[data-trace-step]')).toHaveLength(200)
    expect(c.querySelector('[data-testid="trace-shown"]')!.textContent).toBe('showing 200 of 250 calls')
    act(() => c.querySelector<HTMLButtonElement>('[data-testid="trace-show-all"]')!.click())
    expect(c.querySelectorAll('[data-trace-step]')).toHaveLength(250)
    expect(c.querySelector('[data-testid="trace-show-all"]')).toBeNull()
  })

  it('the second view says where the time went and does not claim who waited', () => {
    const c = mount(trace([span(0, 0, 1000, { tool: 'Bash', intent: 'test-run' })]))
    act(() => [...c.querySelectorAll<HTMLButtonElement>('.trc-views button')].find((b) => b.textContent === 'Where time went')!.click())
    const p = c.querySelector('[data-testid="trace-profile"]')!
    expect(p.textContent).toContain('Between calls')
    expect(p.textContent).toContain('The trace does not tell which')
    expect(p.textContent).toContain('Slowest calls')
    expect(c.querySelectorAll('[data-trace-step]')).toHaveLength(0)
  })

  it('the tabs switch panels and mark the current one', () => {
    const c = mount(trace([span(0, 0, 5)]))
    const tabs = [...c.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false'])
    act(() => tabs[1]!.click())
    expect([...c.querySelectorAll('[role="tab"]')].map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true'])
    expect(c.querySelector('[data-testid="trace-steps"]')).toBeNull()
  })

  it('handles a trace with no timestamps and no runs', () => {
    const c = mount({ ...trace([]), runs: [] })
    expect(c.textContent).toContain('No runs in this trajectory.')
  })
})

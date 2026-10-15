import { describe, expect, it } from 'vitest'
import { appendPage, callEvents, EMPTY_FEED, mergeByTime } from './call-events'

const row = (seq: number, over: Record<string, unknown> = {}) => ({
  seq,
  tool: 'bash',
  target: `npm test ${seq}` as string | null,
  ok: true as boolean | null,
  occurredAt: new Date(Date.UTC(2026, 9, 12, 12, 0, seq)).toISOString(),
  ...over,
})

describe('call-events', () => {
  it('appendPage keeps rows in seq order, drops a repeated seq, and moves the cursor', () => {
    let f = appendPage(EMPTY_FEED, { actions: [row(1), row(2)], nextAfterSeq: 2, hasMore: false }, false)
    expect(f.rows.map((r) => r.seq)).toEqual([1, 2])
    expect(f.after).toBe(2)
    expect(f.done).toBe(false)
    f = appendPage(f, { actions: [row(2), row(3)], nextAfterSeq: 3, hasMore: false }, false)
    expect(f.rows.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(f.after).toBe(3)
  })

  it('a feed is done only when the run ended AND the last page had no more', () => {
    expect(appendPage(EMPTY_FEED, { actions: [row(1)], nextAfterSeq: 1, hasMore: true }, true).done).toBe(false)
    expect(appendPage(EMPTY_FEED, { actions: [row(1)], nextAfterSeq: 1, hasMore: false }, false).done).toBe(false)
    expect(appendPage(EMPTY_FEED, { actions: [], nextAfterSeq: 0, hasMore: false }, true).done).toBe(true)
  })

  it('callEvents: time relative to the evaluation start, failed calls are bad, target joins the task slug', () => {
    const t0 = Date.UTC(2026, 9, 12, 12, 0, 0)
    const ev = callEvents([{ slug: 'tsk_webhook_dup', rows: [row(5), row(6, { ok: false, tool: 'edit' }), row(7, { target: null, ok: null })] }], t0)
    expect(ev[0]).toEqual({ tMs: 5000, tone: 'idle', label: 'Called bash', detail: 'tsk_webhook_dup · npm test 5' })
    expect(ev[1]).toEqual({ tMs: 6000, tone: 'bad', label: 'edit failed', detail: 'tsk_webhook_dup · npm test 6' })
    expect(ev[2]).toEqual({ tMs: 7000, tone: 'idle', label: 'Called bash', detail: 'tsk_webhook_dup' })
  })

  it('mergeByTime is stable', () => {
    const m = mergeByTime([{ tMs: 1, k: 'a' }, { tMs: 5, k: 'b' }], [{ tMs: 1, k: 'c' }, { tMs: 3, k: 'd' }])
    expect(m.map((e) => e.k)).toEqual(['a', 'c', 'd', 'b'])
  })
})

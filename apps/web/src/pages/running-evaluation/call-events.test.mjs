import assert from 'node:assert/strict'
import test from 'node:test'
import { appendPage, callEvents, EMPTY_FEED, mergeByTime } from './call-events.ts'

const row = (seq, over = {}) => ({ seq, tool: 'bash', target: `npm test ${seq}`, ok: true, occurredAt: new Date(Date.UTC(2026, 9, 12, 12, 0, seq)).toISOString(), ...over })

test('appendPage keeps rows in seq order, drops a repeated seq, and moves the cursor', () => {
  let f = appendPage(EMPTY_FEED, { actions: [row(1), row(2)], nextAfterSeq: 2, hasMore: false }, false)
  assert.deepEqual(f.rows.map((r) => r.seq), [1, 2])
  assert.equal(f.after, 2)
  assert.equal(f.done, false)
  f = appendPage(f, { actions: [row(2), row(3)], nextAfterSeq: 3, hasMore: false }, false)
  assert.deepEqual(f.rows.map((r) => r.seq), [1, 2, 3])
  assert.equal(f.after, 3)
})

test('a feed is done only when the run ended AND the last page had no more', () => {
  assert.equal(appendPage(EMPTY_FEED, { actions: [row(1)], nextAfterSeq: 1, hasMore: true }, true).done, false)
  assert.equal(appendPage(EMPTY_FEED, { actions: [row(1)], nextAfterSeq: 1, hasMore: false }, false).done, false)
  assert.equal(appendPage(EMPTY_FEED, { actions: [], nextAfterSeq: 0, hasMore: false }, true).done, true)
})

test('callEvents: time relative to the evaluation start, failed calls are bad, target joins the task slug', () => {
  const t0 = Date.UTC(2026, 9, 12, 12, 0, 0)
  const ev = callEvents([{ slug: 'tsk_webhook_dup', rows: [row(5), row(6, { ok: false, tool: 'edit' }), row(7, { target: null, ok: null })] }], t0)
  assert.deepEqual(ev[0], { tMs: 5000, tone: 'idle', label: 'Called bash', detail: 'tsk_webhook_dup · npm test 5' })
  assert.deepEqual(ev[1], { tMs: 6000, tone: 'bad', label: 'edit failed', detail: 'tsk_webhook_dup · npm test 6' })
  assert.deepEqual(ev[2], { tMs: 7000, tone: 'idle', label: 'Called bash', detail: 'tsk_webhook_dup' })
})

test('mergeByTime is stable', () => {
  const m = mergeByTime([{ tMs: 1, k: 'a' }, { tMs: 5, k: 'b' }], [{ tMs: 1, k: 'c' }, { tMs: 3, k: 'd' }])
  assert.deepEqual(m.map((e) => e.k), ['a', 'c', 'd', 'b'])
})

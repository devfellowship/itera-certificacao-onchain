/**
 * Event-log lines for the agent's tool calls (GET /runs/:id/actions), screen 04.
 * Pure, no imports besides types, so `node --test` loads it without a build step.
 */
import type { RunAction } from '../../lib/api/types'

export type CallTone = 'ok' | 'live' | 'idle' | 'bad'
export interface CallEvent {
  tMs: number
  tone: CallTone
  label: string
  detail: string | null
}

/** Cursor of one run's action rows: what is loaded, and whether the run has nothing more to give. */
export interface ActionFeed {
  rows: RunAction[]
  /** Pass this as after_seq on the next poll. */
  after: number
  /** True once the run ended and the last page came back with hasMore=false. */
  done: boolean
}

export const EMPTY_FEED: ActionFeed = { rows: [], after: 0, done: false }

/** Appends a page to a feed. A row already held (same seq) is ignored, so a repeated poll is harmless. */
export function appendPage(feed: ActionFeed, page: { actions: RunAction[]; nextAfterSeq: number; hasMore: boolean }, runEnded: boolean): ActionFeed {
  const have = new Set(feed.rows.map((r) => r.seq))
  const fresh = page.actions.filter((a) => !have.has(a.seq))
  return {
    rows: fresh.length ? [...feed.rows, ...fresh].sort((a, b) => a.seq - b.seq) : feed.rows,
    after: Math.max(feed.after, page.nextAfterSeq),
    done: runEnded && !page.hasMore,
  }
}

/** "Called bash" for a call that worked, "bash failed" for one that did not; the detail is `task · target`. */
export function callEvents(feeds: Array<{ slug: string; rows: RunAction[] }>, t0: number): CallEvent[] {
  const out: CallEvent[] = []
  for (const f of feeds) {
    for (const a of f.rows) {
      const at = Date.parse(a.occurredAt)
      if (!Number.isFinite(at)) continue
      out.push({
        tMs: Math.max(0, at - t0),
        tone: a.ok === false ? 'bad' : 'idle',
        label: a.ok === false ? `${a.tool} failed` : `Called ${a.tool}`,
        detail: a.target ? `${f.slug} · ${a.target}` : f.slug,
      })
    }
  }
  return out
}

/** Merge by time. Array.prototype.sort is stable, so lines at the same instant keep the API's order. */
export function mergeByTime<T extends { tMs: number }>(base: T[], extra: T[]): T[] {
  return [...base, ...extra].sort((a, b) => a.tMs - b.tMs)
}

import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Tabs } from '../ui'

export interface DetailTabItem<T extends string> {
  id: T
  label: string
  count?: number
}

/** The tabs row of a detail page, on top of the TMA `Tabs`. */
export function DetailTabs<T extends string>({ items, value, onChange, testId }: { items: DetailTabItem<T>[]; value: T; onChange: (id: T) => void; testId?: string }) {
  return (
    <div className="dt-tabs" data-testid={testId ?? 'detail-tabs'} data-tab={value}>
      <Tabs items={items} value={value} onChange={onChange} />
    </div>
  )
}

/**
 * The current tab lives in the URL: `?tab=<id>`. Other query params (`?v=`) stay as they are.
 * An unknown or absent value gives `fallback`.
 */
export function useTabParam<T extends string>(ids: readonly T[], fallback: T): [T, (id: T) => void] {
  const [search, setSearch] = useSearchParams()
  const raw = search.get('tab')
  const value = (ids as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback
  const set = useCallback(
    (id: T) => {
      setSearch(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set('tab', id)
          return next
        },
        { replace: true },
      )
    },
    [setSearch],
  )
  return [value, set]
}

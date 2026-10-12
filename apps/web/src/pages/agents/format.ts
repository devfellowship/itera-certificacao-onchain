const DAY = 86_400_000

/**
 * "today", "2 days ago", "1 week ago", "1 month ago". The API sends an ISO timestamp; a value that is
 * not a date (the design fixtures send the phrase) is shown as it is.
 */
export function relativeTime(when: string | null, now = Date.now()): string {
  if (!when) return ''
  const t = Date.parse(when)
  if (Number.isNaN(t)) return when
  const days = Math.max(0, Math.floor((now - t) / DAY))
  if (days < 1) return 'today'
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
  if (days < 30) {
    const w = Math.floor(days / 7)
    return `${w} week${w === 1 ? '' : 's'} ago`
  }
  if (days < 365) {
    const m = Math.floor(days / 30)
    return `${m} month${m === 1 ? '' : 's'} ago`
  }
  const y = Math.floor(days / 365)
  return `${y} year${y === 1 ? '' : 's'} ago`
}

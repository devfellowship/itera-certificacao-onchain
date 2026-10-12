import { useEffect, useRef, useState } from 'react'

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function fmtScore(n: number | null | undefined): string {
  if (n == null) return '—'
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export function fmtMemory(mb: number | null): string | null {
  if (mb == null) return null
  return mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* clipboard blocked: the value stays visible on the page */
  }
}

/** A key that shows "Copied" for a moment. */
export function useFlash(): [string | null, (k: string) => void] {
  const [k, setK] = useState<string | null>(null)
  const t = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(t.current), [])
  return [
    k,
    (key: string) => {
      setK(key)
      window.clearTimeout(t.current)
      t.current = window.setTimeout(() => setK(null), 1200)
    },
  ]
}

export const SECTIONS = [
  { id: 'goal', label: 'Goal' },
  { id: 'io', label: 'Input and output' },
  { id: 'tools', label: 'Tools' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'limits', label: 'Limits' },
  { id: 'scoring', label: 'Scoring' },
  { id: 'version', label: 'Version' },
  { id: 'results', label: 'Results' },
] as const

export function scrollToSection(id: string) {
  document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

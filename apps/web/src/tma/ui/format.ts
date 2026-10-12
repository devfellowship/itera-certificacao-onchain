/** Middle-truncate a hash or address: "7Tma4kE…n9QvA" (head 7, tail 5) or "7f3a…c91e" (4/4). */
export function middle(value: string, head = 4, tail = 4): string {
  if (value.length <= head + tail + 1) return value
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

/** SOL with a fixed number of decimals (balance 4, prices 5). */
export function formatSol(lamportsOrSol: number, { decimals = 5, fromLamports = false } = {}): string {
  const sol = fromLamports ? lamportsOrSol / 1_000_000_000 : lamportsOrSol
  return sol.toFixed(decimals)
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`
}

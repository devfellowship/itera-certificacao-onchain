/**
 * Accepts only a same-origin path ("/runs?x=1"). Anything else falls back, so a crafted `next`
 * cannot send the user to another site after login.
 */
export function safeInternalPath(next: string | null | undefined, fallback = '/'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback
  if (/[\u0000-\u001f]/.test(next)) return fallback
  return next
}

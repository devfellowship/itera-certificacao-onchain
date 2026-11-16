import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, setSessionToken, setUnauthorizedHandler } from './lib/api/client'

// S7 result diff: a private run answers /runs/:id/actions only with the owner's token (404 without it).
// A public page calls the same route with no session, and must not trigger the sign-in-again step.
const TOKEN = 'tma-session-token-test'
const OK = { actions: [], hasMore: false }

function fetchMock(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fn)
  return fn
}
function authOf(fn: ReturnType<typeof fetchMock>): string | undefined {
  const init = fn.mock.calls[0]![1]!
  return (init.headers as Record<string, string>).Authorization
}

beforeEach(() => {
  setSessionToken(null)
  setUnauthorizedHandler(null)
})
afterEach(() => {
  setSessionToken(null)
  setUnauthorizedHandler(null)
  vi.unstubAllGlobals()
})

describe('api.runActions auth', () => {
  it('sends the bearer token when a session exists', async () => {
    const fn = fetchMock(200, OK)
    setSessionToken(TOKEN)
    await api.runActions('run-1')
    expect(String(fn.mock.calls[0]![0])).toContain('/runs/run-1/actions')
    expect(authOf(fn)).toBe(`Bearer ${TOKEN}`)
  })

  it('sends no Authorization header when there is no session', async () => {
    const fn = fetchMock(200, OK)
    await api.runActions('run-1')
    expect(authOf(fn)).toBeUndefined()
  })

  it('does not trigger the sign-in-again step on a 401 (public pages)', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    setSessionToken(TOKEN)
    fetchMock(401, { error: 'unauthorized' })
    await expect(api.runActions('run-1')).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('keeps the sign-in-again step on a 401 for an authenticated call', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    setSessionToken(TOKEN)
    fetchMock(401, { error: 'unauthorized' })
    await expect(api.run('run-1')).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('keeps other public calls without a token', async () => {
    const fn = fetchMock(200, { servers: [] })
    setSessionToken(TOKEN)
    await api.mcpCatalog()
    expect(authOf(fn)).toBeUndefined()
  })
})

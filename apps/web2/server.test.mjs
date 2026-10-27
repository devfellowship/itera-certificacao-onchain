// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveCommit, server } from './server.mjs'

const SHA = '0123456789abcdef0123456789abcdef01234567'

describe('resolveCommit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web2-version-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('prefers the GIT_COMMIT env var', () => {
    expect(resolveCommit({ GIT_COMMIT: SHA }, join(dir, 'missing'))).toBe(SHA)
  })
  it('reads the file the Dockerfile writes, without a trailing newline requirement', () => {
    const f = join(dir, 'GIT_COMMIT')
    writeFileSync(f, `${SHA}\n`)
    expect(resolveCommit({}, f)).toBe(SHA)
  })
  it('answers unknown for a missing file, a bad value or the unknown marker', () => {
    expect(resolveCommit({}, join(dir, 'missing'))).toBe('unknown')
    const f = join(dir, 'bad')
    writeFileSync(f, 'not-a-sha')
    expect(resolveCommit({ GIT_COMMIT: 'XYZ' }, f)).toBe('unknown')
    writeFileSync(f, 'unknown')
    expect(resolveCommit({}, f)).toBe('unknown')
  })
})

describe('GET /version', () => {
  let base
  beforeAll(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => new Promise((resolve) => server.close(resolve)))

  it('answers JSON with the service and a commit, never cached', async () => {
    const res = await fetch(`${base}/version`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.service).toBe('tma-web2')
    expect(body.commit).toMatch(/^([0-9a-f]{40}|unknown)$/)
  })
  it('keeps /health as it was', async () => {
    const res = await fetch(`${base}/health`)
    expect(await res.text()).toBe('ok')
  })
})

// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// Social preview of testmyagent.com: X, LinkedIn and Slack read these tags from the static index.html
// (they do not run JS). The image must exist at the size the tags state.
describe('social preview meta (index.html + public/og-image.png)', () => {
  const dir = new URL('.', import.meta.url)
  const html = readFileSync(new URL('index.html', dir), 'utf8')
  const meta = (attr, key) => html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`))?.[1]

  it('states an English title, description and locale for Open Graph and X', () => {
    expect(meta('property', 'og:title')).toMatch(/^TestMyAgent/)
    expect(meta('name', 'twitter:title')).toBe(meta('property', 'og:title'))
    expect(meta('property', 'og:description')).toMatch(/AI agents/)
    expect(meta('name', 'twitter:description')).toBe(meta('property', 'og:description'))
    expect(meta('property', 'og:locale')).toBe('en_US')
    expect(meta('name', 'twitter:card')).toBe('summary_large_image')
  })

  it('points og:image and twitter:image to an absolute https URL of the committed 1200x630 PNG', () => {
    const image = meta('property', 'og:image')
    expect(image).toBe('https://testmyagent.com/og-image.png')
    expect(meta('name', 'twitter:image')).toBe(image)
    expect(meta('property', 'og:image:width')).toBe('1200')
    expect(meta('property', 'og:image:height')).toBe('630')
    expect(meta('property', 'og:image:alt')).toBeTruthy()
    const png = readFileSync(new URL('public/og-image.png', dir))
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(1200)
    expect(png.readUInt32BE(20)).toBe(630)
    expect(png.length).toBeLessThan(300 * 1024)
  })
})

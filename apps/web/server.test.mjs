import assert from 'node:assert/strict'
import { test } from 'node:test'
import { injectMeta, profileMeta } from './server.mjs'

const html = `<!doctype html><html><head><title>TestMyAgent</title><meta name="description" content="x" /></head><body><div id="root"></div></body></html>`
const profile = {
  slug: 'settlewise-7f3a',
  score: 78.6,
  counts: { pass: 3, fail: 1, invalid: 0 },
  tasks: [{}, {}, {}, {}],
  agent: { name: 'Settle<wise>', modelLabel: 'Claude Fable 5.1' },
  record: { status: 'Confirmed' },
  links: { og: 'https://api.test/public/evaluations/settlewise-7f3a/og.png' },
}

test('injects OG and Twitter meta for a profile', () => {
  const out = injectMeta(html, profileMeta(profile, 'https://web.test'))
  assert.match(out, /<title>Settle&lt;wise&gt; — 78.6 on TestMyAgent<\/title>/)
  assert.match(out, /<meta property="og:title" content="Settle&lt;wise&gt; — 78.6 on TestMyAgent" \/>/)
  assert.match(out, /<meta property="og:image" content="https:\/\/api.test\/public\/evaluations\/settlewise-7f3a\/og.png" \/>/)
  assert.match(out, /<meta name="twitter:card" content="summary_large_image" \/>/)
  assert.match(out, /<meta property="og:url" content="https:\/\/web.test\/e\/settlewise-7f3a" \/>/)
  assert.match(out, /content="3 of 4 tasks PASS · Claude Fable 5.1 · verified onchain"/)
  assert.ok(out.includes('<div id="root"></div>'))
  assert.equal(out.match(/<title>/g).length, 1)
})

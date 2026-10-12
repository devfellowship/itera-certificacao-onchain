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

test('GET /b/<slug>.svg redirects to the API badge, and only for a plain .svg name', async () => {
  const { handle } = await import('./server.mjs')
  const call = async (url) => {
    const out = { status: 0, headers: {} }
    await handle({ url, method: 'GET', headers: {} }, { writeHead: (s, h) => Object.assign(out, { status: s, headers: h }), end: () => {} })
    return out
  }
  const ok = await call('/b/settlewise-7f3a.svg')
  assert.equal(ok.status, 302)
  assert.equal(ok.headers.Location, 'https://itera-agent-credentials-api.devfellowship.com/b/settlewise-7f3a.svg')
  assert.match(ok.headers['Cache-Control'], /max-age=300/)
  const bad = await call('/b/..%2Fsecret')
  assert.notEqual(bad.status, 302)
})

test('injects OG and Twitter meta for a public task profile', async () => {
  const { taskMeta } = await import('./server.mjs')
  const task = {
    slug: 'tsk_webhook_dup',
    name: 'Duplicate <settlement> webhook',
    description: 'Second delivery must not double-credit the ledger.',
    tests: { label: 'sealed' },
    tools: [{ allowed: true }, { allowed: true }, { allowed: false }],
    mcp: { servers: [{}] },
    version: { number: 3 },
  }
  const out = injectMeta(html, taskMeta(task, 'https://web.test'))
  assert.match(out, /<title>Duplicate &lt;settlement&gt; webhook — task on TestMyAgent<\/title>/)
  assert.match(out, /<meta property="og:url" content="https:\/\/web.test\/tasks\/tsk_webhook_dup" \/>/)
  assert.match(out, /content="Second delivery must not double-credit the ledger. · sealed tests · 2 tools · 1 MCP server · v3"/)
  assert.match(out, /<meta name="twitter:card" content="summary" \/>/)
  assert.match(out, /<link rel="canonical" href="https:\/\/web.test\/tasks\/tsk_webhook_dup" \/>/)
  assert.equal(out.match(/<title>/g).length, 1)
})

test('GET /tasks/new and /tasks are served as the plain app shell', async () => {
  const { handle } = await import('./server.mjs')
  for (const url of ['/tasks/new', '/tasks']) {
    const out = { status: 0, body: '' }
    await handle({ url, method: 'GET', headers: {} }, { writeHead: (s) => (out.status = s), end: (b) => (out.body = String(b ?? '')) })
    assert.equal(out.status, 200)
    assert.ok(!out.body.includes('og:title'))
  }
})

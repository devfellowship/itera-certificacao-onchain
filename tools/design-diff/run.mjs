#!/usr/bin/env node
/**
 * Design diff — plan 20261012-itera-testmyagent-ui-refactor, U2 / U24.
 *
 *   npm run design-diff -- --page 01-agents|--all [--base <url>] [options]
 *
 * For each page of pages.json:
 *   expected    = tools/design-diff/reference/<id>.png (committed), or a fresh render of the design
 *                 .dc.html from a temp copy when --design-src <dir> is given (offline: only
 *                 127.0.0.1 and Google Fonts are reachable; body margin set to 0).
 *   implemented = our route at 1440 px, full page, in fixture mode (VITE_FIXTURE_MODE=design).
 *                 Without --base the script starts the Vite dev server in fixture mode itself.
 *   diff        = pixelmatch (threshold 0.1) after padding both images to the same size with the
 *                 page background and painting the page's masks on both.
 *               A second, strict pass (threshold 0.03) catches dark surfaces that 0.1 cannot see;
 *               PASS needs diffPct ≤ threshold AND strictDiffPct ≤ strictThreshold (default 2×).
 * Output (default tools/design-diff/out/): <id>.expected.png, <id>.implemented.png, <id>.diff.png,
 * <id>.diff-strict.png,
 * report.json ({pages: {<id>: {diffPct, threshold, pass, ...}}}) and report.html (expected ·
 * implemented · diff per page, one <tr data-page> per page).
 *
 * Options:
 *   --page <id>            one page (repeatable or comma separated)
 *   --all                  every page in pages.json
 *   --base <url>           app origin to screenshot (else a fixture-mode dev server is started)
 *   --design-src <dir>     re-render the reference from the design .dc.html files
 *   --update-reference     with --design-src: write the renders into reference/ (commit them)
 *   --out <dir>            output dir
 *   --upload               upload images + report.html with the supabase-upload skill script
 *                          (UPLOAD_CMD overrides it) and print the report URL
 *   --chrome <path>        Chrome/Chromium executable (default: Playwright's, else /usr/bin/google-chrome)
 * Exit: 0 every page PASS · 1 a page over its threshold · 2 usage or render error.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync, readdirSync, rmSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { chromium } from 'playwright'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const WIDTH = 1440
const BG = [0x0a, 0x09, 0x08]
const MASK = [0xff, 0x00, 0xff]

// ---------- args ----------
function parseArgs(argv) {
  const a = { pages: [], all: false, base: null, designSrc: null, updateReference: false, out: join(HERE, 'out'), upload: false, chrome: null }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = () => {
      const x = argv[++i]
      if (x == null) usage(`missing value for ${k}`)
      return x
    }
    if (k === '--page') a.pages.push(...v().split(','))
    else if (k === '--all') a.all = true
    else if (k === '--base') a.base = v().replace(/\/$/, '')
    else if (k === '--design-src') a.designSrc = resolve(v())
    else if (k === '--update-reference') a.updateReference = true
    else if (k === '--out') a.out = resolve(v())
    else if (k === '--upload') a.upload = true
    else if (k === '--chrome') a.chrome = v()
    else if (k === '--help' || k === '-h') usage()
    else usage(`unknown option ${k}`)
  }
  if (!a.all && a.pages.length === 0) usage('give --page <id> or --all')
  if (a.updateReference && !a.designSrc) usage('--update-reference needs --design-src')
  return a
}
function usage(msg) {
  if (msg) console.error(`design-diff: ${msg}`)
  console.error('usage: npm run design-diff -- --page <id>|--all [--base <url>] [--design-src <dir>] [--update-reference] [--out <dir>] [--upload]')
  process.exit(2)
}

// ---------- static server for the design copy ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.jpg': 'image/jpeg' }
function serveDir(dir) {
  return new Promise((ok) => {
    const srv = createServer((req, res) => {
      const p = join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname))
      if (!p.startsWith(dir) || !existsSync(p)) {
        res.statusCode = 404
        return res.end()
      }
      res.setHeader('Content-Type', MIME[extname(p)] ?? 'application/octet-stream')
      createReadStream(p).pipe(res)
    })
    srv.listen(0, '127.0.0.1', () => ok({ srv, url: `http://127.0.0.1:${srv.address().port}` }))
  })
}

/** Rewrites the default of design props in the temp copy (e.g. 04 phase=queued). The value is data, never code. */
function withProps(html, props) {
  let out = html
  for (const [key, value] of Object.entries(props ?? {})) {
    const enc = JSON.stringify(String(value)).replace(/"/g, '&quot;')
    const re = new RegExp(`(&quot;${key}&quot;:\\{[^}]*?&quot;default&quot;:)(&quot;[^&]*&quot;|true|false|-?\\d+)`)
    if (!re.test(out)) throw new Error(`design prop "${key}" not found`)
    out = out.replace(re, `$1${enc}`)
  }
  return out
}

// ---------- fixture-mode dev server ----------
async function startFixtureServer() {
  const port = 4300 + Math.floor(Math.random() * 500)
  const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: join(ROOT, 'apps/web'),
    env: { ...process.env, VITE_FIXTURE_MODE: 'design' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(base)
      if (r.ok) return { child, base }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  child.kill()
  throw new Error('fixture dev server did not start in 60 s')
}

// ---------- screenshots ----------
async function shoot(page, url, { offline = false, zeroMargin = false } = {}) {
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
  if (zeroMargin) await page.addStyleTag({ content: 'html,body{margin:0!important;background:#0a0908!important}' })
  await page.evaluate(() => document.fonts?.ready)
  await page.waitForTimeout(offline ? 1200 : 800)
  const buf = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' })
  return { png: PNG.sync.read(buf), errors }
}

/**
 * The design runtime (support.js) loads three pinned libraries from unpkg. The page itself stays
 * offline: these exact URLs are answered from a local cache (fetched once by Node), every other
 * request except 127.0.0.1 and Google Fonts is aborted.
 */
const VENDOR = new Set([
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js',
])
const VENDOR_DIR = join(process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? tmpdir(), '.cache'), 'tma-design-diff')
async function vendorBody(url) {
  const file = join(VENDOR_DIR, url.replace(/[^a-z0-9.@-]+/gi, '_'))
  if (!existsSync(file)) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`vendor fetch ${url}: ${res.status}`)
    mkdirSync(VENDOR_DIR, { recursive: true })
    writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  }
  return readFileSync(file)
}

async function newPage(browser, { offline }) {
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'reduce' })
  if (offline) {
    // Offline render of the untrusted design copy: only the local server and Google Fonts.
    await ctx.route('**/*', async (route) => {
      const href = route.request().url()
      if (VENDOR.has(href)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: await vendorBody(href) })
      const u = new URL(href)
      if (u.hostname === '127.0.0.1' || u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') return route.continue()
      return route.abort()
    })
  }
  return { ctx, page: await ctx.newPage() }
}

// ---------- diff ----------
function padTo(png, w, h) {
  if (png.width === w && png.height === h) return png
  const out = new PNG({ width: w, height: h })
  for (let i = 0; i < w * h; i++) out.data.set([...BG, 255], i * 4)
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0)
  return out
}
function paintMasks(png, masks) {
  for (const [x, y, w, h] of masks ?? []) {
    for (let yy = Math.max(0, y); yy < Math.min(png.height, y + h); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(png.width, x + w); xx++) png.data.set([...MASK, 255], (yy * png.width + xx) * 4)
  }
}
function diffImages(expected, implemented, masks) {
  const w = Math.max(expected.width, implemented.width)
  const h = Math.max(expected.height, implemented.height)
  const a = padTo(expected, w, h)
  const b = padTo(implemented, w, h)
  paintMasks(a, masks)
  paintMasks(b, masks)
  const diff = new PNG({ width: w, height: h })
  const n = pixelmatch(a.data, b.data, diff.data, w, h, { threshold: 0.1, alpha: 0.3 })
  // Strict pass: at threshold 0.1 pixelmatch cannot see a card surface (#141210) missing on the
  // page background (#0a0908), so an empty dark page scores low. Threshold 0.03 sees it.
  const strictDiff = new PNG({ width: w, height: h })
  const ns = pixelmatch(a.data, b.data, strictDiff.data, w, h, { threshold: 0.03, alpha: 0.3 })
  const pct = (x) => Math.round((x / (w * h)) * 10000) / 100
  return { diff, strictDiff, diffPixels: n, diffPct: pct(n), strictDiffPixels: ns, strictDiffPct: pct(ns), width: w, height: h }
}

// ---------- report ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
function reportHtml(report, src) {
  const rows = Object.entries(report.pages)
    .map(([id, p]) => {
      const verdict = p.error ? `<span class="bad">ERROR</span>` : p.pass ? `<span class="ok">PASS</span>` : `<span class="bad">FAIL</span>`
      const img = (k) => (p[k] ? `<a href="${esc(src(p[k]))}"><img loading="lazy" src="${esc(src(p[k]))}" alt="${esc(id)} ${k}"></a>` : '<span class="muted">—</span>')
      return `<tr data-page="${esc(id)}"><th><div class="id">${esc(p.title ?? id)}</div><div class="mono">${esc(p.route ?? '')}</div><div class="pct">${p.diffPct ?? '—'}%</div><div class="mono">≤ ${p.threshold}% · t=0.1</div><div class="mono">strict ${p.strictDiffPct ?? '—'}% (≤ ${p.strictThreshold}%) · t=0.03</div>${verdict}${p.error ? `<div class="mono bad">${esc(p.error)}</div>` : ''}${p.pageErrors?.length ? `<div class="mono bad">${p.pageErrors.length} pageerror</div>` : ''}</th><td>${img('expected')}</td><td>${img('implemented')}</td><td>${img('diff')}${p.diffStrict ? `<div class="mono" style="margin-top:8px">strict (t=0.03)</div>${img('diffStrict')}` : ''}</td></tr>`
    })
    .join('\n')
  const s = report.summary
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>testmyagent design diff</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#0a0908;color:#f4ede2;font:14px/1.5 system-ui,sans-serif}
header{padding:24px 32px;border-bottom:1px solid #2a2722}h1{margin:0 0 4px;font-size:22px}
.mono{font-family:ui-monospace,monospace;font-size:12px;color:#a2aaa1}.muted{color:#6e6a62}
table{border-collapse:collapse;width:100%}th,td{vertical-align:top;border-bottom:1px solid #2a2722;padding:16px}
thead th{position:sticky;top:0;background:#141210;text-align:left;font:500 11px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#a2aaa1}
tbody th{width:180px;text-align:left}.id{font-weight:600}.pct{font-size:28px;font-weight:600;margin-top:8px}
td{width:30%}td img{width:100%;display:block;border:1px solid #2a2722;border-radius:6px}
.ok{color:#8fe9b1;font:600 12px ui-monospace,monospace}.bad{color:#f39595;font:600 12px ui-monospace,monospace}
</style></head><body>
<header><h1>Design diff — expected vs implemented</h1>
<div class="mono">${esc(report.generatedAt)} · base ${esc(report.base)} · reference ${esc(report.referenceSource)} · ${WIDTH} px · pixelmatch threshold 0.1</div>
<div class="mono">${s.pass} PASS · ${s.fail} FAIL · ${s.error} ERROR of ${s.total} pages</div></header>
<table><thead><tr><th>Page</th><th>Expected (design)</th><th>Implemented</th><th>Diff</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>
`
}

function uploadFile(path) {
  const cmd = process.env.UPLOAD_CMD ?? 'bash /root/.claude/skills/supabase-upload/run.sh'
  const [bin, ...args] = cmd.split(' ')
  const out = execFileSync(bin, [...args, path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  const m = out.match(/"url"\s*:\s*"([^"]+)"/) ?? out.match(/https:\/\/media\.devfellowship\.com\/\S+/)
  if (!m) throw new Error(`upload gave no URL for ${path}`)
  return m[1] ?? m[0]
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const all = JSON.parse(readFileSync(join(HERE, 'pages.json'), 'utf8')).pages
  const pages = args.all ? all : args.pages.map((id) => all.find((p) => p.id === id) ?? usage(`unknown page ${id} (known: ${all.map((p) => p.id).join(', ')})`))
  mkdirSync(args.out, { recursive: true })
  const refDir = join(HERE, 'reference')

  let designTmp = null
  let designSrv = null
  if (args.designSrc) {
    designTmp = mkdtempSync(join(tmpdir(), 'tma-design-'))
    for (const f of readdirSync(args.designSrc)) if (f.endsWith('.dc.html') || f === 'support.js') cpSync(join(args.designSrc, f), join(designTmp, f))
    designSrv = await serveDir(designTmp)
  }
  let fixture = null
  const base = args.base ?? (fixture = await startFixtureServer()).base

  const executablePath = args.chrome ?? (existsSync(chromium.executablePath()) ? undefined : '/usr/bin/google-chrome')
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--font-render-hinting=none'] })
  const report = { generatedAt: new Date().toISOString(), base, width: WIDTH, referenceSource: args.designSrc ? 'design .dc.html (re-rendered)' : 'reference/*.png', pages: {} }
  try {
    for (const p of pages) {
      const r = { title: p.title, route: p.route, threshold: p.threshold }
      report.pages[p.id] = r
      try {
        // expected
        let expected
        if (designSrv) {
          let file = p.design
          if (p.props) {
            file = `${p.id}.variant.dc.html`
            writeFileSync(join(designTmp, file), withProps(readFileSync(join(designTmp, p.design), 'utf8'), p.props))
          }
          const { ctx, page } = await newPage(browser, { offline: true })
          expected = (await shoot(page, `${designSrv.url}/${encodeURIComponent(file)}`, { offline: true, zeroMargin: true })).png
          await ctx.close()
          if (args.updateReference) {
            mkdirSync(refDir, { recursive: true })
            writeFileSync(join(refDir, `${p.id}.png`), PNG.sync.write(expected))
          }
        } else {
          const ref = join(refDir, `${p.id}.png`)
          if (!existsSync(ref)) throw new Error(`no reference ${ref}; run with --design-src <dir> --update-reference`)
          expected = PNG.sync.read(readFileSync(ref))
        }
        writeFileSync(join(args.out, `${p.id}.expected.png`), PNG.sync.write(expected))
        r.expected = `${p.id}.expected.png`

        // implemented
        const { ctx, page } = await newPage(browser, { offline: false })
        const shot = await shoot(page, `${base}${p.route}`)
        await ctx.close()
        r.pageErrors = shot.errors
        writeFileSync(join(args.out, `${p.id}.implemented.png`), PNG.sync.write(shot.png))
        r.implemented = `${p.id}.implemented.png`

        // diff
        const d = diffImages(expected, shot.png, p.masks)
        writeFileSync(join(args.out, `${p.id}.diff.png`), PNG.sync.write(d.diff))
        writeFileSync(join(args.out, `${p.id}.diff-strict.png`), PNG.sync.write(d.strictDiff))
        r.strictThreshold = p.strictThreshold ?? p.threshold * 2
        Object.assign(r, { diff: `${p.id}.diff.png`, diffStrict: `${p.id}.diff-strict.png`, diffPct: d.diffPct, strictDiffPct: d.strictDiffPct, diffPixels: d.diffPixels, strictDiffPixels: d.strictDiffPixels, width: d.width, height: d.height, expectedSize: [expected.width, expected.height], implementedSize: [shot.png.width, shot.png.height] })
        r.pass = d.diffPct <= p.threshold && d.strictDiffPct <= r.strictThreshold
        console.log(`${r.pass ? 'PASS' : 'FAIL'} ${p.id.padEnd(16)} ${String(d.diffPct).padStart(6)}%  (≤ ${p.threshold}%)  strict ${String(d.strictDiffPct).padStart(6)}%  (≤ ${r.strictThreshold}%)  ${shot.errors.length ? shot.errors.length + ' pageerror' : ''}`)
      } catch (e) {
        r.error = e instanceof Error ? e.message : String(e)
        r.pass = false
        console.log(`ERROR ${p.id}: ${r.error}`)
      }
    }
  } finally {
    await browser.close()
    fixture?.child.kill()
    designSrv?.srv.close()
    if (designTmp) rmSync(designTmp, { recursive: true, force: true })
  }

  const list = Object.values(report.pages)
  report.summary = { total: list.length, pass: list.filter((x) => x.pass).length, fail: list.filter((x) => !x.pass && !x.error).length, error: list.filter((x) => x.error).length }
  writeFileSync(join(args.out, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(args.out, 'report.html'), reportHtml(report, (f) => f))
  console.log(`report: ${join(args.out, 'report.html')}`)

  if (args.upload) {
    const urls = {}
    for (const p of list) for (const k of ['expected', 'implemented', 'diff', 'diffStrict']) if (p[k]) urls[p[k]] = urls[p[k]] ?? uploadFile(join(args.out, p[k]))
    const uploaded = join(args.out, 'report.uploaded.html')
    writeFileSync(uploaded, reportHtml(report, (f) => urls[f] ?? f))
    report.reportUrl = uploadFile(uploaded)
    writeFileSync(join(args.out, 'report.json'), JSON.stringify(report, null, 2))
    console.log(`report url: ${report.reportUrl}`)
  }
  process.exit(report.summary.error ? 2 : report.summary.fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})

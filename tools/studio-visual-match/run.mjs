#!/usr/bin/env node
/**
 * Studio visual match: plan 20261112-tma-c5-studio-area-web2, task C5-VIS-MATCH.
 *
 *   npm run studio-visual-match -- [--screen S1,S5] [--judge] [--upload] [--base <origin>]
 *
 * For each screen of screens.json (the studio screens S1 to S13 of the design canvas):
 *   design = reference/<id>.png, the artboard rendered at its size (1440x960; S13 390x844). Refresh with
 *            --design-src <dir of the .dc.html files> --update-reference (the source is never committed;
 *            it renders offline: only 127.0.0.1 and Google Fonts are reachable).
 *   live   = the route on --base (default https://testmyagent.com), same viewport, signed in.
 * Both sides lose their app chrome before the compare (ADR-1: the web2 AppNav stays; the studio has no own top
 * bar or icon rail): the artboard's top <header> and left icon rail, and the live [data-testid=app-nav].
 * Then it writes out/<id>.pair.png (design left, live right), a pixel diff (information only: the artboards hold
 * illustrative data, the live page real data), and with --judge one vision-llm-judge --rubric-pair verdict
 * (function = the screen's actions, aesthetic = loose) with a 0-100 score. match = the judge's overall_pass.
 *
 * Sign-in (live pages are behind the login): the environment of scripts/e2e/tma-session.mjs, values never printed:
 *   TMA_E2E_DFL_EMAIL, TMA_E2E_DFL_PASSWORD, DFL_SUPABASE_URL, DFL_SUPABASE_ANON_KEY [, TMA_API_URL]
 * --anonymous skips it.
 *
 * Options:
 *   --screen <ids>        screens to run (comma separated or repeated); default all
 *   --base <origin>       live origin (default https://testmyagent.com)
 *   --judge               run the vision judge on each pair (JUDGE_CMD, default the vision-llm-judge skill)
 *   --judge-backend <b>   auto (default: vision-llm-judge, then the Claude CLI) | vision | claude
 *   --upload              upload each pair and report.html (UPLOAD_CMD, default the supabase-upload skill)
 *   --design-src <dir>    render the artboards from this dir instead of reference/
 *   --update-reference    with --design-src: write the renders into reference/ (commit them)
 *   --shim <file>         stand-in for the canvas runtime support.js (DC_SHIM; default the ui-design-compare skill shim)
 *   --out <dir>           output dir (default tools/studio-visual-match/out, git-ignored)
 *   --anonymous           no sign-in
 *   --chrome <path>       Chromium executable (CHROME_PATH; default Playwright's, else /usr/bin/google-chrome)
 * A screen with "optional" (a reason) whose route link is absent is UNAVAILABLE, not an error (S3: a fleet trace is
 * readable only through `tma studio serve` on the tailnet; the plan keeps S3 human-checkable).
 * Exit: 0 every capture ok (and, with --judge, every pair matches) · 1 a pair does not match · 2 usage, sign-in or capture error.
 */
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pixelmatch from 'pixelmatch'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import { claudeJudgePrompt, crop, extractJson, followLink, loadScreens, normalizeClaudeVerdict, padTo, pickScreens, scoreVerdict, sideBySide } from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REF = join(HERE, 'reference')
const SKILLS = '/root/.claude/skills'

function parseArgs(argv) {
  const a = { screens: [], base: 'https://testmyagent.com', judge: false, upload: false, designSrc: null, updateReference: false, shim: process.env.DC_SHIM ?? `${SKILLS}/ui-design-compare/dc-shim.js`, out: join(HERE, 'out'), anonymous: false, chrome: null, judgeBackend: 'auto' }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = () => {
      const x = argv[++i]
      if (x == null) usage(`missing value for ${k}`)
      return x
    }
    if (k === '--screen') a.screens.push(...v().split(',').filter(Boolean))
    else if (k === '--all') a.screens = []
    else if (k === '--base') a.base = v().replace(/\/$/, '')
    else if (k === '--judge') a.judge = true
    else if (k === '--judge-backend') a.judgeBackend = v()
    else if (k === '--upload') a.upload = true
    else if (k === '--design-src') a.designSrc = resolve(v())
    else if (k === '--update-reference') a.updateReference = true
    else if (k === '--shim') a.shim = resolve(v())
    else if (k === '--out') a.out = resolve(v())
    else if (k === '--anonymous') a.anonymous = true
    else if (k === '--chrome') a.chrome = v()
    else if (k === '--help' || k === '-h') usage()
    else usage(`unknown option ${k}`)
  }
  if (a.updateReference && !a.designSrc) usage('--update-reference needs --design-src')
  return a
}
function usage(msg) {
  if (msg) console.error(`studio-visual-match: ${msg}`)
  console.error('usage: npm run studio-visual-match -- [--screen S1,S5] [--judge] [--upload] [--base <origin>] [--design-src <dir> [--update-reference]] [--out <dir>] [--anonymous]')
  process.exit(2)
}

// ---------- sign-in (the flow of scripts/e2e/tma-session.mjs; nothing is printed or written) ----------
async function session() {
  const need = (n) => {
    const v = process.env[n]?.trim()
    if (!v) throw new Error(`set ${n} (or pass --anonymous)`)
    return v
  }
  const supabase = need('DFL_SUPABASE_URL').replace(/\/+$/, '')
  const r = await fetch(`${supabase}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: need('DFL_SUPABASE_ANON_KEY'), 'content-type': 'application/json' },
    body: JSON.stringify({ email: need('TMA_E2E_DFL_EMAIL'), password: need('TMA_E2E_DFL_PASSWORD') }),
  })
  const s = await r.json().catch(() => ({}))
  if (!r.ok || typeof s.access_token !== 'string') throw new Error(`DFL sign-in failed: HTTP ${r.status}`)
  const api = (process.env.TMA_API_URL?.trim() || 'https://itera-agent-credentials-api.devfellowship.com').replace(/\/+$/, '')
  const ex = await fetch(`${api}/auth/dfl/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dflToken: s.access_token }) })
  const e = await ex.json().catch(() => ({}))
  if (!ex.ok || typeof e.sessionToken !== 'string') throw new Error(`TMA exchange failed: HTTP ${ex.status}`)
  return JSON.stringify({ token: e.sessionToken, user: { id: e.user?.id, email: e.user?.email ?? '' } })
}

// ---------- design side: offline render of the untrusted artboard copy ----------
function serveDesign(dir, shim) {
  return new Promise((ok) => {
    const srv = createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '')
      if (rel.endsWith('support.js')) {
        res.setHeader('Content-Type', 'text/javascript')
        return res.end(readFileSync(shim))
      }
      const p = resolve(dir, rel)
      if (!p.startsWith(dir) || !existsSync(p)) {
        res.statusCode = 404
        return res.end()
      }
      res.setHeader('Content-Type', extname(p) === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream')
      createReadStream(p).pipe(res)
    })
    srv.listen(0, '127.0.0.1', () => ok({ srv, url: `http://127.0.0.1:${srv.address().port}` }))
  })
}

/** The canvas chrome to cut: the top <header> (the "tma eval studio" bar) and a left icon rail. */
async function designChrome(page) {
  return page.evaluate(() => {
    let top = 0
    let left = 0
    const header = [...document.querySelectorAll('header')].find((h) => h.getBoundingClientRect().top <= 1)
    if (header) top = Math.round(header.getBoundingClientRect().bottom)
    for (const n of document.querySelectorAll('nav')) {
      const r = n.getBoundingClientRect()
      if (r.left <= 1 && r.width <= 80 && r.height >= 200) left = Math.max(left, Math.round(r.right))
    }
    return { top, left }
  })
}

async function renderDesign(browser, srvUrl, s) {
  const [w, h] = s.viewport
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'reduce' })
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url())
    return u.hostname === '127.0.0.1' || u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com' ? route.continue() : route.abort()
  })
  const page = await ctx.newPage()
  try {
    await page.goto(`${srvUrl}/${encodeURIComponent(s.artboard)}`, { waitUntil: 'load', timeout: 60000 })
    await page.waitForSelector('html[data-dc-ready="1"]', { state: 'attached', timeout: 15000 })
    await page.evaluate(() => document.fonts?.ready)
    await page.waitForTimeout(800)
    const chrome = await designChrome(page)
    const png = PNG.sync.read(await page.screenshot({ animations: 'disabled', caret: 'hide' }))
    return { png, chrome }
  } finally {
    await ctx.close()
  }
}

// ---------- live side ----------
async function captureLive(browser, base, s, sessionValue) {
  const [w, h] = s.viewport
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'reduce' })
  if (sessionValue) await ctx.addInitScript((v) => { try { localStorage.setItem('tma2.session', v) } catch {} }, sessionValue)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200))) // armed before the first goto
  try {
    let path = s.route
    if (typeof s.route === 'object') {
      await page.goto(base + s.route.from, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
      await page.waitForTimeout(1500)
      const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')))
      path = followLink(hrefs, s.route)
      if (!path) {
        const e = new Error(`no link matching ${s.route.link} on ${s.route.from}`)
        e.unavailable = Boolean(s.optional)
        throw e
      }
    }
    await page.goto(base + path, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
    await page.evaluate(() => document.fonts?.ready)
    await page.waitForTimeout(1500)
    const info = await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="app-nav"]')
      return { top: nav ? Math.round(nav.getBoundingClientRect().bottom) : 0, mount: document.querySelector('#root')?.innerText.trim().length ?? 0, url: location.pathname + location.search }
    })
    const png = PNG.sync.read(await page.screenshot({ animations: 'disabled', caret: 'hide' }))
    return { png, chrome: { top: info.top, left: 0 }, path, url: info.url, mount: info.mount, pageErrors: errors }
  } finally {
    await ctx.close()
  }
}

// ---------- judge, upload ----------
function judgeCmd() {
  if (process.env.JUDGE_CMD) return process.env.JUDGE_CMD.split(' ')
  const skill = `${SKILLS}/vision-llm-judge/run.sh`
  if (!existsSync(skill)) throw new Error('--judge: set JUDGE_CMD (no vision-llm-judge skill on this host)')
  return ['bash', skill]
}

/** vision-llm-judge --rubric-pair. Returns the parsed report, or null when the judge wrote none or an error. */
function visionJudge(out, s) {
  const actions = join(out, `${s.id}.actions.json`)
  writeFileSync(actions, JSON.stringify({ actions: s.actions }, null, 2))
  const output = join(out, `${s.id}.judge.json`)
  let cmd
  try {
    cmd = judgeCmd()
  } catch {
    return null
  }
  const [bin, ...pre] = cmd
  const note = `${s.title}. A is the design artboard, B the live page; both had their app chrome cut away. A holds illustrative data and B real data: judge the layout, components and style, not the numbers or names.`
  try {
    execFileSync(bin, [...pre, '--rubric-pair', '--image-a', join(out, `${s.id}.design.png`), '--image-b', join(out, `${s.id}.live.png`), '--actions', actions, '--focus', 'function=loose,aesthetic=loose', '--screen-id', note, '--output', output], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 600000 })
  } catch {
    // exit 1 = the pair did not pass; the report file says why. No file = a judge failure.
  }
  if (!existsSync(output)) return null
  const rep = JSON.parse(readFileSync(output, 'utf8'))
  return rep.error || !rep.verdict ? null : rep
}

/** Fallback judge: Claude Code headless (CLAUDE_CMD, default `claude`), model JUDGE_MODEL (default sonnet), Read tool only. */
function claudeJudge(out, s) {
  const design = join(out, `${s.id}.design.png`)
  const live = join(out, `${s.id}.live.png`)
  const [bin, ...pre] = (process.env.CLAUDE_CMD ?? 'claude').split(' ')
  let text
  try {
    text = execFileSync(bin, [...pre, '-p', claudeJudgePrompt(s, design, live), '--model', process.env.JUDGE_MODEL ?? 'sonnet', '--allowedTools', 'Read', '--add-dir', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 600000, cwd: out })
  } catch {
    return null
  }
  const raw = extractJson(text)
  if (!raw) return null
  const rep = normalizeClaudeVerdict(raw, s)
  writeFileSync(join(out, `${s.id}.judge.json`), JSON.stringify(rep, null, 2))
  return rep
}

/** --judge: vision-llm-judge first; when it gives no verdict (no backend, quota), the Claude CLI judge. */
function runJudge(out, s, backend) {
  const rep = (backend !== 'claude' && visionJudge(out, s)) || (backend !== 'vision' && claudeJudge(out, s))
  if (!rep) return { score: null, match: false, reason: 'no judge gave a verdict' }
  return { ...scoreVerdict(rep), backend: rep.backend ?? 'vision-llm-judge' }
}

function uploadFile(path) {
  const cmd = process.env.UPLOAD_CMD ?? `bash ${SKILLS}/supabase-upload/run.sh`
  const [bin, ...args] = cmd.split(' ')
  const text = execFileSync(bin, [...args, path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  const m = text.match(/"url"\s*:\s*"([^"]+)"/) ?? text.match(/https:\/\/media\.devfellowship\.com\/\S+/)
  if (!m) throw new Error(`upload gave no URL for ${path}`)
  return m[1] ?? m[0]
}

// ---------- report ----------
const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
function reportHtml(report, src) {
  const rows = report.screens
    .map((r) => {
      const verdict = r.unavailable ? `<span class="muted">UNAVAILABLE</span><div class="mono">${esc(r.unavailable)}</div>` : r.error ? '<span class="bad">ERROR</span>' : r.judge ? (r.judge.match ? '<span class="ok">MATCH</span>' : '<span class="bad">NO MATCH</span>') : '<span class="muted">not judged</span>'
      const notes = r.judge ? [...(r.judge.diverges ?? []), ...(r.judge.missing ?? [])].map((n) => `<li>${esc(n)}</li>`).join('') : ''
      return `<tr data-screen="${esc(r.id)}"><th><div class="id">${esc(r.title)}</div><div class="mono">${esc(r.url ?? r.route ?? '')}</div>${verdict}<div class="pct">${r.judge?.score ?? '—'}</div><div class="mono">aesthetic ${r.judge?.aesthetic ?? '—'} · function ${r.judge?.function ?? '—'}${r.judge?.backend ? ` · ${esc(r.judge.backend)}` : ''}</div><div class="mono">pixel diff ${r.diffPct ?? '—'}% (info)</div><div class="mono">mount ${r.mount ?? '—'} · pageerror ${r.pageErrors?.length ?? '—'}</div>${r.error ? `<div class="mono bad">${esc(r.error)}</div>` : ''}${notes ? `<ul class="notes">${notes}</ul>` : ''}</th><td>${r.pair ? `<a href="${esc(src(r.pair))}"><img loading="lazy" src="${esc(src(r.pair))}" alt="${esc(r.id)} design and live"></a>` : '—'}</td></tr>`
    })
    .join('\n')
  const s = report.summary
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Studio visual match</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#0a0908;color:#f6f1e7;font:14px/1.5 system-ui,sans-serif}
header{padding:24px 32px;border-bottom:1px solid #2a2622}h1{margin:0 0 4px;font-size:22px}
.mono{font-family:ui-monospace,monospace;font-size:12px;color:#a2aaa1}.muted{color:#887f71;font:600 12px ui-monospace,monospace}
table{border-collapse:collapse;width:100%}th,td{vertical-align:top;border-bottom:1px solid #2a2622;padding:16px}
tbody th{width:260px;text-align:left;font-weight:400}.id{font-weight:600}.pct{font-size:28px;font-weight:600;margin-top:6px}
td img{width:100%;display:block;border:1px solid #2a2622;border-radius:4px}.notes{margin:8px 0 0;padding-left:16px;font-size:12px;color:#c9c0b4}
.ok{color:#3fd17f;font:600 12px ui-monospace,monospace}.bad{color:#e07a7a;font:600 12px ui-monospace,monospace}
</style></head><body>
<header><h1>Studio visual match: design artboard (left) vs live page (right)</h1>
<div class="mono">${esc(report.generatedAt)} · ${esc(report.base)} · app chrome cut on both sides (ADR-1) · judge: rubric pair (vision-llm-judge or Claude CLI), function=loose, aesthetic=loose</div>
<div class="mono">${s.match} match · ${s.noMatch} no match · ${s.notJudged} not judged · ${s.unavailable} unavailable · ${s.error} error of ${s.total} screens</div></header>
<table><tbody>
${rows}
</tbody></table></body></html>
`
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const screens = pickScreens(loadScreens(readFileSync(join(HERE, 'screens.json'), 'utf8')), args.screens)
  mkdirSync(args.out, { recursive: true })
  const sessionValue = args.anonymous ? null : await session()
  const executablePath = args.chrome ?? process.env.CHROME_PATH ?? (existsSync(chromium.executablePath()) ? undefined : '/usr/bin/google-chrome')
  const browser = await chromium.launch({ executablePath, args: ['--font-render-hinting=none'] })
  const design = args.designSrc ? await serveDesign(args.designSrc, args.shim) : null
  const chromeFile = join(REF, 'chrome.json')
  const chromeMap = existsSync(chromeFile) ? JSON.parse(readFileSync(chromeFile, 'utf8')) : {}
  const report = { generatedAt: new Date().toISOString(), base: args.base, screens: [] }
  try {
    for (const s of screens) {
      const r = { id: s.id, title: s.title, route: typeof s.route === 'string' ? s.route : `${s.route.from} -> ${s.route.link}` }
      report.screens.push(r)
      try {
        // design
        let d
        if (design) {
          d = await renderDesign(browser, design.url, s)
          if (args.updateReference) {
            mkdirSync(REF, { recursive: true })
            writeFileSync(join(REF, `${s.id}.png`), PNG.sync.write(d.png))
            chromeMap[s.id] = d.chrome
          }
        } else {
          const ref = join(REF, `${s.id}.png`)
          if (!existsSync(ref) || !chromeMap[s.id]) throw new Error(`no reference for ${s.id}; run with --design-src <dir> --update-reference`)
          d = { png: PNG.sync.read(readFileSync(ref)), chrome: chromeMap[s.id] }
        }
        const dc = crop(d.png, [d.chrome.left, d.chrome.top, d.png.width - d.chrome.left, d.png.height - d.chrome.top])
        writeFileSync(join(args.out, `${s.id}.design.png`), PNG.sync.write(dc))

        // live
        const l = await captureLive(browser, args.base, s, sessionValue)
        Object.assign(r, { url: l.url, mount: l.mount, pageErrors: l.pageErrors })
        const lc = crop(l.png, [0, l.chrome.top, l.png.width, l.png.height - l.chrome.top])
        writeFileSync(join(args.out, `${s.id}.live.png`), PNG.sync.write(lc))
        writeFileSync(join(args.out, `${s.id}.pair.png`), PNG.sync.write(sideBySide(dc, lc)))
        r.pair = `${s.id}.pair.png`

        // pixel diff (information only)
        const w = Math.max(dc.width, lc.width)
        const h = Math.max(dc.height, lc.height)
        const diff = new PNG({ width: w, height: h })
        const n = pixelmatch(padTo(dc, w, h).data, padTo(lc, w, h).data, diff.data, w, h, { threshold: 0.1, alpha: 0.3 })
        r.diffPct = Math.round((n / (w * h)) * 10000) / 100

        if (args.judge) r.judge = runJudge(args.out, s, args.judgeBackend)
        console.log(`${s.id.padEnd(5)} ${r.judge ? (r.judge.match ? 'MATCH   ' : 'NO MATCH') : 'pair    '} score ${String(r.judge?.score ?? '—').padStart(3)}  pixel ${String(r.diffPct).padStart(6)}%  mount ${l.mount}  pageerror ${l.pageErrors.length}  ${l.url}`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (e?.unavailable) {
          r.unavailable = `${msg} (${s.optional})`
          console.log(`${s.id.padEnd(5)} UNAVAILABLE ${r.unavailable}`)
        } else {
          r.error = msg
          console.log(`${s.id.padEnd(5)} ERROR ${r.error}`)
        }
      }
    }
  } finally {
    await browser.close()
    design?.srv.close()
  }
  if (args.updateReference) writeFileSync(chromeFile, JSON.stringify(chromeMap, null, 2) + '\n')

  const list = report.screens
  report.summary = {
    total: list.length,
    match: list.filter((r) => r.judge?.match).length,
    noMatch: list.filter((r) => r.judge && !r.judge.match).length,
    notJudged: list.filter((r) => !r.judge && !r.error && !r.unavailable).length,
    unavailable: list.filter((r) => r.unavailable).length,
    error: list.filter((r) => r.error).length,
  }
  writeFileSync(join(args.out, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(args.out, 'report.html'), reportHtml(report, (f) => f))
  if (args.upload) {
    const urls = {}
    for (const r of list) if (r.pair) r.pairUrl = urls[r.pair] = uploadFile(join(args.out, r.pair))
    const up = join(args.out, 'report.uploaded.html')
    writeFileSync(up, reportHtml(report, (f) => urls[f] ?? f))
    report.reportUrl = uploadFile(up)
    writeFileSync(join(args.out, 'report.json'), JSON.stringify(report, null, 2))
    console.log(`report url: ${report.reportUrl}`)
  }
  console.log(`${report.summary.match} match · ${report.summary.noMatch} no match · ${report.summary.notJudged} not judged · ${report.summary.unavailable} unavailable · ${report.summary.error} error · ${join(args.out, 'report.html')}`)
  process.exit(report.summary.error ? 2 : report.summary.noMatch ? 1 : 0)
}

main().catch((e) => {
  console.error(`studio-visual-match: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(2)
})

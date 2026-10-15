#!/usr/bin/env node
/**
 * verify-render.mjs — one-shot browser check that a page RENDERED, with data (T12).
 *
 * A copy of the logic of the DFL `prod-loop-verify/verify-render.mjs` helper, kept in this repo
 * because that path does not exist in CI. A crashed SPA answers HTTP 200, with the right URL and
 * title, and a blank mount element. So the check asserts three things, and refuses to certify
 * without the third:
 *   1. MOUNT      the root element is non-empty.
 *   2. NO ERRORS  zero `pageerror` events. The listener is armed BEFORE `goto`.
 *   3. CONTROL    a positive-data selector is present (--min-count 'SEL=N'). An empty state
 *                 renders successfully and proves nothing.
 *
 * Usage:
 *   node scripts/e2e/verify-render.mjs --url URL --min-count '[data-testid=login-dfl]=1' [--root '#root'] [--skip-on-nxdomain]
 *   node scripts/e2e/verify-render.mjs --self-test
 *
 * Exit codes:
 *    0 certified
 *    2 empty mount        4 control failed       5 no control given (refused)
 *    3 page error         6 transport / browser  7 bad args
 *   10 skipped (--skip-on-nxdomain and the host name does not resolve: NXDOMAIN / ENOTFOUND)
 * Any other DNS or network error is a failure (6), never a skip.
 */
import { lookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

export const EXIT = { ok: 0, emptyMount: 2, pageError: 3, controlFailed: 4, noControl: 5, transport: 6, badArgs: 7, skipped: 10 };

export function parseMinCount(spec) {
  // Split on the LAST '=' so an attribute selector like [data-testid=login-dfl]=1 survives.
  const i = spec.lastIndexOf('=');
  const selector = i > 0 ? spec.slice(0, i).trim() : '';
  const raw = spec.slice(i + 1).trim();
  if (!selector || !/^[1-9]\d*$/.test(raw)) throw new Error(`--min-count needs 'SELECTOR=N' with N a positive integer, got '${spec}'`);
  return { selector, min: Number(raw) };
}

export function parseArgs(argv) {
  const o = { minCount: [], root: '#root', timeout: 15000, controlTimeout: 20000, skipOnNxdomain: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--self-test') o.selfTest = true;
    else if (k === '--skip-on-nxdomain') o.skipOnNxdomain = true;
    else if (['--url', '--root', '--min-count', '--timeout', '--control-timeout'].includes(k)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      if (k === '--min-count') o.minCount.push(parseMinCount(v));
      else if (k === '--url') o.url = v;
      else if (k === '--root') o.root = v;
      else o[k === '--timeout' ? 'timeout' : 'controlTimeout'] = Number(v);
    } else throw new Error(`unknown argument ${k}`);
  }
  return o;
}

/** True only for "this name does not exist" (NXDOMAIN). A temporary resolver failure (EAI_AGAIN) is not. */
export async function isNxdomain(hostname, resolver = lookup) {
  try {
    await resolver(hostname);
    return false;
  } catch (err) {
    return err?.code === 'ENOTFOUND';
  }
}

/** Arm the collectors BEFORE the navigation. */
export function armErrors(page) {
  const bag = { pageErrors: [] };
  page.on('pageerror', (e) => bag.pageErrors.push(String(e?.stack || e).slice(0, 500)));
  return bag;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs the three assertions on a page that was already navigated. Returns { code, name, checks }. */
export async function assertRendered(page, errors, opts) {
  const checks = [];
  const finish = (code, name) => ({ code, name, checks });

  // 1. MOUNT: the root is non-empty. Poll, because an SPA mounts after the first paint.
  const start = Date.now();
  let mounted = false;
  while (Date.now() - start < opts.timeout) {
    mounted = await page
      .evaluate((sel) => {
        const el = document.querySelector(sel);
        return Boolean(el && (el.childElementCount > 0 || (el.textContent || '').trim().length > 0));
      }, opts.root)
      .catch(() => false);
    if (mounted) break;
    await sleep(250);
  }
  checks.push({ name: 'mount', ok: mounted, detail: mounted ? `${opts.root} is non-empty` : `${opts.root} is empty after ${opts.timeout} ms` });
  if (!mounted) return finish(EXIT.emptyMount, 'empty-mount');

  // 3. CONTROL (before the error read, so late errors of a slow render are still collected): all counts must hold.
  if (opts.minCount.length === 0) {
    checks.push({ name: 'control', ok: false, detail: 'no --min-count given: refused to certify' });
    return finish(EXIT.noControl, 'no-control');
  }
  const cStart = Date.now();
  let counts = [];
  let allMet = false;
  while (true) {
    counts = await Promise.all(opts.minCount.map(async (c) => ({ ...c, got: await page.locator(c.selector).count().catch(() => 0) })));
    allMet = counts.every((c) => c.got >= c.min);
    if (allMet || Date.now() - cStart >= opts.controlTimeout) break;
    await sleep(250);
  }
  for (const c of counts) checks.push({ name: `control ${c.selector}`, ok: c.got >= c.min, detail: `${c.got} match(es), need >= ${c.min}` });

  // 2. NO ERRORS: zero pageerror events over the whole visit.
  const clean = errors.pageErrors.length === 0;
  checks.push({ name: 'no-pageerror', ok: clean, detail: clean ? 'zero pageerror events' : errors.pageErrors[0].split('\n')[0] });
  if (!clean) return finish(EXIT.pageError, 'page-error');
  if (!allMet) return finish(EXIT.controlFailed, 'control-failed');
  return finish(EXIT.ok, 'ok');
}

function report(url, httpStatus, r) {
  console.log(`URL    ${url}`);
  console.log(`HTTP   ${httpStatus}   (green here proves nothing on its own)`);
  for (const c of r.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
  console.log(`RESULT ${r.name}`);
}

async function launch() {
  const { chromium } = await import('playwright');
  // CHROME_BIN: a system Chrome for hosts where Playwright has no matching download. CI uses the Playwright chromium.
  return process.env.CHROME_BIN ? chromium.launch({ executablePath: process.env.CHROME_BIN, args: ['--no-sandbox'] }) : chromium.launch();
}

async function selfTest(browser) {
  const html = (body, script = '') => 'data:text/html,' + encodeURIComponent(`<!doctype html><html><head><title>t</title></head><body>${body}<script>${script}</script></body></html>`);
  const cases = [
    { name: 'broken SPA (blank root + pageerror)', url: html('<div id="root">x</div>', "setTimeout(function(){document.getElementById('root').innerHTML='';var d;d.find(1)},50)"), min: 'p=1', want: [EXIT.emptyMount, EXIT.pageError] },
    { name: 'renders, no pageerror, control absent', url: html('<div id="root"><h1>Empty</h1></div>'), min: 'li=1', want: [EXIT.controlFailed] },
    { name: 'renders with the control', url: html('<div id="root"><ul><li>a</li></ul></div>'), min: 'li=1', want: [EXIT.ok] },
    { name: 'pageerror after a good render', url: html('<div id="root"><ul><li>a</li></ul></div>', "setTimeout(function(){var d;d.find(1)},100)"), min: 'li=1', want: [EXIT.pageError], settle: 600 },
  ];
  let failed = false;
  for (const c of cases) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = armErrors(page);
    await page.goto(c.url);
    if (c.settle) await sleep(c.settle);
    const r = await assertRendered(page, errors, { root: '#root', timeout: 1500, controlTimeout: 1500, minCount: [parseMinCount(c.min)] });
    const ok = c.want.includes(r.code);
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'} self-test: ${c.name} -> ${r.name} (exit ${r.code})`);
    await ctx.close();
  }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(html('<div id="root"><p>hi</p></div>'));
  const r = await assertRendered(page, armErrors(page), { root: '#root', timeout: 1000, controlTimeout: 500, minCount: [] });
  const refused = r.code === EXIT.noControl;
  if (!refused) failed = true;
  console.log(`${refused ? 'PASS' : 'FAIL'} self-test: a page with no control is refused -> ${r.name}`);
  await ctx.close();
  return failed ? 1 : 0;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`bad args: ${e.message}`);
    return EXIT.badArgs;
  }
  if (!o.selfTest && !o.url) {
    console.error('bad args: --url is required');
    return EXIT.badArgs;
  }
  if (!o.selfTest && o.minCount.length === 0) {
    console.error('refused: give at least one --min-count (a positive-data control). A page with no control certifies nothing.');
    return EXIT.noControl;
  }
  if (!o.selfTest && o.skipOnNxdomain) {
    const host = new URL(o.url).hostname;
    if (await isNxdomain(host)) {
      console.log(`URL    ${o.url}`);
      console.log(`RESULT skip: ${host} does not resolve (NXDOMAIN). The deploy may not exist yet.`);
      return EXIT.skipped;
    }
  }
  let browser;
  try {
    browser = await launch();
  } catch (e) {
    console.error(`browser launch failed: ${e.message}`);
    return EXIT.transport;
  }
  try {
    if (o.selfTest) return await selfTest(browser);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = armErrors(page); // BEFORE goto
    let resp;
    try {
      resp = await page.goto(o.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      console.error(`navigation failed: ${String(e.message).split('\n')[0]}`);
      return EXIT.transport;
    }
    const r = await assertRendered(page, errors, o);
    report(o.url, resp ? resp.status() : 'n/a', r);
    return r.code;
  } finally {
    await browser.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c)).catch((e) => {
    console.error(e);
    process.exit(EXIT.transport);
  });
}

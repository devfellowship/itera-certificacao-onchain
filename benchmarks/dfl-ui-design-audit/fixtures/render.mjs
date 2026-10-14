#!/usr/bin/env node
// Renders the design PNGs and the bounding boxes of the ui-design-audit task, with the SAME
// Chromium and fonts that the agent's browser@1 sidecar uses: run it inside the browser@1 image.
//
//   docker run --rm -v "$PWD/benchmarks/dfl-ui-design-audit:/task" -e TMPDIR=/tmp -e HOME=/tmp --entrypoint node \
//     testmyagent-mcp-browser:dev /task/fixtures/render.mjs
//
// Writes:
//   environment/designs/<screen>-<1280|390>.png   the golden design (design.local), full page
//   tests/hidden/bboxes.json                      [x, y, w, h] of every key element, per build,
//                                                 viewport and screen (the grader's IoU fallback)
// And checks that every injected defect is VISIBLE: the pixels of its region differ between the
// golden build and the app build at its viewport. Exit 1 when one does not.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createRequire } from 'node:module';

const task = process.env.TASK_DIR ?? '/task';
const require = createRequire('/itera/upstream/package.json');
const { chromium } = require('playwright-core');
const seed = JSON.parse(readFileSync(join(task, 'mcp/browser/seed.json'), 'utf-8'));
const key = JSON.parse(readFileSync(join(task, 'tests/hidden/key.json'), 'utf-8'));
const VIEWPORTS = { 1280: { width: 1280, height: 800 }, 390: { width: 390, height: 844 } };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const fileFor = (host, pathname) => {
  const files = seed.hosts[host]?.files ?? {};
  const rel = pathname.replace(/^\/+/, '');
  for (const c of rel === '' ? ['index.html'] : [rel, `${rel}.html`, `${rel}/index.html`]) if (files[c] !== undefined) return [c, files[c]];
  return null;
};

const wanted = new Set([...key.defects.flatMap((d) => d.match_testids), ...key.decoys.map((d) => d.testid)]);
const browser = await chromium.launch({ executablePath: '/itera/chromium', args: ['--disable-dev-shm-usage'] });
const boxes = { design: {}, app: {} };
const shots = {};
try {
  for (const [vp, size] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC' });
    await ctx.route('**/*', (route) => {
      const u = new URL(route.request().url());
      const f = fileFor(u.hostname, u.pathname);
      if (!f) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ status: 200, contentType: TYPES[extname(f[0])] ?? 'application/octet-stream', body: typeof f[1] === 'string' ? f[1] : Buffer.from(f[1].base64, 'base64') });
    });
    const page = await ctx.newPage();
    for (const [build, host] of [['design', 'design.local'], ['app', 'app.local']]) {
      for (const [screen, path] of Object.entries(key.screens)) {
        await page.goto(`http://${host}${path}`, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        const found = await page.evaluate((ids) => {
          const out = {};
          for (const el of document.querySelectorAll('[data-testid]')) {
            const id = el.getAttribute('data-testid');
            if (!ids.includes(id) || out[id]) continue;
            const r = el.getBoundingClientRect();
            out[id] = [Math.round(r.x + window.scrollX), Math.round(r.y + window.scrollY), Math.round(r.width), Math.round(r.height)];
          }
          return out;
        }, [...wanted]);
        ((boxes[build][vp] ??= {})[screen] = found);
        const png = await page.screenshot({ fullPage: true });
        shots[`${build}:${vp}:${screen}`] = png;
        // Optional: the app renders too, for a side-by-side check by hand (not committed).
        if (build === 'app' && process.env.APP_SHOTS_DIR) writeFileSync(join(process.env.APP_SHOTS_DIR, `app-${screen}-${vp}.png`), png);
        if (build === 'design') {
          mkdirSync(join(task, 'environment/designs'), { recursive: true });
          writeFileSync(join(task, 'environment/designs', `${screen}-${vp}.png`), png);
        }
      }
    }
    // Visibility: the defect region, cut from both full-page renders, must differ.
    for (const d of key.defects) {
      if (d.viewport !== 'both' && d.viewport !== vp) continue;
      const b = d.match_testids.map((id) => boxes.design[vp]?.[d.screen]?.[id] ?? boxes.app[vp]?.[d.screen]?.[id]).find(Boolean);
      const a = d.match_testids.map((id) => boxes.app[vp]?.[d.screen]?.[id]).find(Boolean) ?? b;
      if (!b) throw new Error(`${d.id}: no box for ${d.match_testids.join('/')} at ${vp}`);
      const x = Math.max(0, Math.min(a[0], b[0]) - 4);
      const y = Math.max(0, Math.min(a[1], b[1]) - 4);
      const w = Math.max(a[0] + a[2], b[0] + b[2]) - x + 8;
      const h = Math.max(a[1] + a[3], b[1] + b[3]) - y + 8;
      const crop = async (build) => {
        const p = await ctx.newPage();
        await p.setContent(`<body style="margin:0"><img id="i" src="data:image/png;base64,${shots[`${build}:${vp}:${d.screen}`].toString('base64')}"></body>`);
        await p.evaluate(() => document.getElementById('i').decode());
        const buf = await p.screenshot({ clip: { x, y, width: Math.max(1, w), height: Math.max(1, h) }, fullPage: true });
        await p.close();
        return buf;
      };
      const same = Buffer.compare(await crop('design'), await crop('app')) === 0;
      console.log(`${same ? 'INVISIBLE' : 'visible  '} ${d.id} ${d.type} ${d.screen}@${vp} [${x},${y},${w},${h}]`);
      if (same) process.exitCode = 1;
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(task, 'tests/hidden/bboxes.json'), `${JSON.stringify(boxes, null, 1)}\n`);
console.log(`wrote environment/designs/*.png (6) and tests/hidden/bboxes.json`);

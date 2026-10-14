// Self-test of the image (the default CMD; CI runs it with the grader's isolation flags). It proves
// that Chromium starts offline as uid 10002 on a read-only rootfs, that a page error is caught, that a
// network request is blocked, and that axe-core finds a contrast violation and passes a good page.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { axe, AXE_VERSION, launch } from './lib.mjs';

const dir = mkdtempSync(join(tmpdir(), 'grader-selftest-'));
const good = join(dir, 'good.html');
const bad = join(dir, 'bad.html');
writeFileSync(good, '<!doctype html><html lang="en"><meta charset="utf-8"><title>ok</title><body style="background:#111;color:#eee"><h1>Report ✓</h1><div class="bar" style="width:40px;height:8px;background:#6cf"></div></body></html>');
writeFileSync(bad, '<!doctype html><html lang="en"><meta charset="utf-8"><title>bad</title><body style="background:#fff"><p style="color:#eee">low contrast</p><img src="https://example.com/x.png" alt=""><script>throw new Error("boom")</script></body></html>');

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });
const b = await launch();
try {
  const g = await b.open(good);
  check('mounts and renders text', (await g.page.innerText('body')).includes('Report ✓'));
  check('no page error on the good page', g.pageErrors.length === 0, g.pageErrors.join('; '));
  check('axe passes the good page', (await axe(g.page)).length === 0);
  const m = await b.open(bad, { width: 390, height: 844 });
  check('a thrown error is caught as pageerror', m.pageErrors.some((e) => e.includes('boom')));
  check('a network request is blocked', m.blocked.some((u) => u.startsWith('https://example.com')));
  check('axe finds the contrast violation', (await axe(m.page)).some((v) => v.id === 'color-contrast'));
} finally {
  await b.close();
}
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
console.log(`chromium ${b.version}, axe-core ${AXE_VERSION}: ${checks.filter((c) => c.ok).length}/${checks.length}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);

#!/usr/bin/env node
// Builds the reference solution of dfl-html-report from environment/data/usage.json:
//   solution/solution.patch   adds out/report.html and out/result.json (unified diff, git format)
//   solution/mcp-calls.jsonl  the one upload_file call that the validation gate replays
// The report is deterministic: the same data gives the same bytes, so the url (M-1001, the first
// upload with ITERA_MCP_ID_SEED=1000) and the sha256 in out/result.json are known in advance.
//
//   node fixtures/build-solution.mjs        (run from benchmarks/dfl-html-report)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const data = JSON.parse(readFileSync(join(root, 'environment/data/usage.json'), 'utf-8'));
const UPLOAD_URL = 'https://media.fixture.test/M-1001';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtInt = (n) => n.toLocaleString('en-US');
const fmtUsd = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = { volume: fmtInt, cost_usd: fmtUsd, checkability: (n) => String(n) };
const types = data.task_types;

function bars(metric) {
  const rows = types.filter((t) => t[metric].value !== null).sort((a, b) => b[metric].value - a[metric].value);
  const max = rows[0][metric].value;
  const missing = types.filter((t) => t[metric].value === null);
  return `<ol class="bars">
${rows
  .map((t) => {
    const pct = ((t[metric].value / max) * 100).toFixed(1);
    const mark = t[metric].inferred ? ' <span class="mark" title="inferred">*</span>' : '';
    return `  <li><span class="label">${esc(t.name)}</span><span class="track"><span class="bar" data-bar="${metric}" data-task="${t.id}" style="width:${pct}%"></span></span><span class="val">${fmt[metric](t[metric].value)}${mark}</span></li>`;
  })
  .join('\n')}
</ol>
${missing.map((t) => `<p class="missing">${esc(t.name)}: no data</p>`).join('\n')}`;
}

function cell(t, metric) {
  const v = t[metric];
  if (v.value === null) return `<td data-metric="${metric}" class="nodata">no data</td>`;
  if (v.inferred) return `<td data-metric="${metric}" class="inferred">${fmt[metric](v.value)} <span class="mark">*</span></td>`;
  return `<td data-metric="${metric}">${fmt[metric](v.value)}</td>`;
}

const totalVolume = types.reduce((n, t) => n + (t.volume.value ?? 0), 0);
const totalCost = Math.round(types.reduce((n, t) => n + (t.cost_usd.value ?? 0), 0) * 100) / 100;

const report = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent task types</title>
<style>
:root { --bg: #0f1115; --panel: #181b22; --text: #e8eaf0; --muted: #a9b0bf; --bar: #5b8def; --bar2: #3fb68b; --mark: #f5c451; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
h1 { font-size: 1.5rem; margin: 0 0 4px; }
h2 { font-size: 1.1rem; margin: 28px 0 8px; }
.sub, .legend { color: var(--muted); }
section { background: var(--panel); border-radius: 8px; padding: 12px 16px; margin-top: 16px; }
.bars { list-style: none; margin: 0; padding: 0; }
.bars li { display: grid; grid-template-columns: minmax(0, 12rem) minmax(0, 1fr) 6.5rem; gap: 8px; align-items: center; padding: 3px 0; }
.label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.track { display: block; height: 12px; }
.bar { display: block; height: 12px; border-radius: 3px; background: var(--bar); min-width: 2px; }
#cost .bar { background: var(--bar2); }
.val { text-align: right; font-variant-numeric: tabular-nums; }
.mark { color: var(--mark); font-weight: 700; }
.missing { color: var(--muted); margin: 6px 0 0; }
.totals { display: flex; flex-wrap: wrap; gap: 24px; }
.totals strong { font-size: 1.3rem; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { padding: 6px 8px; border-bottom: 1px solid #2a2f3a; text-align: right; }
th:first-child, td:first-child { text-align: left; }
td.nodata { color: var(--muted); font-style: italic; }
@media (max-width: 600px) {
  .bars li { grid-template-columns: minmax(0, 1fr) 6rem; }
  .bars .track { grid-column: 1 / -1; grid-row: 2; }
  th, td { padding: 4px 4px; font-size: 13px; }
}
</style>
</head>
<body>
<main>
<h1>${esc(data.title)}</h1>
<p class="sub">${esc(data.period.from)} to ${esc(data.period.to)} (${data.period.days} days). 16 task types.</p>
<p class="legend"><span class="mark">*</span> = inferred (an estimate, not a measurement). "no data" = the value is missing.</p>
<section class="totals">
  <div>Total volume: <strong data-total="volume">${fmtInt(totalVolume)}</strong> runs</div>
  <div>Total cost: <strong data-total="cost_usd">${fmtUsd(totalCost)}</strong></div>
</section>
<section id="volume">
<h2>Ranking by volume (runs)</h2>
${bars('volume')}
</section>
<section id="cost">
<h2>Ranking by cost (US$)</h2>
${bars('cost_usd')}
</section>
<section>
<h2>Checkability</h2>
<div class="table-wrap">
<table id="checkability">
<thead><tr><th>Task type</th><th>Volume</th><th>Cost</th><th>Checkability (1–5)</th></tr></thead>
<tbody>
${types.map((t) => `<tr data-task="${t.id}"><td>${esc(t.name)}</td>${cell(t, 'volume')}${cell(t, 'cost_usd')}${cell(t, 'checkability')}</tr>`).join('\n')}
</tbody>
</table>
</div>
</section>
</main>
</body>
</html>
`;

const sha = createHash('sha256').update(report, 'utf-8').digest('hex');
const result = `${JSON.stringify({ url: UPLOAD_URL, sha256: sha }, null, 2)}\n`;

// The patch: git diff of a tree with the two new files, so `git apply --index` takes it as is.
const tmp = mkdtempSync(join(tmpdir(), 'dfl-html-report-'));
try {
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: tmp, encoding: 'utf-8' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  mkdirSync(join(tmp, 'out'));
  writeFileSync(join(tmp, 'out/report.html'), report);
  writeFileSync(join(tmp, 'out/result.json'), result);
  git('add', '-A');
  writeFileSync(join(root, 'solution/solution.patch'), git('diff', '--cached', '--no-renames'));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
writeFileSync(
  join(root, 'solution/mcp-calls.jsonl'),
  `${JSON.stringify({ server: 'media', tool: 'upload_file', arguments: { filename: 'report.html', content_type: 'text/html', visibility: 'private', content: report } })}\n`,
);
console.log(`report ${Buffer.byteLength(report)} bytes, sha256 ${sha}`);

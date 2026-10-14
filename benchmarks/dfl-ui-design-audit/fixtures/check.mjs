#!/usr/bin/env node
// CI check of the ui-design-audit task folder (plan ADR-2 and Verification #6). No dependency.
//
//   1. Reproducible: the generator with the committed seed writes the committed files, byte for byte.
//      The PNGs and bboxes.json come from fixtures/render.mjs (needs the browser@1 image): they
//      must exist, one PNG per screen and width, and bboxes.json must name every key element.
//   2. Grader: the reference solution passes every check; the empty skeleton (no-op) fails;
//      reporting a decoy fails; a solution with 3 defects dropped fails (recall gate); wrong
//      values fail the values check; padding with 5 invented findings fails (precision gate).
//   3. Denylist: no real organisation, repo, host, person or private marker, no secret-shaped string.
//
//   node benchmarks/dfl-ui-design-audit/fixtures/check.mjs
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { grade } from '../tests/hidden/grade.mjs';
import { SKELETON } from './gen.mjs';

const root = join(import.meta.dirname, '..');
const problems = [];
const task = JSON.parse(readFileSync(join(root, 'task.json'), 'utf-8'));
const seed = task.metadata?.variant?.seed;

// 1. Reproducible.
const tmp = mkdtempSync(join(tmpdir(), 'ui-audit-gen-'));
try {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, 'gen.mjs'), '--seed', String(seed), '--out', tmp], { encoding: 'utf-8' });
  if (r.status !== 0) problems.push(`gen.mjs failed: ${r.stderr}`);
  for (const rel of ['mcp/browser/seed.json', 'tests/hidden/key.json', 'tests/hidden/mcp/browser/assert.json', 'solution/findings.json', 'solution/mcp-calls.jsonl', 'solution/solution.patch']) {
    const a = readFileSync(join(root, rel), 'utf-8');
    const b = readFileSync(join(tmp, rel), 'utf-8');
    if (a !== b) problems.push(`${rel} differs from gen.mjs --seed ${seed}: run the generator and commit`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (readFileSync(join(root, 'environment/out/findings.json'), 'utf-8') !== SKELETON) problems.push('environment/out/findings.json is not the skeleton');
const key = JSON.parse(readFileSync(join(root, 'tests/hidden/key.json'), 'utf-8'));
for (const s of Object.keys(key.screens)) for (const w of key.viewports) {
  const p = join(root, 'environment/designs', `${s}-${w}.png`);
  if (!existsSync(p) || readFileSync(p).subarray(1, 4).toString() !== 'PNG') problems.push(`environment/designs/${s}-${w}.png is missing: run fixtures/render.mjs`);
}
const bboxes = JSON.parse(readFileSync(join(root, 'tests/hidden/bboxes.json'), 'utf-8'));
for (const d of key.defects) {
  const has = ['1280', '390'].some((v) => d.match_testids.some((id) => bboxes.design?.[v]?.[d.screen]?.[id] || bboxes.app?.[v]?.[d.screen]?.[id]));
  if (!has) problems.push(`bboxes.json has no box for ${d.id}: run fixtures/render.mjs after gen.mjs`);
}

// 2. Grader.
const solution = readFileSync(join(root, 'solution/findings.json'), 'utf-8');
const failed = (text) => grade({ findingsText: text, key, bboxes }).checks.filter((c) => !c.ok).map((c) => c.id);
const sol = failed(solution);
if (sol.length) problems.push(`the reference solution fails: ${sol.join(', ')}`);
const noop = failed(SKELETON);
if (!noop.includes('recall') || !noop.includes('precision')) problems.push('the no-op skeleton passes recall or precision');
const base = JSON.parse(solution);
const withDecoy = { findings: [...base.findings, { screen: 'list', viewport: 'both', selector: '[data-testid="last-updated"]', category: 'copy', expected: '09:41', actual: '10:02' }] };
if (!failed(JSON.stringify(withDecoy)).includes('no-decoy-clock')) problems.push('a report on the live clock is not caught');
const withSub = { findings: [...base.findings, { screen: 'list', viewport: 'both', selector: '[data-testid="summary-card"]', category: 'spacing', expected: '24px', actual: '24.4px' }] };
if (!failed(JSON.stringify(withSub)).includes('no-decoy-subpixel')) problems.push('a report on the sub-pixel shift is not caught');
if (!failed(JSON.stringify({ findings: base.findings.slice(3) })).includes('recall')) problems.push('dropping 3 of 8 defects does not fail recall');
const wrong = { findings: base.findings.map((f) => ({ ...f, expected: 'n/a', actual: 'n/a' })) };
if (!failed(JSON.stringify(wrong)).includes('values')) problems.push('wrong values do not fail the values check');
const padded = { findings: [...base.findings, ...['brand-name', 'nav-orders', 'orders-table', 'detail-status', 'priority-select'].map((id, i) => ({ screen: ['list', 'list', 'list', 'detail', 'form'][i], viewport: 'both', selector: `[data-testid="${id}"]`, category: 'color', expected: '#000000', actual: '#111111' }))] };
if (!failed(JSON.stringify(padded)).includes('precision')) problems.push('5 invented findings of 13 do not fail precision');

// 3. Denylist (this file is the only place that names the terms).
const DENY = [
  /devfellowship/i, /\bdfl[-_]/i, /iterahq/i, /\bitera\b/i, /tainan/i, /taigfs/i, /paperclip/i, /openclaw/i,
  /supabase\.co/i, /infisical/i, /yoojxnggaxcqtsyjdrdx/, /kjefmwlopzeaqgqtlbdn/, /plans\.devfellow/i, /share\.devfellow/i, /media\.devfellow/i,
  /claude-main/i, /hetzner/i, /dokploy/i, /bmcanvas/i, /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
];
const SECRET = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /sk-(?:or|ant|proj)-[A-Za-z0-9_-]{16,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[baprs]-[A-Za-z0-9-]{10,}/, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./];
const SCAN = ['instruction.md', 'environment', 'mcp', 'solution', 'tests'];
const files = [];
const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).forEach((n) => n !== 'node_modules' && walk(join(p, n))) : files.push(p));
for (const s of SCAN) walk(join(root, s));
for (const f of files) {
  const rel = relative(root, f);
  if (rel === 'environment/package-lock.json' || rel.endsWith('.png')) continue;
  const text = readFileSync(f, 'utf-8');
  for (const re of DENY) if (re.test(text)) problems.push(`${rel}: denylisted term ${re}`);
  for (const re of SECRET) if (re.test(text)) problems.push(`${rel}: secret-shaped string ${re}`);
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`dfl-ui-design-audit: reproducible (seed ${seed}), solution passes ${grade({ findingsText: solution, key, bboxes }).checks.length} checks, no-op / decoys / dropped / wrong values / padding fail, ${files.length} files pass the denylist`);

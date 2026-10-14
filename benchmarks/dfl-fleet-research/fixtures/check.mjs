#!/usr/bin/env node
// CI check of the fleet-research task folder (plan ADR-2 and Verification #6). No dependency.
//
//   1. Reproducible: the generator with the committed seed writes the committed files, byte for byte.
//   2. Grader: the reference solution passes every check; the empty skeleton (no-op) and a
//      fabricated answer to the unanswerable question fail.
//   3. Denylist: no real organisation, repo, host, person or private marker in the task content,
//      and no secret-shaped string.
//
//   node benchmarks/dfl-fleet-research/fixtures/check.mjs
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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
const tmp = mkdtempSync(join(tmpdir(), 'fleet-gen-'));
try {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, 'gen.mjs'), '--seed', String(seed), '--out', tmp], { encoding: 'utf-8' });
  if (r.status !== 0) problems.push(`gen.mjs failed: ${r.stderr}`);
  for (const rel of ['mcp/repos/seed.json', 'tests/hidden/key.json', 'tests/hidden/mcp/repos/assert.json', 'solution/answers.json', 'solution/report.md', 'solution/mcp-calls.jsonl', 'solution/solution.patch']) {
    const a = readFileSync(join(root, rel), 'utf-8');
    const b = readFileSync(join(tmp, rel), 'utf-8');
    if (a !== b) problems.push(`${rel} differs from gen.mjs --seed ${seed}: run the generator and commit`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (readFileSync(join(root, 'environment/out/answers.json'), 'utf-8') !== SKELETON) problems.push('environment/out/answers.json is not the skeleton');

// 2. Grader.
const key = JSON.parse(readFileSync(join(root, 'tests/hidden/key.json'), 'utf-8'));
const solution = readFileSync(join(root, 'solution/answers.json'), 'utf-8');
const report = readFileSync(join(root, 'solution/report.md'), 'utf-8');
const failed = (checks) => checks.filter((c) => !c.ok).map((c) => c.id);
const sol = failed(grade({ answersText: solution, reportText: report, key }));
if (sol.length) problems.push(`the reference solution fails: ${sol.join(', ')}`);
const noop = grade({ answersText: SKELETON, reportText: null, key });
if (failed(noop).length < noop.length - 1) problems.push('the no-op skeleton passes more than the schema check');
const fab = JSON.parse(solution);
fab.answers.q6 = { answer: 'acme/acme-infra/deploy/compose.staging.yaml', evidence: fab.answers.q2.evidence };
fab.not_verified = [];
if (!failed(grade({ answersText: JSON.stringify(fab), reportText: report, key })).includes('q6-abstains')) problems.push('a fabricated q6 answer is not caught');
const off = JSON.parse(solution);
off.answers.q1.evidence = [{ ref: 'acmehq/acme-player:README.md:9', quote: 'the learner-facing app' }];
if (!failed(grade({ answersText: JSON.stringify(off), reportText: report, key })).includes('q1-evidence')) problems.push('a citation on the wrong line is not caught');

// 3. Denylist (this file is the only place that names the terms).
const DENY = [
  /devfellowship/i, /\bdfl[-_]/i, /iterahq/i, /\bitera\b/i, /tainan/i, /taigfs/i, /paperclip/i, /openclaw/i,
  /supabase\.co/i, /infisical/i, /yoojxnggaxcqtsyjdrdx/, /kjefmwlopzeaqgqtlbdn/, /plans\.devfellow/i, /share\.devfellow/i, /media\.devfellow/i,
  /claude-main/i, /hetzner/i, /dokploy/i, /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
];
const SECRET = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /sk-(?:or|ant|proj)-[A-Za-z0-9_-]{16,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[baprs]-[A-Za-z0-9-]{10,}/, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./];
// task.json carries the platform task name; fixtures/ holds this list and the generator comments.
const SCAN = ['instruction.md', 'environment', 'mcp', 'solution', 'tests'];
const files = [];
const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).forEach((n) => n !== 'node_modules' && walk(join(p, n))) : files.push(p));
for (const s of SCAN) walk(join(root, s));
for (const f of files) {
  const rel = relative(root, f);
  if (rel === 'environment/package-lock.json') continue; // npm registry URLs and integrity hashes only
  const text = readFileSync(f, 'utf-8');
  for (const re of DENY) if (re.test(text)) problems.push(`${rel}: denylisted term ${re}`);
  for (const re of SECRET) if (re.test(text)) problems.push(`${rel}: secret-shaped string ${re}`);
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`dfl-fleet-research: reproducible (seed ${seed}), solution ${grade({ answersText: solution, reportText: report, key }).length}/${noop.length} checks, no-op and fabrication fail, ${files.length} files pass the denylist`);

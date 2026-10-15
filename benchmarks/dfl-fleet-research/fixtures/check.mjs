#!/usr/bin/env node
// CI check of the fleet-research task folder (plan ADR-2 and Verification #6). No dependency.
//
//   1. Reproducible: the generator with the committed seed writes the committed files, byte for byte.
//   2. Grader: the reference solution passes every check; the empty skeleton (no-op) and a
//      fabricated answer to the unanswerable question fail. Strict evidence: a citation within
//      +-1 line passes, 2 lines off fails (task version 2, TMA-QA = C). The task uses repos@2 and
//      the reference solution reads every cited file with read_file_lines. Version 3 (TMA-QA2 = A):
//      read_file_lines is the ONLY tool that returns file content, in allowed_tools and in the reference calls.
//      Version 4 (Tainan, TG 21576): the quote rules are stated in the instruction and the grader enforces them: at
//      least 6 characters after trim, unique in the cited file, within +-1 line. The instruction names
//      answers.schema.json and holds a minimal valid example, and this check validates that example.
//   3. Denylist: no real organisation, repo, host, person or private marker in the task content,
//      and no secret-shaped string.
//
//   node benchmarks/dfl-fleet-research/fixtures/check.mjs
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { grade, schemaErrors, MIN_QUOTE } from '../tests/hidden/grade.mjs';
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

// 2b. Strict evidence (TMA-QA = C, task versions 2 and 3). repos@2 `read_file_lines` prints the exact line, so the
// grader keeps its +-1 slack and nothing more: the reference cites the exact line, a citation 1 line off still
// passes, a citation 2 lines off fails (campaign k7: the agent cited line 11 for text on line 13).
const shift = (by) => {
  const o = JSON.parse(solution);
  const e = o.answers.q1.evidence[0];
  const at = e.ref.lastIndexOf(':');
  e.ref = `${e.ref.slice(0, at)}:${Number(e.ref.slice(at + 1)) + by}`;
  return failed(grade({ answersText: JSON.stringify(o), reportText: report, key })).includes('q1-evidence');
};
const exactLine = (ref, quote) => {
  const at = ref.lastIndexOf(':');
  const lines = key.snapshot[ref.slice(0, at)].split('\n');
  return lines[Number(ref.slice(at + 1)) - 1]?.includes(quote);
};
for (const [q, a] of Object.entries(JSON.parse(solution).answers)) {
  for (const e of a.evidence) if (!exactLine(e.ref, e.quote)) problems.push(`the reference solution cites ${e.ref} but the quote is not on that exact line (${q})`);
}
if (shift(0) || shift(1) || shift(-1)) problems.push('a citation within +-1 line fails (the documented slack is gone)');
if (!shift(2) || !shift(-2)) problems.push('a citation 2 lines off passes (the grader is not strict)');

// 2b2. Quote rules (task version 4). The instruction states them and the grader enforces them.
const evidenceFailed = (mutate) => {
  const o = JSON.parse(solution);
  const k = structuredClone(key);
  mutate(o, k);
  return failed(grade({ answersText: JSON.stringify(o), reportText: report, key: k })).includes('q2-evidence');
};
// A quote of 5 characters (and one padded with spaces to 9) is too short, wherever it sits.
if (!evidenceFailed((o) => (o.answers.q2.evidence[1].quote = 'push:'))) problems.push('a 5-character quote passes');
if (!evidenceFailed((o) => (o.answers.q2.evidence[1].quote = '  push:  '))) problems.push('a 5-character quote padded with spaces passes');
// A quote that another line of the same file holds is refused: append a copy of the cited line to the file.
if (!evidenceFailed((o, k) => {
  const e = o.answers.q2.evidence[0];
  const at = e.ref.lastIndexOf(':');
  k.snapshot[e.ref.slice(0, at)] += `\n${e.quote}\n`;
})) problems.push('a quote that is not unique in its file passes');
// The same quote in a file where it is unique still passes (the control for the two mutations above).
if (evidenceFailed(() => {})) problems.push('the unmutated reference fails q2-evidence');
for (const [q, a] of Object.entries(JSON.parse(solution).answers)) {
  for (const e of a.evidence) {
    if (e.quote.trim().length < MIN_QUOTE) problems.push(`the reference quote in ${e.ref} (${q}) is shorter than ${MIN_QUOTE} characters`);
  }
}
// The instruction, the environment README and the schema state the rules; their examples are valid.
const instruction = readFileSync(join(root, 'instruction.md'), 'utf-8');
if (!instruction.includes('answers.schema.json')) problems.push('instruction.md does not name answers.schema.json');
if (!instruction.includes(`at least ${MIN_QUOTE} characters`)) problems.push(`instruction.md does not state the minimum quote length (${MIN_QUOTE})`);
if (!/appears on one line only/.test(instruction)) problems.push('instruction.md does not state that the quote is unique in the file');
if (!/read_file_lines/.test(instruction)) problems.push('instruction.md does not name read_file_lines');
const schema = JSON.parse(readFileSync(join(root, 'environment/answers.schema.json'), 'utf-8'));
if (schema.properties.answers.patternProperties['^q[1-6]$'].properties.evidence.items.properties.quote.minLength !== MIN_QUOTE) problems.push(`answers.schema.json quote.minLength is not ${MIN_QUOTE}`);
for (const [label, text] of [['instruction.md', instruction], ['environment/README.md', readFileSync(join(root, 'environment/README.md'), 'utf-8')]]) {
  const m = /```json\n([\s\S]*?)\n\s*```/.exec(text); // the example in a list item is indented
  if (!m) { problems.push(`${label} has no json example`); continue; }
  let ex;
  try { ex = JSON.parse(m[1]); } catch (err) { problems.push(`${label}: the example is not JSON (${err.message})`); continue; }
  const errs = schemaErrors(ex);
  if (errs.length) problems.push(`${label}: the example is not valid: ${errs.join('; ')}`);
  for (const a of Object.values(ex.answers ?? {})) for (const e of a.evidence ?? []) if (e.quote.trim().length < MIN_QUOTE) problems.push(`${label}: the example quote "${e.quote}" is shorter than ${MIN_QUOTE}`);
  if (Object.values(ex.answers ?? {}).some((a) => JSON.stringify(a.answer) === JSON.stringify(JSON.parse(solution).answers.q1.answer))) problems.push(`${label}: the example holds the real answer of q1`);
}

// 2c. The task uses repos@2 and the reference solution reads every cited file with line numbers.
if (task.task.version !== '4') problems.push(`task.version is ${task.task.version}, expected 4 (the quote rules are stated in the instruction: a new task version)`);
const mcp = task.environment.tools.mcp.find((m) => m.name === 'repos');
if (mcp?.catalog !== 'repos@2') problems.push(`catalog is ${mcp?.catalog}, expected repos@2`);
if (!mcp?.allowed_tools?.includes('read_file_lines')) problems.push('read_file_lines is not in allowed_tools');
// Task version 3: no other tool may return file content. git_show prints the content of a file in a diff.
const CONTENT_TOOLS = ['read_text_file', 'read_multiple_files', 'read_media_file', 'read_file', 'git_show', 'git_diff', 'git_diff_staged', 'git_diff_unstaged'];
for (const t of CONTENT_TOOLS) if (mcp?.allowed_tools?.includes(t)) problems.push(`${t} is in allowed_tools: read_file_lines must be the only tool that returns file content`);
const NAVIGATION = ['list_directory', 'directory_tree', 'search_files', 'git_log'];
for (const t of mcp?.allowed_tools ?? []) if (t !== 'read_file_lines' && !NAVIGATION.includes(t)) problems.push(`${t} is in allowed_tools but is neither read_file_lines nor a navigation tool`);
const calls = readFileSync(join(root, 'solution/mcp-calls.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
for (const c of calls) if (!mcp.allowed_tools.includes(c.tool)) problems.push(`solution/mcp-calls.jsonl calls ${c.tool}, which is not in allowed_tools`);
const unnumbered = calls.filter((c) => !NAVIGATION.includes(c.tool) && c.tool !== 'read_file_lines');
if (unnumbered.length) problems.push(`solution/mcp-calls.jsonl reads content with ${[...new Set(unnumbered.map((c) => c.tool))].join(', ')}`);
const numbered = new Set(calls.filter((c) => c.tool === 'read_file_lines').map((c) => c.arguments.path));
for (const a of Object.values(JSON.parse(solution).answers)) {
  for (const e of a.evidence) {
    const at = e.ref.lastIndexOf(':');
    const path = `/repos/${e.ref.slice(0, at).replace(':', '/')}`;
    if (!numbered.has(path)) problems.push(`the reference solution cites ${e.ref} without reading ${path} through read_file_lines`);
  }
}

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

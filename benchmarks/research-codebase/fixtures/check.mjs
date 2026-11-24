#!/usr/bin/env node
// CI check of the research-codebase task folder. No dependency.
//
//   1. Reproducible: build.mjs writes the committed fixture repo, questions, truth and reference solution, byte for byte.
//   2. Questions: no question names its function, every answer span is inside its file, and no hidden file leaks into the workspace.
//   3. Grader: the reference solution passes every check; an empty file, a wrong file, the deprecated decoy,
//      a line outside the function, a malformed answer, a duplicate, a missing answer and an unknown id
//      each fail the check that names them.
//   4. Denylist: no real organisation, host, person or private marker, no secret-shaped string.
//
//   node benchmarks/research-codebase/fixtures/check.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { grade } from '../tests/hidden/grade.mjs';
import { ANSWERS_JSON, FILES, QUESTIONS_JSON, QUESTION_SYMBOLS, README, SOLUTION_PATCH, TRUTH_JSON } from './build.mjs';

const root = join(import.meta.dirname, '..');
const problems = [];
const read = (rel) => readFileSync(join(root, rel), 'utf-8');

const expectedFiles = [
  ...Object.entries(FILES).map(([rel, content]) => [`environment/repo/${rel}`, content]),
  ['environment/repo/README.md', README],
  ['environment/data/questions.json', QUESTIONS_JSON],
  ['tests/hidden/truth.json', TRUTH_JSON],
  ['solution/answers.json', ANSWERS_JSON],
  ['solution/solution.patch', SOLUTION_PATCH()],
];
for (const [rel, expected] of expectedFiles) {
  if (!existsSync(join(root, rel)) || read(rel) !== expected) problems.push(`${rel} differs from build.mjs: run the builder and commit`);
}

const truth = JSON.parse(TRUTH_JSON);
const questions = JSON.parse(QUESTIONS_JSON).questions;
for (const { id, fn, file } of QUESTION_SYMBOLS) {
  const q = questions.find((x) => x.id === id);
  if (!q || q.question.includes(fn)) problems.push(`${id}: the question names the function ${fn}`);
  const t = truth.answers.find((x) => x.id === id);
  const lines = FILES[file].split('\n');
  if (!t || t.start < 1 || t.end <= t.start - 1 || t.end > lines.length) problems.push(`${id}: the span is outside ${file}`);
}
const decoys = QUESTION_SYMBOLS.filter(({ fn }) => Object.values(FILES).filter((t) => new RegExp(`function ${fn}\\b`).test(t)).length > 1);
if (decoys.length === 0) problems.push('the fixture has no function name that exists twice');

const failed = (doc) => grade({ answersText: typeof doc === 'string' ? doc : JSON.stringify(doc), truth }).checks.filter((c) => !c.ok).map((c) => c.id);
const solution = JSON.parse(ANSWERS_JSON);
const withFirst = (patch) => ({ answers: solution.answers.map((a, i) => (i === 0 ? { ...a, ...patch } : a)) });
const first = truth.answers[0];
const decoyQ = truth.answers.find((t) => t.id === 'q3');
const sol = failed(solution);
if (sol.length) problems.push(`the reference solution fails: ${sol.join(', ')}`);
if (grade({ answersText: ANSWERS_JSON, truth }).score !== 1) problems.push('the reference solution does not score 1');
const expectFail = (name, doc, id) => {
  if (!failed(doc).includes(id)) problems.push(`${name} does not fail ${id}`);
};
expectFail('an empty list', { answers: [] }, 'q1');
expectFail('unparseable output', 'not json', 'shape');
expectFail('an answer without a line', withFirst({ answer: first.file }), 'shape');
expectFail('the wrong file', withFirst({ answer: `src/util/retry.ts:${first.start}` }), first.id);
expectFail('a line before the function', withFirst({ answer: `${first.file}:${first.start - 1}` }), first.id);
expectFail('a line after the function', withFirst({ answer: `${first.file}:${first.end + 1}` }), first.id);
expectFail('a line of 1', withFirst({ answer: `${first.file}:1` }), first.id);
expectFail('the deprecated decoy', { answers: solution.answers.map((a) => (a.id === 'q3' ? { ...a, answer: 'src/orders/legacy/pricing.ts:2' } : a)) }, 'q3');
expectFail('a duplicate', { answers: [...solution.answers, solution.answers[0]] }, 'no-duplicates');
expectFail('a missing answer', { answers: solution.answers.slice(1) }, first.id);
expectFail('an unknown id', { answers: [...solution.answers, { id: 'q99', answer: 'src/a.ts:1' }] }, 'known-ids');
for (const edge of [decoyQ.start, decoyQ.end]) {
  if (failed({ answers: solution.answers.map((a) => (a.id === 'q3' ? { ...a, answer: `${decoyQ.file}:${edge}` } : a)) }).length) problems.push('the first and last line of a function are not accepted');
}
if (failed({ answers: solution.answers.map((a) => ({ ...a, answer: ` ./repo/${a.answer} ` })) }).length) problems.push('a ./repo/ prefix and surrounding spaces are not tolerated');

const DENY = [
  /devfellowship/i, /\bdfl[-_]/i, /iterahq/i, /\bitera\b/i, /tainan/i, /taigfs/i, /paperclip/i, /openclaw/i,
  /supabase\.co/i, /infisical/i, /plans\.devfellow/i, /share\.devfellow/i, /media\.devfellow/i,
  /claude-main/i, /hetzner/i, /dokploy/i, /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
];
const SECRET = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /sk-(?:or|ant|proj)-[A-Za-z0-9_-]{16,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[baprs]-[A-Za-z0-9-]{10,}/, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./];
const files = [];
const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).forEach((n) => n !== 'node_modules' && walk(join(p, n))) : files.push(p));
for (const s of ['instruction.md', 'environment', 'solution', 'tests']) walk(join(root, s));
for (const f of files) {
  const rel = relative(root, f);
  if (rel === 'environment/package-lock.json') continue;
  const text = readFileSync(f, 'utf-8');
  for (const re of DENY) if (re.test(text)) problems.push(`${rel}: denylisted term ${re}`);
  for (const re of SECRET) if (re.test(text)) problems.push(`${rel}: secret-shaped string ${re}`);
}
for (const f of files) {
  const rel = relative(root, f);
  if (rel.startsWith('environment/') && /truth|"start"/.test(readFileSync(f, 'utf-8')) && rel !== 'environment/package-lock.json') problems.push(`${rel}: answer data in the agent workspace`);
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`research-codebase: reproducible, reference solution passes ${grade({ answersText: ANSWERS_JSON, truth }).checks.length} checks, 11 bad variants fail, ${files.length} files pass the denylist`);

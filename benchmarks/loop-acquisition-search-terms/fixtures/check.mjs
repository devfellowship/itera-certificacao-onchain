#!/usr/bin/env node
// CI check of the loop-acquisition-search-terms task folder. No dependency.
//
//   1. Reproducible: build.mjs writes the committed report, reference proposals and patch, byte for byte.
//   2. Grader: the reference solution passes every check; an empty file, a converting term, a
//      fractional-conversion term, a zero-spend term, an invented term, a missing candidate,
//      a duplicate and a reason without evidence each fail the check that names them.
//   3. Denylist: no real organisation, host, person or private marker, no secret-shaped string.
//
//   node benchmarks/loop-acquisition-search-terms/fixtures/check.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { grade, candidates } from '../tests/hidden/grade.mjs';
import { PROPOSALS_JSON, REPORT_JSON, SOLUTION_PATCH } from './build.mjs';

const root = join(import.meta.dirname, '..');
const problems = [];
const read = (rel) => readFileSync(join(root, rel), 'utf-8');

for (const [rel, expected] of [
  ['environment/data/search-terms.json', REPORT_JSON],
  ['solution/proposals.json', PROPOSALS_JSON],
  ['solution/solution.patch', SOLUTION_PATCH()],
]) {
  if (read(rel) !== expected) problems.push(`${rel} differs from build.mjs: run the builder and commit`);
}

const report = JSON.parse(read('environment/data/search-terms.json'));
const solution = JSON.parse(PROPOSALS_JSON);
const failed = (doc) => grade({ proposalsText: typeof doc === 'string' ? doc : JSON.stringify(doc), report }).checks.filter((c) => !c.ok).map((c) => c.id);
const entry = (term, reason = 'It had 20 clicks and 10.00 spent.') => ({ term, action: 'add_negative_keyword', reason });
const find = (pred) => report.terms.find(pred);
const converting = find((t) => t.conversions >= 1);
const fractional = find((t) => t.conversions > 0 && t.conversions < 1);
const zeroSpend = find((t) => t.conversions === 0 && t.cost_micros === 0);
const first = solution.proposals[0];

const sol = failed(solution);
if (sol.length) problems.push(`the reference solution fails: ${sol.join(', ')}`);
if (candidates(report).length !== solution.proposals.length) problems.push('the reference solution is not the candidate set');
const expectFail = (name, doc, id) => {
  if (!failed(doc).includes(id)) problems.push(`${name} does not fail ${id}`);
};
expectFail('an empty proposal list', { proposals: [] }, 'recall');
expectFail('unparseable output', 'not json', 'shape');
expectFail('a converting term', { proposals: [...solution.proposals, entry(converting.term, `${converting.clicks} clicks, no sales.`)] }, 'no-converting-term');
expectFail('a fractional-conversion term', { proposals: [...solution.proposals, entry(fractional.term, `${fractional.clicks} clicks, little value.`)] }, 'no-converting-term');
expectFail('a zero-spend term', { proposals: [...solution.proposals, entry(zeroSpend.term, `${zeroSpend.impressions} impressions and no clicks.`)] }, 'no-zero-spend-term');
expectFail('an invented term', { proposals: [...solution.proposals, entry('term that is not in the report')] }, 'terms-exist');
expectFail('a missing candidate', { proposals: solution.proposals.slice(1) }, 'recall');
expectFail('a duplicate', { proposals: [...solution.proposals, first] }, 'no-duplicates');
expectFail('a reason without evidence', { proposals: solution.proposals.map((p, i) => (i === 0 ? { ...p, reason: 'Looks irrelevant to the shop.' } : p)) }, 'reason-cites-evidence');
expectFail('a wrong action', { proposals: solution.proposals.map((p, i) => (i === 0 ? { ...p, action: 'pause_campaign' } : p)) }, 'shape');
if (failed({ proposals: solution.proposals.map((p) => ({ ...p, term: ` ${p.term.toUpperCase()} ` })) }).length) problems.push('case and spaces around a term are not tolerated');

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

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`loop-acquisition-search-terms: reproducible, reference solution passes ${grade({ proposalsText: PROPOSALS_JSON, report }).checks.length} checks, 9 bad variants fail, ${files.length} files pass the denylist`);

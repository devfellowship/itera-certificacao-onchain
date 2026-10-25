#!/usr/bin/env node
// CI check of the session-decision-trajectory-extraction task folder. No dependency. Synthetic content only.
//
//   1. Grader self-test: fixtures/grade.selftest.mjs passes, and every grader mutant (--mutants) is killed.
//   2. Rubric: the pinned contract files match rubric/VENDORED.json (sha256); the grader's schema copy is the
//      rubric schema; the intent list of the schema is the list of rubric/intents.md; the risk stand-in keeps the
//      10 anchors.
//   3. Open variant: the reference passes all 9 hidden checks with score 100; the no-op (no output) and the
//      schema-valid empty skeleton score 0; solution/solution.patch creates exactly solution/judgment.json, which
//      is the reference.
//   4. Gates and metrics: a gate failure fails every metric check; the risk floor, the speaker rule and the outcome
//      rule each turn their gate red; on the SUBAGENT fixture the reference passes and one invented correction fails.
//   5. Denylist: the folder holds no real repo name, internal host, corpus marker, chat id or secret; a file with the
//      internal host turns the scan red, and so does a pinned rubric file that loses its pin (mutation tests).
//
//   node benchmarks/dfl-session-decision-trajectory-extraction/fixtures/check.mjs
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gradeItem, CHECK_IDS } from '../tests/hidden/grade.mjs';
import { GRADER_VERSION, INTENTS } from '../tests/hidden/lib/grade.mjs';
import { scanDir, scanText } from './denylist.mjs';

const root = join(import.meta.dirname, '..');
const here = import.meta.dirname;
const read = (rel) => readFileSync(join(root, rel), 'utf-8');
const sha = (rel) => createHash('sha256').update(readFileSync(join(root, rel))).digest('hex');
const problems = [];
const node = (args) => spawnSync(process.execPath, args, { encoding: 'utf-8' });

// 1. Self-test of the grader, and its mutants.
const st = node([join(here, 'grade.selftest.mjs')]);
const stLine = st.stdout.trim().split('\n').pop();
if (st.status !== 0) problems.push(`grade.selftest.mjs fails: ${stLine}`);
const mu = node([join(here, 'grade.selftest.mjs'), '--mutants']);
const mutants = mu.stdout.trim().split('\n').filter((l) => /mutant/.test(l));
const killed = mutants.filter((l) => l.startsWith('killed')).length;
if (mu.status !== 0 || killed === 0 || killed !== mutants.length) problems.push(`grader mutants: ${killed}/${mutants.length} killed`);

// 2. Rubric pins.
const vend = JSON.parse(read('environment/rubric/VENDORED.json'));
for (const [f, h] of Object.entries(vend.identical)) if (sha(`environment/rubric/${f}`) !== h) problems.push(`environment/rubric/${f} differs from its pinned sha256 (rubric/VENDORED.json)`);
if (read('tests/hidden/lib/schema.json') !== read('environment/rubric/schema.json')) problems.push('tests/hidden/lib/schema.json differs from environment/rubric/schema.json');
const mdIntents = [...read('environment/rubric/intents.md').matchAll(/^\| ([a-z/-]+) \|/gm)].map((m) => m[1]).filter((x) => x !== 'intent');
if (mdIntents.join() !== INTENTS.join()) problems.push('rubric/intents.md and the schema intent list differ');
const anchors = [...read('environment/rubric/risk-anchors.md').matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1]));
if (anchors.join() !== '1,2,3,4,5,6,7,8,9,10') problems.push('rubric/risk-anchors.md does not hold the 10 anchors');

// 3. The open variant.
const load = (dir, refPath) => ({
  itemText: read(`${dir}/item.txt`), layer1: JSON.parse(read(`${dir}/layer1.json`)), shapes: JSON.parse(read(`${dir}/shapes.json`)), reference: JSON.parse(read(refPath)),
});
const SUB = 'fixtures/synthetic/synth-acme-0001__agent-b7c1';
const items = { main: load('environment', 'tests/hidden/reference.json'), sub: load(SUB, `${SUB}/reference.json`) };
const solution = read('solution/judgment.json');
const sol = gradeItem({ ...items.main, judgmentText: solution });
if (sol.checks.map((c) => c.id).join() !== CHECK_IDS.join()) problems.push('the checks are not CHECK_IDS, in order');
if (!sol.pass || sol.score !== 100) problems.push(`the reference fails: score ${sol.score}; ${sol.checks.filter((c) => !c.ok).map((c) => `${c.id} (${c.why})`).join(', ')}`);
if (JSON.stringify(JSON.parse(solution)) !== JSON.stringify(items.main.reference)) problems.push('solution/judgment.json differs from tests/hidden/reference.json');
const noop = gradeItem({ ...items.main, judgmentText: null });
if (noop.passed !== 0 || noop.score !== 0) problems.push(`the no-op passes ${noop.passed} check(s), score ${noop.score}`);
const skeleton = { ...JSON.parse(solution), decision_candidates: [], tainan_corrections: [], intent_labels: {} };
const skel = gradeItem({ ...items.main, judgmentText: JSON.stringify(skeleton) });
if (skel.score !== 0 || skel.gates.intents_closed) problems.push(`the empty skeleton scores ${skel.score} (intents_closed ${skel.gates.intents_closed})`);
if (!items.main.shapes.shapes.length) problems.push('the open variant has no shape to label (the skeleton would pass intents_closed)');
const patch = read('solution/solution.patch');
const body = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
if (!/^diff --git a\/out\/judgment\.json b\/out\/judgment\.json\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/out\/judgment\.json\n/.test(patch)) problems.push('solution.patch does not create out/judgment.json');
if (`${body}\n` !== solution) problems.push('solution.patch differs from solution/judgment.json: rebuild it (fixtures/make-synthetic.mjs)');
for (const k of ['class_match', 'risk_match', 'intent_agreement', 'corrections']) if (typeof sol.metrics?.[k] !== 'number') problems.push(`the grader JSON has no number for ${k}`);
if (typeof sol.diagnostics?.decisions_recall !== 'number') problems.push('the grader JSON has no decisions diagnostic');

// 4. Gates and metrics.
const failed = (out) => out.checks.filter((c) => !c.ok).map((c) => c.id);
const mutate = (fn, it = items.main, base = solution) => { const o = JSON.parse(base); fn(o); return gradeItem({ ...it, judgmentText: JSON.stringify(o) }); };
const badSchema = mutate((o) => { o.classification.outcome = 'shipped'; });
if (badSchema.passed !== 0) problems.push(`a schema failure leaves ${badSchema.passed} check(s) passing`);
const lowRisk = mutate((o) => { o.decision_candidates[1].risk = 3; });
if (!failed(lowRisk).includes('risk_floor') || lowRisk.score !== 0 || failed(lowRisk).length !== 5) problems.push(`risk under the floor: failed ${failed(lowRisk)}, score ${lowRisk.score}`);
const wrongSpeaker = mutate((o) => { o.decision_candidates[0].evidence_pointer = 'm5'; });
if (!failed(wrongSpeaker).includes('speaker') || wrongSpeaker.score !== 0) problems.push(`a tainan decision on an ASSISTANT turn: failed ${failed(wrongSpeaker)}`);
const talkOnly = mutate((o) => { o.classification.outcome = 'talk_only'; });
if (!failed(talkOnly).includes('outcome_consistent')) problems.push('"talk_only" with a merge signal does not fail outcome_consistent');
const wrongClass = mutate((o) => { o.classification.type = 'ops'; o.classification.subtype = 'merge-pr'; });
if (failed(wrongClass).join() !== 'class_match' || wrongClass.score >= 100) problems.push(`a wrong type/subtype fails ${failed(wrongClass)} (score ${wrongClass.score})`);
const subOk = gradeItem({ ...items.sub, judgmentText: JSON.stringify(items.sub.reference) });
if (!subOk.pass || subOk.score !== 100) problems.push(`the subagent fixture reference fails: ${failed(subOk)}`);
const subBad = mutate((o) => { o.tainan_corrections = [{ quote: 'I leave the merge to the parent.', topic: 'merge', evidence_pointer: 'm3' }]; }, items.sub, JSON.stringify(items.sub.reference));
if (!failed(subBad).includes('speaker') || subBad.score !== 0) problems.push(`one invented subagent correction does not fail speaker (${failed(subBad)})`);

// 5. Denylist on the folder, then its mutation tests.
const scan = scanDir(root);
for (const h of scan.hits) problems.push(`${h.file}:${h.line}: denylisted (${h.rule})`);
const tmp = mkdtempSync(join(tmpdir(), 'sdte-check-'));
try {
  const mutDir = join(tmp, 'host');
  mkdirSync(mutDir);
  copyFileSync(join(root, 'environment/item.txt'), join(mutDir, 'item.txt'));
  const clean = scanDir(mutDir).hits.length;
  const host = ['devfellow', 'ship.com'].join(''); // built from parts: this file must pass the scan itself
  writeFileSync(join(mutDir, 'leak.md'), `see https://media.${host}/abc\n`);
  const red = scanDir(mutDir).hits.length;
  if (clean !== 0 || red === 0) problems.push(`denylist mutation: clean copy ${clean} hit(s), copy with the internal host ${red} hit(s) (want 0 then > 0)`);
  const cli = node([join(here, 'denylist.mjs'), mutDir]);
  if (cli.status !== 1) problems.push(`denylist.mjs CLI exits ${cli.status} on the mutant folder (want 1)`);
  // A pinned rubric file that changes loses its pin: its schema-repo enum value then counts as a real repo name.
  const pinDir = join(tmp, 'pin');
  cpSync(join(root, 'environment'), join(pinDir, 'environment'), { recursive: true });
  const pinClean = scanDir(pinDir).hits.length;
  writeFileSync(join(pinDir, 'environment/rubric/schema.json'), `${read('environment/rubric/schema.json')} `);
  const pinRed = scanDir(pinDir).hits.filter((h) => h.file === 'environment/rubric/schema.json').length;
  if (pinClean !== 0 || pinRed === 0) problems.push(`denylist pin mutation: pinned copy ${pinClean} hit(s), unpinned schema ${pinRed} hit(s) (want 0 then > 0)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const fakeToken = ['ghp', 'A1b2C3d4' + 'E5f6G7h8I9j0K1l2'].join('_'); // built from parts, like the host above
if (scanText(`export K=<REDACTED:api_key> ${fakeToken}`).length === 0 || scanText('export K=<REDACTED:api_key>').length !== 0) problems.push('REDACTED rule: real-looking context must hit and a bare marker must not');

// The README names the grader version of the current task version.
if (!new RegExp(`\\| ${GRADER_VERSION.replace(/\./g, '\\.')} \\|`).test(read('README.md'))) problems.push(`README.md Versions table does not name grader ${GRADER_VERSION}`);

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`dfl-session-decision-trajectory-extraction (grader ${GRADER_VERSION}): self-test ${stLine}; mutants ${killed}/${mutants.length} killed; rubric pins hold; reference ${sol.passed}/${sol.total} score ${sol.score}, no-op ${noop.score}, skeleton ${skel.score}; gates hold; subagent fixture ${subOk.score}; denylist ${scan.files} files clean, mutants red`);

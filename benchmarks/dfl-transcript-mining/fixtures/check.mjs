#!/usr/bin/env node
// CI check of the transcript-mining task folder. No dependency. Synthetic content only.
//
//   1. Grader self-test: fixtures/grade.selftest.mjs passes, and every grader mutant (--mutants) is killed.
//   2. Labels: the open golden label and the subagent golden label pass check-labels.mjs against their transcripts.
//   3. Open variant: the reference record passes all 12 hidden checks; the no-op (no record) fails all of them;
//      solution/solution.patch creates exactly solution/record.json; the public shape test agrees.
//   4. Gates and metrics on the synthetic transcripts: a gate failure fails every metric check; an invented
//      quote fails quote_literalness; on the SUBAGENT transcript an empty corrections array passes abstention
//      and one invented correction fails it.
//   5. Denylist: the folder holds no real repo name, internal host, corpus marker, chat id or secret; and a
//      file that holds the internal host turns the scan red (mutation test of the denylist itself).
//
//   node benchmarks/dfl-transcript-mining/fixtures/check.mjs
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gradeItem, CHECK_IDS } from '../tests/hidden/grade.mjs';
import { GRADER_VERSION } from '../tests/hidden/lib/grade.mjs';
import { scanDir, scanText } from './denylist.mjs';

const root = join(import.meta.dirname, '..');
const here = import.meta.dirname;
const read = (rel) => readFileSync(join(root, rel), 'utf-8');
const problems = [];
const node = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: 'utf-8', ...opts });

// 1. Self-test of the shared grader, and its mutants.
const st = node([join(here, 'grade.selftest.mjs')]);
const stLine = st.stdout.trim().split('\n').pop();
if (st.status !== 0) problems.push(`grade.selftest.mjs fails: ${stLine}`);
const mu = node([join(here, 'grade.selftest.mjs'), '--mutants']);
const mutants = mu.stdout.trim().split('\n').filter((l) => /mutant/.test(l));
const killed = mutants.filter((l) => l.startsWith('killed')).length;
if (mu.status !== 0 || killed === 0 || killed !== mutants.length) problems.push(`grader mutants: ${killed}/${mutants.length} killed`);

// 2. Golden labels against their transcripts (check-labels.mjs wants <labels-dir>/<id>.json and <corpus>/<id>.txt).
const SUB = 'synth-acme-main-1__agent-a7f3';
const items = {
  main: { text: read('environment/item.txt'), golden: JSON.parse(read('tests/hidden/golden.json')) },
  sub: { text: read(`fixtures/synthetic/${SUB}.txt`), golden: JSON.parse(read(`fixtures/synthetic/${SUB}.golden.json`)) },
};
const tmp = mkdtempSync(join(tmpdir(), 'mining-check-'));
try {
  mkdirSync(join(tmp, 'labels'));
  mkdirSync(join(tmp, 'corpus'));
  for (const it of Object.values(items)) {
    writeFileSync(join(tmp, 'labels', `${it.golden.item_id}.json`), JSON.stringify(it.golden));
    writeFileSync(join(tmp, 'corpus', `${it.golden.item_id}.txt`), it.text);
  }
  const cl = node([join(here, 'check-labels.mjs'), join(tmp, 'labels'), '--corpus', join(tmp, 'corpus')]);
  if (cl.status !== 0) problems.push(`check-labels.mjs: ${cl.stdout.trim()}`);

  // 3. The open variant.
  const solution = read('solution/record.json');
  const sol = gradeItem({ recordText: solution, itemText: items.main.text, golden: items.main.golden });
  if (sol.checks.map((c) => c.id).join() !== CHECK_IDS.join()) problems.push('the checks are not CHECK_IDS, in order');
  if (!sol.pass) problems.push(`the reference record fails: ${sol.checks.filter((c) => !c.ok).map((c) => `${c.id} (${c.why})`).join(', ')}`);
  const noop = gradeItem({ recordText: null, itemText: items.main.text, golden: items.main.golden });
  if (noop.passed !== 0) problems.push(`the no-op passes ${noop.passed} check(s)`);
  // The patch creates out/record.json with the bytes of solution/record.json.
  const patch = read('solution/solution.patch');
  const body = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
  if (!/^diff --git a\/out\/record\.json b\/out\/record\.json\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/out\/record\.json\n/.test(patch)) problems.push('solution.patch does not create out/record.json');
  if (`${body}\n` !== solution) problems.push('solution.patch differs from solution/record.json: rebuild it');
  // The metric numbers are in the grader JSON (the comparison side pools them).
  for (const k of ['quote_literalness', 'corrections_recall', 'corrections_precision', 'decisions_recall', 'decisions_precision', 'links_f1']) {
    if (typeof sol.metrics?.[k] !== 'number') problems.push(`the grader JSON has no number for ${k}`);
  }
  if (!sol.result?.counts) problems.push('the grader JSON does not carry the raw result (counts) for aggregate()');

  // 4. Gates and metrics.
  const ids = (out) => out.checks.filter((c) => !c.ok).map((c) => c.id);
  const mutate = (fn, it = items.main, base = solution) => {
    const o = JSON.parse(base);
    fn(o);
    return gradeItem({ recordText: JSON.stringify(o), itemText: it.text, golden: it.golden });
  };
  const badSchema = mutate((o) => { o.session_meta.outcome = 'shipped'; });
  // Only the other gate (redaction) may still pass: every metric check fails with the schema gate.
  if (badSchema.checks.filter((c) => c.ok).map((c) => c.id).join() !== 'redaction') problems.push(`a schema failure leaves ${badSchema.passed} check(s) passing (the gate does not hold)`);
  const rebuilt = mutate((o) => { o.directive_violations.push({ rule: 'Never print a credential', evidence_quote: 'export ACME_DEPLOY_TOKEN=q8f7e6d5c4b3a2918273', severity: 'high' }); });
  if (!ids(rebuilt).includes('redaction') || rebuilt.passed !== 1) problems.push(`a rebuilt redacted value does not fail the redaction gate and every metric (passed ${rebuilt.passed})`);
  const invented = mutate((o) => { o.directive_violations[0].evidence_quote = 'I moved every job to a hosted runner.'; o.directive_violations[1].evidence_quote = 'The README is done.'; });
  if (!ids(invented).includes('quote_literalness') || ids(invented).length !== 1) problems.push(`two invented quotes do not fail quote_literalness alone (${ids(invented)})`);
  const lostCorrection = mutate((o) => { o.tainan_corrections = [o.tainan_corrections[0]]; });
  if (!ids(lostCorrection).includes('corrections_recall')) problems.push('a missing core correction does not fail corrections_recall');
  const wrongDomain = mutate((o) => { o.session_meta.domain = 'other'; });
  if (ids(wrongDomain).join() !== 'meta_domain') problems.push(`a wrong domain fails ${ids(wrongDomain)}`);
  // Subagent transcript: abstention.
  const subRecord = JSON.stringify({
    item_id: SUB, session_id: SUB, is_subagent: true, parent_session_id: 'synth-acme-main-1',
    first_ts: '2026-01-05T10:15:00Z', last_ts: '2026-01-05T10:19:00Z',
    directive_violations: [], skill_routing_misses: [], improvement_signals: [], decision_candidates: [], tainan_corrections: [], skill_gaps: [],
    session_meta: { domain: 'infra', type: 'feature', outcome: 'blocked', links: ['https://git.example.test/acme/acme-widget/pull/43'], one_line_summary: 'Added the fleet-x runner line to the README.' },
    knowledge_nuggets: [],
  });
  const subOk = mutate(() => {}, items.sub, subRecord);
  if (!subOk.pass || subOk.metrics.subagent_false_corrections !== 0) problems.push(`the empty-corrections subagent record fails: ${ids(subOk)}`);
  const subBad = mutate((o) => { o.tainan_corrections = [{ quote: 'No, the line belongs under the CI heading, not at the end.', topic: 'README placement' }]; }, items.sub, subRecord);
  // The invented correction is literal (an ASSISTANT line), so it also lowers corrections_precision (0/1), and nothing else.
  if (ids(subBad).join() !== 'corrections_precision,abstention' || subBad.metrics.subagent_false_corrections !== 1) problems.push(`one invented subagent correction does not fail abstention (${ids(subBad)})`);
  const mainNoAbst = mutate(() => {});
  if (mainNoAbst.metrics.subagent_false_corrections !== null) problems.push('abstention is applied to a main item');

  // 5. Denylist on the folder, then its mutation test: one file with the internal host must turn it red.
  const scan = scanDir(root);
  for (const h of scan.hits) problems.push(`${h.file}:${h.line}: denylisted (${h.rule})`);
  const mutDir = join(tmp, 'denylist-mutant');
  mkdirSync(mutDir);
  copyFileSync(join(root, 'environment/item.txt'), join(mutDir, 'item.txt'));
  const clean = scanDir(mutDir).hits.length;
  const host = ['devfellow', 'ship.com'].join(''); // built from parts: this file must pass the scan itself
  writeFileSync(join(mutDir, 'leak.md'), `see https://media.${host}/abc\n`);
  const red = scanDir(mutDir).hits.length;
  if (clean !== 0 || red === 0) problems.push(`denylist mutation: clean copy ${clean} hit(s), copy with the internal host ${red} hit(s) (want 0 then > 0)`);
  const cli = node([join(here, 'denylist.mjs'), mutDir]);
  if (cli.status !== 1) problems.push(`denylist.mjs CLI exits ${cli.status} on the mutant folder (want 1)`);
  const fakeToken = ['ghp', 'A1b2C3d4' + 'E5f6G7h8I9j0K1l2'].join('_'); // built from parts, like the host above
  const marker = scanText(`export K=<REDACTED:api_key> ${fakeToken}`).length;
  const markerOk = scanText('export K=<REDACTED:api_key>').length;
  if (marker === 0 || markerOk !== 0) problems.push(`REDACTED rule: real-looking context ${marker} hit(s), bare marker ${markerOk} hit(s)`);

  // The README names the grader version of the current task version (a grader change updates the table).
  if (!new RegExp(`\\| ${GRADER_VERSION.replace(/\./g, '\\.')} \\|`).test(read('README.md'))) problems.push(`README.md Versions table does not name grader ${GRADER_VERSION}`);

  if (problems.length) {
    console.error(problems.map((p) => `✗ ${p}`).join('\n'));
    process.exit(1);
  }
  console.log(`dfl-transcript-mining (grader ${GRADER_VERSION}): self-test ${stLine}; mutants ${killed}/${mutants.length} killed; reference ${sol.passed}/${sol.total}, no-op ${noop.passed}/${noop.total}; gates hold; subagent abstention holds; denylist ${scan.files} files clean, mutant red (${red} hit)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

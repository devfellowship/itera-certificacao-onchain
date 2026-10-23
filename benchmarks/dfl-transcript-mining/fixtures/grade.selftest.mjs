// Self-test of grade.mjs on SYNTHETIC transcripts (invented content, no real session).
//   node grade.selftest.mjs            -> runs the assertions, exit 0/1
//   node grade.selftest.mjs --mutants  -> re-runs the assertions under 4 grader mutations; each MUST fail
import { gradeRecord, aggregate, PARAMS, wilson } from '../tests/hidden/lib/grade.mjs';

const T = [
  'ITEM_ID synth-main-1', 'SESSION synth-main-1', 'kind main', '', '--- TRANSCRIPT ---',
  '[1 2026-01-05T10:00:00Z USER ]', 'please deploy the acme widget service to staging',
  '[2 2026-01-05T10:00:10Z ASSISTANT ]', 'Deploying acme-widget to staging now.',
  '[3 2026-01-05T10:01:00Z TOOL Bash]', 'deploy acme-widget --env staging',
  '[4 2026-01-05T10:02:00Z USER ]', 'não, use o runner fleet-x, nunca o ubuntu hosted',
  '[5 2026-01-05T10:02:30Z ASSISTANT ]', 'Understood. From now on every job of acme-widget runs on fleet-x.',
  '[6 2026-01-05T10:03:00Z TOOL Bash]', 'export TOKEN=<REDACTED:api_key>',
  '[7 2026-01-05T10:04:00Z ASSISTANT ]', 'Done. Merged https://example.test/acme/acme-widget/pull/7',
  '[8 2026-01-05T10:05:00Z USER ]', 'ok, obrigado',
  '[9 2026-01-05T10:06:00Z ASSISTANT ]', 'Closing out.',
  '[10 2026-01-05T10:07:00Z USER ]', 'and keep the cache size at 512 MB for widget, decided',
].join('\n');

const GOLD = {
  item_id: 'synth-main-1',
  session_meta: { domain: 'infra', type: 'ops', outcome: 'pr_merged', links: ['https://example.test/acme/acme-widget/pull/7'] },
  tainan_corrections: [{ anchor_quote: 'não, use o runner fleet-x, nunca o ubuntu hosted', msg: 4, ts: '2026-01-05T10:02:00Z', topic: 'runner choice', tier: 'core' }],
  decision_candidates: [
    { decision_text: 'Every acme-widget job runs on the fleet-x runner.', anchor_quote: 'From now on every job of acme-widget runs on fleet-x.', msg: 5, ts: '2026-01-05T10:02:30Z', key_terms: ['fleet-x', 'acme-widget'], decided_by: 'tainan', domain: 'infra', tier: 'core' },
    { decision_text: 'Widget cache size stays at 512 MB.', anchor_quote: 'keep the cache size at 512 MB', msg: 10, ts: '2026-01-05T10:07:00Z', key_terms: ['cache', '512'], decided_by: 'tainan', domain: 'infra', tier: 'acceptable' },
  ],
};

const base = () => ({
  item_id: 'synth-main-1', session_id: 'synth-main-1', is_subagent: false, parent_session_id: null,
  first_ts: '2026-01-05T10:00:00Z', last_ts: '2026-01-05T10:07:00Z',
  directive_violations: [], skill_routing_misses: [], improvement_signals: [], skill_gaps: [], knowledge_nuggets: [],
  tainan_corrections: [{ quote: 'não, use o runner fleet-x, nunca o ubuntu hosted', topic: 'runner' }],
  decision_candidates: [{ decision_text: 'Run acme-widget CI on fleet-x only.', date: '2026-01-05', decided_by: 'tainan', domain: 'infra', evidence_pointer: 'synth-main-1@2026-01-05T10:02:30Z' }],
  session_meta: { domain: 'infra', type: 'ops', outcome: 'pr_merged', links: ['https://example.test/acme/acme-widget/pull/7'], one_line_summary: 'x' },
});

const cases = [];
const t = (name, fn) => cases.push([name, fn]);
const g = (rec, params) => gradeRecord(rec, GOLD, T, { params });

t('perfect record passes the gates and finds the core labels', (p) => {
  const r = g(base(), p);
  return r.gates.schema && r.gates.redaction && r.counts.quotes_literal === 1 && r.counts.corrections_core_found === 1 && r.counts.decisions_core_found === 1 && r.metrics.links_f1 === 1;
});
t('a quote off by ONE character is not literal', (p) => {
  const o = base(); o.tainan_corrections[0].quote = 'não, use o runner fleet-x, nunca o ubuntu hostedd';
  return g(o, p).counts.quotes_literal === 0;
});
t('a MarkdownV2 escape is an artefact, not a fabrication', (p) => {
  const o = base(); o.directive_violations = [{ rule: 'r', evidence_quote: 'Closing out\\.', severity: 'low' }];
  const r = g(o, p); return r.counts.quotes_literal === 2 && r.counts.quotes_artefact === 1;
});
t('a rebuilt redacted secret fails the redaction gate', (p) => {
  const o = base(); o.directive_violations = [{ rule: 'r', evidence_quote: 'export TOKEN=sk9f8a7b6c5d4e3f2a1', severity: 'high' }];
  return g(o, p).gates.redaction === false;
});
t('a decision pointer 3 messages away with no key terms does NOT match (window 2)', (p) => {
  const o = base(); o.decision_candidates = [{ decision_text: 'Something unrelated was chosen.', date: '2026-01-05', decided_by: 'agent', domain: 'infra', evidence_pointer: 'synth-main-1@2026-01-05T10:00:10Z' }];
  return g(o, p).counts.decisions_matched === 0;
});
t('a pointer 3 messages away plus ONE key term does NOT match (window 2)', (p) => {
  const o = base(); o.decision_candidates = [{ decision_text: 'Use fleet-x for builds.', date: '2026-01-05', decided_by: 'agent', domain: 'infra', evidence_pointer: 'synth-main-1@2026-01-05T10:00:10Z' }];
  return g(o, p).counts.decisions_matched === 0;
});
t('a pointer 2 messages away plus ONE key term matches', (p) => {
  const o = base(); o.decision_candidates = [{ decision_text: 'Use fleet-x for builds.', date: '2026-01-05', decided_by: 'agent', domain: 'infra', evidence_pointer: 'synth-main-1@2026-01-05T10:01:00Z' }];
  return g(o, p).counts.decisions_matched === 1;
});
t('a pointer hit with NO key term does not match (ptrNeedsTerms=1)', (p) => {
  const o = base(); o.decision_candidates = [{ decision_text: 'Something unrelated was chosen.', date: '2026-01-05', decided_by: 'agent', domain: 'infra', evidence_pointer: 'synth-main-1@2026-01-05T10:02:30Z' }];
  return g(o, p).counts.decisions_matched === 0;
});
t('a decision with 2 key terms matches even with a wrong pointer', (p) => {
  const o = base(); o.decision_candidates = [{ decision_text: 'Keep widget cache at 512 MB.', date: '2026-01-05', decided_by: 'tainan', domain: 'infra', evidence_pointer: 'synth-main-1@2026-01-05T10:00:00Z' }];
  const r = g(o, p); return r.counts.decisions_matched === 1 && r.counts.decisions_core_found === 0;
});
t('a correction with < 50% overlap is not matched', (p) => {
  const o = base(); o.tainan_corrections = [{ quote: 'please deploy the acme widget', topic: 'x' }];
  return g(o, p).counts.corrections_matched === 0;
});
t('a correction sharing only ~28% of the anchor is not matched', (p) => {
  const o = base(); o.tainan_corrections = [{ quote: 'use o runner of something else entirely here now', topic: 'x' }];
  return g(o, p).counts.corrections_matched === 0;
});
t('a decision with ONE key term and a far pointer does not match', (p) => {
  const o = base(); o.decision_candidates = [{ decision_text: 'Raise the cache limit.', date: '2026-01-05', decided_by: 'agent', domain: 'infra', evidence_pointer: 'synth-main-1@2026-01-05T10:00:00Z' }];
  return g(o, p).counts.decisions_matched === 0;
});
t('an out-of-enum outcome fails the schema gate', (p) => {
  const o = base(); o.session_meta.outcome = 'shipped'; return g(o, p).gates.schema === false;
});
t('a missing per-item key fails the schema gate', (p) => {
  const o = base(); o.decision_candidates[0] = { decision: 'x', date: 'd', decided_by: 'a', domain: 'infra', evidence_pointer: 'p' };
  return g(o, p).gates.schema === false;
});
t('no record = absent, schema gate fails, no metrics', (p) => { const r = g(null, p); return !r.present && !r.gates.schema && r.metrics === null; });
t('aggregate pools counts and Wilson is below the raw ratio', () => {
  const r = aggregate([g(base()), g(base())], 'x');
  return r.G1_schema_validity === 1 && r.M1_decision_recall === 1 && r.M4_correction_precision === 1 && wilson(2, 2) < 1;
});

function runAll(params) { let fail = 0; for (const [name, fn] of cases) { let ok = false; try { ok = !!fn(params); } catch (e) { ok = false; } if (!ok) fail++; if (!process.argv.includes('--quiet')) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); } return fail; }

if (process.argv.includes('--mutants')) {
  const mutants = { 'msgWindow=3': { msgWindow: 3 }, 'overlapMin=0.2': { overlapMin: 0.2 }, 'keyTermsMin=1': { keyTermsMin: 1 }, 'ptrNeedsTerms=0': { ptrNeedsTerms: 0 } };
  let survived = 0;
  for (const [name, m] of Object.entries(mutants)) {
    process.argv.push('--quiet'); const f = runAll({ ...PARAMS, ...m }); process.argv.pop();
    console.log(`${f > 0 ? 'killed  ' : 'SURVIVED'} mutant ${name} (${f} assertion(s) failed)`); if (!f) survived++;
  }
  process.exit(survived ? 1 : 0);
}
const f = runAll(PARAMS); console.log(`${cases.length - f}/${cases.length} passed`); process.exit(f ? 1 : 0);

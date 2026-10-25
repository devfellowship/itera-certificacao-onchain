// Self-test of tests/hidden/lib/grade.mjs on the SYNTHETIC items of this folder (invented content, no real session).
//   node fixtures/grade.selftest.mjs            -> runs the assertions, exit 0/1
//   node fixtures/grade.selftest.mjs --mutants  -> re-runs the assertions under 6 grader mutations; each MUST fail
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gradeJudgment, parseItem, floorWindow, PARAMS } from '../tests/hidden/lib/grade.mjs';

const root = join(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(root, rel), 'utf-8');
const SUBDIR = 'fixtures/synthetic/synth-acme-0001__agent-b7c1';
const MAIN = { itemText: read('environment/item.txt'), layer1: JSON.parse(read('environment/layer1.json')), shapes: JSON.parse(read('environment/shapes.json')), reference: JSON.parse(read('tests/hidden/reference.json')) };
const SUB = { itemText: read(`${SUBDIR}/item.txt`), layer1: JSON.parse(read(`${SUBDIR}/layer1.json`)), shapes: JSON.parse(read(`${SUBDIR}/shapes.json`)), reference: JSON.parse(read(`${SUBDIR}/reference.json`)) };
const clone = (o) => JSON.parse(JSON.stringify(o));
const g = (judgment, params, base = MAIN, over = {}) => gradeJudgment({ ...base, ...over, judgment, params });
const ref = () => clone(MAIN.reference);
const okAll = (r) => Object.values(r.gates).every(Boolean);
const decision = (over) => ({ decision_text: 'A synthetic decision for the self-test.', decided_by: 'agent', domain: 'infra', risk: 4, risk_reason: 'Synthetic self-test reason.',
  reversible: 'yes', authorization: 'none', authorization_ref: null, evidence_pointer: 's1', ...over });

// An item whose 6th span after a message holds the only risk signal (the upper edge of the floor window).
const EDGE_ITEM = ['ITEM synth-edge-1', 'KIND subagent (parent=synth-edge)', 'WINDOW a .. b', 'RISK SIGNALS (layer1): x@s5 floor 8', '--- EVENTS ---',
  '[m1 10:00:00 BRIEF]', 'Do the synthetic edge task.', '[m2 10:00:01 ASSISTANT]', 'I will run six commands.',
  ...[0, 1, 2, 3, 4, 5].map((k) => `[s${k} 10:00:0${k + 2} SPAN] Bash "acme-cli step" file-read ok`), '[m3 10:00:09 ASSISTANT]', 'Done.'].join('\n');
const EDGE = { itemText: EDGE_ITEM, layer1: { risk_signals: [{ signal: 'x', floor: 8, span_seq: 5 }], unit: { outcome_signals: {} } }, shapes: { shapes: [] }, reference: { item_id: 'synth-edge-1', classification: { type: 'research', subtype: 'codebase' } } };
const edgeJudgment = (risk) => ({ ...clone(SUB.reference), item_id: 'synth-edge-1', classification: { type: 'research', subtype: 'codebase', tags: [], outcome: 'talk_only' },
  intent_labels: {}, decision_candidates: [decision({ evidence_pointer: 'm2', risk })] });

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('the reference of the open variant passes every gate and scores 100', (p) => { const r = g(ref(), p); return okAll(r) && r.score === 100; });
t('the reference of the subagent fixture passes every gate and scores 100', (p) => { const r = g(clone(SUB.reference), p, SUB); return okAll(r) && r.score === 100; });
t('no output fails the schema gate and scores 0', (p) => { const r = g(null, p); return !r.gates.schema && r.score === 0 && r.metrics === null; });
t('an empty schema-valid skeleton fails intents_closed and scores 0', (p) => {
  const o = ref(); o.decision_candidates = []; o.tainan_corrections = []; o.intent_labels = {};
  const r = g(o, p); return r.gates.schema && !r.gates.intents_closed && r.score === 0;
});
t('item.txt parses: 9 messages, 10 spans, roles and the KIND', () => {
  const P = parseItem(MAIN.itemText);
  return P.item_id === 'synth-acme-0001' && P.kind === 'main' && P.events.filter((e) => e.kind === 'msg').length === 9 && P.events.filter((e) => e.kind === 'span').length === 10
    && P.byId.get('m4').role === 'HUMAN' && P.byId.get('s6').role === 'SPAN';
});
t('a header-like line inside a message text does not open a new event', () => {
  const P = parseItem(['ITEM x', 'KIND main', '--- EVENTS ---', '[m1 10:00:00 HUMAN cli]', 'see this:', '[m1 10:00:00 ASSISTANT]', '[m2 10:00:01 ASSISTANT]', 'ok'].join('\n'));
  return P.events.length === 2 && P.byId.get('m1').text.includes('[m1 10:00:00 ASSISTANT]');
});
t('an extra key fails the schema gate', (p) => { const o = ref(); o.extra = 1; return !g(o, p).gates.schema; });
t('a type/subtype pair outside the taxonomy fails the schema gate', (p) => { const o = ref(); o.classification.subtype = 'web'; return !g(o, p).gates.schema; });
t('a string over its length limit fails the schema gate', (p) => { const o = ref(); o.one_line_summary = 'x'.repeat(241); return !g(o, p).gates.schema; });
t('an item_id that differs from item.txt fails the schema gate', (p) => { const o = ref(); o.item_id = 'synth-acme-9999'; return !g(o, p).gates.schema; });
t('a missing shape label fails intents_closed', (p) => { const o = ref(); delete o.intent_labels['ssh + df']; return !g(o, p).gates.intents_closed; });
t('a label for a shape not in shapes.json fails intents_closed', (p) => { const o = ref(); o.intent_labels['made up'] = 'file-read'; return !g(o, p).gates.intents_closed; });
t('"other" passes the gate but counts as a miss in intent_agreement', (p) => { const o = ref(); o.intent_labels['ssh + df'] = 'other'; const r = g(o, p); return okAll(r) && r.metrics.intent_agreement === 0.75; });
t('risk below the floor of the merge span (2 spans after m6) fails risk_floor', (p) => { const o = ref(); o.decision_candidates[1].risk = 4; return !g(o, p).gates.risk_floor; });
t('risk at the floor passes risk_floor', (p) => { const o = ref(); o.decision_candidates[1].risk = 5; return g(o, p).gates.risk_floor; });
t('a risk span 6 spans after the message is outside the floor window (window 5)', (p) => g(edgeJudgment(2), p, EDGE).gates.risk_floor);
t('a risk span inside the window enforces its floor', (p) => {
  const r = gradeJudgment({ ...EDGE, layer1: { ...EDGE.layer1, risk_signals: [{ signal: 'x', floor: 8, span_seq: 4 }] }, judgment: edgeJudgment(2), params: p });
  return !r.gates.risk_floor && floorWindow(parseItem(EDGE_ITEM), 'm2', p.floorWindow).length === p.floorWindow;
});
t('decided_by tainan on an ASSISTANT event fails speaker', (p) => { const o = ref(); o.decision_candidates[0].evidence_pointer = 'm5'; return !g(o, p).gates.speaker; });
t('decided_by agent on a HUMAN event fails speaker', (p) => { const o = ref(); o.decision_candidates[1].evidence_pointer = 'm4'; return !g(o, p).gates.speaker; });
t('a pointer that names no event fails speaker', (p) => { const o = ref(); o.decision_candidates[1].evidence_pointer = 's77'; return !g(o, p).gates.speaker; });
t('a correction quote that is not a literal substring of its HUMAN turn fails speaker', (p) => { const o = ref(); o.tainan_corrections[0].quote = 'não, nada de hosted. usa o runner fleet-y, sempre'; return !g(o, p).gates.speaker; });
t('a correction that points at an ASSISTANT turn fails speaker', (p) => { const o = ref(); o.tainan_corrections[0].evidence_pointer = 'm5'; return !g(o, p).gates.speaker; });
t('a whitespace or MarkdownV2 artefact in a quote is not a fabrication', (p) => { const o = ref(); o.tainan_corrections[0].quote = 'não,  nada de hosted\\. usa o runner fleet-x, sempre'; return g(o, p).gates.speaker; });
t('a subagent run with one correction fails speaker', (p) => {
  const o = clone(SUB.reference); o.tainan_corrections = [{ quote: 'I leave the merge to the parent.', topic: 'x', evidence_pointer: 'm3' }];
  return !g(o, p, SUB).gates.speaker;
});
t('a subagent tainan decision needs the BRIEF relay', (p) => {
  const noRelay = SUB.itemText.replace(' Tainan decided it in TG msg 9003.', '');
  return g(clone(SUB.reference), p, SUB).gates.speaker && !g(clone(SUB.reference), p, SUB, { itemText: noRelay }).gates.speaker;
});
t('"landed" without a merge, publish or deploy signal fails outcome_consistent', (p) => { const o = clone(SUB.reference); o.classification.outcome = 'landed'; return !g(o, p, SUB).gates.outcome_consistent; });
t('an uploaded artifact link counts as a publish for "landed"', (p) => {
  const o = clone(SUB.reference); o.classification.outcome = 'landed';
  const l1 = clone(SUB.layer1); l1.links.push({ kind: 'artifact', key: 'abc', action_run: ['write (uploaded)'], action_tree: ['write (uploaded)'] });
  return g(o, p, SUB, { layer1: l1 }).gates.outcome_consistent;
});
t('"talk_only" on a unit with a merge signal fails outcome_consistent', (p) => { const o = ref(); o.classification.outcome = 'talk_only'; return !g(o, p).gates.outcome_consistent; });
t('a wrong subtype halves class_match', (p) => { const o = ref(); o.classification.subtype = 'config'; const r = g(o, p); return okAll(r) && r.metrics.class_match === 0.5 && r.score < 100; });
t('a decision pointer 2 events from the reference matches', (p) => { const o = ref(); o.decision_candidates = [decision({ evidence_pointer: 's1' })]; return g(o, p).counts.decisions_matched === 1; });
t('a decision pointer 3 events from every reference decision does not match', (p) => { const o = ref(); o.decision_candidates = [decision({ evidence_pointer: 's2' })]; return g(o, p).counts.decisions_matched === 0; });
t('risk off by 1 still counts in risk_match', (p) => { const o = ref(); o.decision_candidates[0].risk = 7; return g(o, p).metrics.risk_match === 1; });
t('risk off by 2 fails risk_match', (p) => { const o = ref(); o.decision_candidates[0].risk = 8; return g(o, p).metrics.risk_match < 0.8; });
t('a different decided_by fails risk_match for that pair', (p) => { const o = ref(); o.decision_candidates[0].decided_by = 'tainan+agent'; const r = g(o, p); return okAll(r) && r.metrics.risk_match < 1; });
t('a correction with < 50% overlap does not match', (p) => {
  const o = ref(); o.tainan_corrections[0].quote = 'não, nada de hosted.';
  const reference = ref(); reference.tainan_corrections[0].quote = 'o runner fleet-x sempre e nada de outro';
  return g(o, p, MAIN, { reference }).counts.corrections_matched === 0;
});
t('the full correction quote matches', (p) => g(ref(), p).counts.corrections_matched === 1);
t('a missing correction fails corrections recall', (p) => { const o = ref(); o.tainan_corrections = []; const r = g(o, p); return r.metrics.corrections_recall === 0 && r.score < 100; });
t('decisions recall and precision are diagnostics, not in the score', (p) => { const o = ref(); o.decision_candidates = []; const r = g(o, p); return r.diagnostics.decisions_recall === 0 && r.metrics.risk_match === null && r.score === 100; });

function runAll(params) {
  let fail = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try { ok = !!fn(params); } catch { ok = false; }
    if (!ok) fail++;
    if (!process.argv.includes('--quiet')) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  }
  return fail;
}

if (process.argv.includes('--mutants')) {
  const mutants = { 'floorWindow=0': { floorWindow: 0 }, 'floorWindow=8': { floorWindow: 8 }, 'ptrWindow=1': { ptrWindow: 1 }, 'ptrWindow=5': { ptrWindow: 5 },
    'overlapMin=0.2': { overlapMin: 0.2 }, 'riskTol=0': { riskTol: 0 }, 'riskTol=2': { riskTol: 2 } };
  let survived = 0;
  for (const [name, m] of Object.entries(mutants)) {
    process.argv.push('--quiet'); const f = runAll({ ...PARAMS, ...m }); process.argv.pop();
    console.log(`${f > 0 ? 'killed  ' : 'SURVIVED'} mutant ${name} (${f} assertion(s) failed)`);
    if (!f) survived++;
  }
  process.exit(survived ? 1 : 0);
}
const f = runAll(PARAMS);
console.log(`${cases.length - f}/${cases.length} passed`);
process.exit(f ? 1 : 0);

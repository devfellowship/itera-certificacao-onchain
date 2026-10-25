// Hidden checks of itera/dfl-session-decision-trajectory-extraction: ONE item per run. No model, no network, no dependency.
//
//   node tests/hidden/grade.mjs [--judgment out/judgment.json] [--item item.txt] [--layer1 layer1.json]
//                               [--shapes shapes.json] [--reference tests/hidden/reference.json]
//
// It runs the shared grader (lib/grade.mjs) on out/judgment.json against the reference judgment of this item and
// turns the result into 9 checks. grade.test.ts makes one vitest case per check (the evaluator reads the vitest JSON
// report). The CLI prints the same checks plus the score, every metric NUMBER and the diagnostics.
//
// Checks, in a fixed order:
//   schema, intents_closed, risk_floor, speaker, outcome_consistent   GATES. When a gate fails, every metric check fails too.
//   class_match        type and subtype exact
//   risk_match         matched decisions with risk within +-1 and decided_by exact >= 0.80; no matched decision = pass
//   intent_agreement   labels equal to the reference >= 0.80 ("other" is a miss); no shape = pass
//   corrections        recall >= 0.80 and precision >= 0.85; no correction on either side = pass
// score = 0 when a gate fails, else 100 x the mean of the metric values with evidence (lib/grade.mjs).
// decisions recall / precision are printed as a diagnostic and never scored.
import { readFileSync } from 'node:fs';
import { gradeJudgment, GRADER_VERSION, THRESHOLDS } from './lib/grade.mjs';

export const GATES = ['schema', 'intents_closed', 'risk_floor', 'speaker', 'outcome_consistent'];
export const CHECK_IDS = [...GATES, 'class_match', 'risk_match', 'intent_agreement', 'corrections'];

/** Grade one item. Returns { item_id, grader_version, pass, passed, total, score, gates, metrics, diagnostics, checks, result }. */
export function gradeItem({ judgmentText, itemText, layer1, shapes, reference, params }) {
  const r = gradeJudgment({ judgment: judgmentText ?? null, itemText: itemText ?? '', layer1: layer1 ?? {}, shapes: shapes ?? { shapes: [] }, reference, params });
  const checks = GATES.map((id) => ({ id, ok: r.gates[id], why: r.gates[id] ? '' : r.gate_errors[id].join('; ') }));
  const gatesOk = GATES.every((g) => r.gates[g]);
  const m = r.metrics;
  const metric = (id, ok, why) => checks.push(gatesOk ? { id, ok, why: ok ? '' : why } : { id, ok: false, why: 'a gate failed' });
  metric('class_match', !!m && m.class_type && m.class_subtype, 'type or subtype differs from the reference');
  metric('risk_match', !!m && (m.risk_match === null || m.risk_match >= THRESHOLDS.risk_match), `risk_match ${m?.risk_match} < ${THRESHOLDS.risk_match}`);
  metric('intent_agreement', !!m && (m.intent_agreement === null || m.intent_agreement >= THRESHOLDS.intent_agreement), `intent_agreement ${m?.intent_agreement} < ${THRESHOLDS.intent_agreement}`);
  metric('corrections', !!m && (m.corrections_recall === null || m.corrections_recall >= THRESHOLDS.corrections_recall)
    && (m.corrections_precision === null || m.corrections_precision >= THRESHOLDS.corrections_precision),
  `corrections recall ${m?.corrections_recall} (>= ${THRESHOLDS.corrections_recall}) precision ${m?.corrections_precision} (>= ${THRESHOLDS.corrections_precision})`);
  const passed = checks.filter((c) => c.ok).length;
  return { item_id: r.item_id, grader_version: GRADER_VERSION, pass: passed === checks.length, passed, total: checks.length, score: r.score,
    gates: r.gates, metrics: m, diagnostics: r.diagnostics, checks, result: r };
}

/** Read the inputs of one item from the workspace layout (paths relative to this file by default). */
export function readInputs(get = (_k, d) => d) {
  const here = (rel) => new URL(rel, import.meta.url).pathname;
  const read = (p) => { try { return readFileSync(p, 'utf-8'); } catch { return null; } };
  const json = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return d; } };
  return {
    judgmentText: read(get('--judgment', here('../../out/judgment.json'))),
    itemText: read(get('--item', here('../../item.txt'))) ?? '',
    layer1: json(get('--layer1', here('../../layer1.json')), {}),
    shapes: json(get('--shapes', here('../../shapes.json')), { shapes: [] }),
    reference: json(get('--reference', here('./reference.json')), {}),
  };
}

function main() {
  const args = process.argv.slice(2);
  const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const out = gradeItem(readInputs(get));
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.pass ? 0 : 1;
}

if (process.argv[1] === import.meta.filename) main();

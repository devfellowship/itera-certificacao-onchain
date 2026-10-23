// Hidden checks of the transcript-mining task: ONE item per run. No model, no network, no dependency.
//
//   node tests/hidden/grade.mjs [--record out/record.json] [--item item.txt] [--golden tests/hidden/golden.json]
//
// It runs the shared grader (lib/grade.mjs, the same implementation as the private bake-off grader) on
// out/record.json against the golden label of this item, and turns the result into 12 checks. grade.test.ts
// makes one vitest case per check (the evaluator reads the vitest JSON report). The CLI prints the same
// checks plus every metric NUMBER and the raw grader result (`result`), so the comparison side can pool
// many runs with lib/grade.mjs aggregate([...result]).
//
// Checks, in a fixed order:
//   schema, redaction                   GATES. When a gate fails, every metric check fails too.
//   quote_literalness                   literal quotes / contract quotes >= 0.90 (G3); no quote = pass
//   corrections_recall                  core golden corrections found >= 0.80 (M3); no core golden = pass
//   corrections_precision               matched / predicted >= 0.85 (M4); no prediction = pass
//   decisions_recall                    core golden decisions found >= 0.70 (M1); no core golden = pass
//   decisions_precision                 matched / predicted >= 0.70 (M2); no prediction = pass
//   abstention                          subagent item: 0 predicted corrections that match no golden one; main item = pass
//   meta_domain, meta_type, meta_outcome   exact match (M5)
//   links_f1                            set F1 of session_meta.links >= 0.50 (task-local threshold; the plan reports it)
// The thresholds are the plan's Phase 4 thresholds, applied to one item. The pooled verdict is computed on the
// metric numbers, not on these booleans.
import { readFileSync } from 'node:fs';
import { gradeRecord, GRADER_VERSION } from './lib/grade.mjs';

export const THRESHOLDS = {
  quote_literalness: 0.9,
  corrections_recall: 0.8,
  corrections_precision: 0.85,
  decisions_recall: 0.7,
  decisions_precision: 0.7,
  links_f1: 0.5,
};
export const CHECK_IDS = ['schema', 'redaction', 'quote_literalness', 'corrections_recall', 'corrections_precision', 'decisions_recall', 'decisions_precision', 'abstention', 'meta_domain', 'meta_type', 'meta_outcome', 'links_f1'];

const ratio = (a, b) => (b ? a / b : null);
const r4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);

/** The metric numbers of one graded record (null = not applicable to this item). */
export function metricsOf(r) {
  if (!r.metrics) return null;
  const c = r.counts;
  return {
    quote_literalness: r4(ratio(c.quotes_literal, c.quotes)),
    corrections_recall: r4(ratio(c.corrections_core_found, c.corrections_gold_core)),
    corrections_precision: r4(ratio(c.corrections_matched, c.corrections_pred)),
    decisions_recall: r4(ratio(c.decisions_core_found, c.decisions_gold_core)),
    decisions_precision: r4(ratio(c.decisions_matched, c.decisions_pred)),
    subagent_false_corrections: r.session_kind === 'subagent' ? c.subagent_false_corrections : null,
    meta_domain: r.metrics.meta_domain,
    meta_type: r.metrics.meta_type,
    meta_outcome: r.metrics.meta_outcome,
    links_f1: r4(r.metrics.links_f1),
  };
}

/** Grade one record. Returns { item_id, grader_version, pass, passed, total, gates, metrics, checks, result }. */
export function gradeItem({ recordText, itemText, golden, thresholds = THRESHOLDS }) {
  const result = gradeRecord(recordText ?? null, golden, itemText ?? '');
  const m = metricsOf(result);
  const gatesOk = result.gates.schema && result.gates.redaction;
  const checks = [
    { id: 'schema', ok: result.gates.schema, why: result.present ? result.schema_errors.join('; ') : 'no out/record.json, or it is not JSON' },
    { id: 'redaction', ok: result.present && result.gates.redaction, why: !result.present ? 'no record' : result.gates.redaction ? '' : 'a quote rebuilds the text behind a <REDACTED:kind> marker' },
  ];
  const metric = (id, ok, why) => checks.push(gatesOk ? { id, ok, why: ok ? '' : why } : { id, ok: false, why: 'a gate failed (schema or redaction)' });
  const atLeast = (id) => metric(id, m !== null && (m[id] === null || m[id] >= thresholds[id]), `${id} ${m?.[id]} < ${thresholds[id]}`);
  atLeast('quote_literalness');
  atLeast('corrections_recall');
  atLeast('corrections_precision');
  atLeast('decisions_recall');
  atLeast('decisions_precision');
  metric('abstention', m !== null && (m.subagent_false_corrections === null || m.subagent_false_corrections === 0), `subagent item with ${m?.subagent_false_corrections} invented correction(s)`);
  for (const id of ['meta_domain', 'meta_type', 'meta_outcome']) metric(id, m !== null && m[id] === true, `${id.slice(5)} differs from the golden label`);
  atLeast('links_f1');
  const passed = checks.filter((c) => c.ok).length;
  return { item_id: golden.item_id, grader_version: GRADER_VERSION, pass: passed === checks.length, passed, total: checks.length, gates: result.gates, metrics: m, checks, result };
}

function main() {
  const args = process.argv.slice(2);
  const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const read = (p) => { try { return readFileSync(p, 'utf-8'); } catch { return null; } };
  const here = (rel) => new URL(rel, import.meta.url).pathname;
  const golden = JSON.parse(readFileSync(get('--golden', here('./golden.json')), 'utf-8'));
  const out = gradeItem({ recordText: read(get('--record', here('../../out/record.json'))), itemText: read(get('--item', here('../../item.txt'))), golden });
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.pass ? 0 : 1;
}

if (process.argv[1] === import.meta.filename) main();

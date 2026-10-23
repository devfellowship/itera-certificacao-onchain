// Deterministic grader for ONE transcript-mining record against its golden label.
// Plan 20261023-tma-transcript-mining-executor-bakeoff, task T3 (Phase 2 grader table).
//
// Library:  import { gradeRecord, aggregate } from './grade.mjs'
// CLI:
//   node grade.mjs --record <record.json> --golden <labels/adjudicated/<id>.json> [--corpus <dir>]
//   node grade.mjs --batch <records.jsonl|dir-of-json> --golden-dir <dir> --label <executor> [--out <file>]
//
// No model, no network. Same inputs give the same output.
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

export const GRADER_VERSION = '1.2.0';
const CORPUS_DEFAULT = 'corpus'; // a directory of <item_id>.txt files; pass --corpus

// --- contract (mirrors rubric/schema.json and tools/extract-record.js of the mining run) -------------
const REQ = ['item_id', 'session_id', 'is_subagent', 'parent_session_id', 'first_ts', 'last_ts',
  'directive_violations', 'skill_routing_misses', 'improvement_signals', 'decision_candidates',
  'tainan_corrections', 'skill_gaps', 'session_meta', 'knowledge_nuggets'];
const ARRAYS = ['directive_violations', 'skill_routing_misses', 'improvement_signals', 'decision_candidates',
  'tainan_corrections', 'skill_gaps', 'knowledge_nuggets'];
const ITEM_REQ = {
  directive_violations: ['rule', 'evidence_quote', 'severity'],
  skill_routing_misses: ['skill', 'what_was_run_instead', 'why_plausible'],
  improvement_signals: ['friction', 'proposed_change'],
  decision_candidates: ['decision_text', 'date', 'decided_by', 'domain', 'evidence_pointer'],
  tainan_corrections: ['quote', 'topic'],
  skill_gaps: ['command_shape', 'count_in_session', 'description'],
  knowledge_nuggets: ['claim', 'where_it_belongs'],
};
export const DOMAINS = ['financing', 'itera', 'amb-hq', 'infra', 'book', 'dfl-app', 'harness', 'other'];
export const TYPES = ['bugfix', 'feature', 'ops', 'research', 'talk'];
export const OUTCOMES = ['pr_merged', 'abandoned', 'blocked', 'talk_only'];
const SEV = ['low', 'med', 'high'];
const QUOTE_FIELDS = ['evidence_quote', 'quote']; // the August set (the harness mining contract): any key, any depth
// G3 uses only the two fields that rubric/schema.json marks VERBATIM. A `quote` key that an executor adds on its own
// to another array is an extra key, not a contract quote; it is counted apart (quotes_all_keys) as a diagnostic.
const CONTRACT_QUOTES = [['directive_violations', 'evidence_quote'], ['tainan_corrections', 'quote']];

// --- tunables of the matchers (the self-test mutates these) ------------------------------------------
// ptrNeedsTerms: key-term hits that must come WITH a pointer hit (calibration round 1, 2026-10-23: pointer-only
// matches were wrong in 2 of 3 cases, agreement 0.831 < 0.90). 0 = the round-1 rule.
export const PARAMS = { overlapMin: 0.5, msgWindow: 2, keyTermsMin: 2, ptrNeedsTerms: 1, trivialLen: 8 };

/** Strict schema check. Returns a list of errors; empty = pass. */
export function schemaErrors(o, expectedId) {
  const e = [];
  if (!o || typeof o !== 'object' || Array.isArray(o)) return ['not a JSON object'];
  for (const k of REQ) if (!(k in o)) e.push(`missing key ${k}`);
  for (const k of Object.keys(o)) if (!REQ.includes(k)) e.push(`extra key ${k}`);
  for (const k of ARRAYS) if (k in o && !Array.isArray(o[k])) e.push(`${k} not an array`);
  if (expectedId && o.item_id !== expectedId) e.push('item_id differs');
  const m = o.session_meta;
  if (!m || typeof m !== 'object' || Array.isArray(m)) e.push('session_meta not an object');
  else {
    for (const k of ['domain', 'type', 'outcome', 'links']) if (!(k in m)) e.push(`session_meta.${k} missing`);
    if (!DOMAINS.includes(m.domain)) e.push(`enum domain ${JSON.stringify(m.domain)}`);
    if (!TYPES.includes(m.type)) e.push(`enum type ${JSON.stringify(m.type)}`);
    if (!OUTCOMES.includes(m.outcome)) e.push(`enum outcome ${JSON.stringify(m.outcome)}`);
    if (!Array.isArray(m.links)) e.push('session_meta.links not an array');
  }
  for (const [k, reqs] of Object.entries(ITEM_REQ)) {
    if (!Array.isArray(o[k])) continue;
    o[k].forEach((it, i) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) { e.push(`${k}[${i}] not an object`); return; }
      for (const r of reqs) if (!(r in it)) e.push(`${k}[${i}] missing ${r}`);
    });
  }
  for (const v of Array.isArray(o.directive_violations) ? o.directive_violations : []) if (v && !SEV.includes(v.severity)) e.push(`enum severity ${JSON.stringify(v.severity)}`);
  for (const d of Array.isArray(o.decision_candidates) ? o.decision_candidates : []) if (d && !DOMAINS.includes(d.domain)) e.push(`enum decision domain ${JSON.stringify(d.domain)}`);
  return e;
}

// --- text helpers ----------------------------------------------------------------------------------
const ws = (s) => String(s).replace(/\s+/g, ' ').trim();
/** Formatting artefacts that are not inventions: MarkdownV2 escapes, a trailing ellipsis the model added. */
const deArtefact = (s) => ws(s).replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, '$1').replace(/(\s*(\.\.\.|…))+$/u, '').trim();

export function parseMessages(text) {
  const re = /^\[(\d+) (\S+) ([A-Z]+)(?: ([^\]\n]*))?\]/gm;
  const out = []; let m;
  while ((m = re.exec(text))) out.push({ msg: Number(m[1]), ts: m[2], role: m[3], tag: (m[4] || '').trim(), start: m.index });
  for (let i = 0; i < out.length; i++) out[i].end = i + 1 < out.length ? out[i + 1].start : text.length;
  return out;
}

/** Longest common substring length (chars), O(n*m) with n,m <= ~600. */
function lcs(a, b) {
  if (!a || !b) return 0;
  let best = 0; let prev = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Uint16Array(b.length + 1);
    for (let j = 1; j <= b.length; j++) if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    prev = cur;
  }
  return best;
}
export function overlap(a, b) {
  const x = ws(a).toLowerCase().slice(0, 600), y = ws(b).toLowerCase().slice(0, 600);
  const den = Math.min(x.length, y.length);
  return den ? lcs(x, y) / den : 0;
}

function walkQuotes(node, path = '', out = []) {
  if (Array.isArray(node)) node.forEach((v, i) => walkQuotes(v, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) {
    const p = path ? `${path}.${k}` : k;
    if (QUOTE_FIELDS.includes(k)) out.push({ path: p, value: v }); else walkQuotes(v, p, out);
  }
  return out;
}

/** A non-literal quote that matches the source once secret-looking tokens are read as redaction markers. */
function isRedactionRebuild(quote, source) {
  if (!source.includes('<REDACTED:')) return false;
  const tokens = ws(quote).split(' ');
  const secretish = (t) => t.length >= 12 && /[0-9]/.test(t) && /[A-Za-z]/.test(t) || /:\/\/[^@\s]+:[^@\s]+@/.test(t);
  if (!tokens.some(secretish)) return false;
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(tokens.map((t) => (secretish(t) ? '\\S*<REDACTED:[^>]+>\\S*' : esc(t))).join('\\s+'));
  return re.test(source);
}

/** Map an evidence pointer `<item>@<ts>` (or a bare ts) to the nearest message number. */
function msgOfPointer(ptr, msgs) {
  if (typeof ptr !== 'string') return null;
  const ts = ptr.includes('@') ? ptr.slice(ptr.lastIndexOf('@') + 1) : ptr;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  let best = null, bd = Infinity;
  for (const m of msgs) { const d = Math.abs(Date.parse(m.ts) - t); if (d < bd) { bd = d; best = m.msg; } }
  return bd <= 5 * 60 * 1000 ? best : null; // more than 5 minutes off = no anchor
}
/** msg number -> ordinal position (message numbers are not dense across a split part). */
const ordinalOf = (msgs) => new Map(msgs.map((m, i) => [m.msg, i]));

/** Greedy one-to-one matching; `score(p, g)` > 0 means a match, higher is better. */
function match(preds, golds, score) {
  const pairs = [];
  preds.forEach((p, i) => golds.forEach((g, j) => { const s = score(p, g); if (s > 0) pairs.push([s, i, j]); }));
  pairs.sort((a, b) => b[0] - a[0]);
  const pu = new Set(), gu = new Set(), out = [];
  for (const [s, i, j] of pairs) if (!pu.has(i) && !gu.has(j)) { pu.add(i); gu.add(j); out.push({ pred: i, gold: j, score: s }); }
  return out;
}

const normLink = (l) => String(l).trim().replace(/[)\].,;:'"`>]+$/, '').replace(/\/+$/, '');

/**
 * Grade one record. `record` may be an object, a JSON string, or null (no output).
 * Returns { item_id, gates, metrics, counts, details }.
 */
export function gradeRecord(record, golden, sourceText, opts = {}) {
  const P = { ...PARAMS, ...(opts.params || {}) };
  const id = golden.item_id;
  const isSub = id.includes('__agent-');
  let o = record;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
  const res = { item_id: id, session_kind: isSub ? 'subagent' : 'main', grader_version: GRADER_VERSION, present: !!o };
  const schema = o ? schemaErrors(o, id) : ['no record'];
  res.gates = { schema: schema.length === 0, redaction: true };
  res.schema_errors = schema.slice(0, 20);
  res.schema_error_count = schema.length;
  if (!o) { res.metrics = null; return res; }

  const msgs = parseMessages(sourceText); const ord = ordinalOf(msgs);
  const hay = ws(sourceText); const hayDe = deArtefact(sourceText);

  // quote literalness
  const judge = (value) => {
    if (typeof value !== 'string' || !value.trim()) return 'empty';
    const n = ws(value);
    if (hay.includes(n)) return 'literal';
    if (hayDe.includes(deArtefact(n))) return 'artefact';
    return isRedactionRebuild(n, sourceText) ? 'redaction-rebuild' : 'not a substring';
  };
  let literal = 0, artefact = 0, trivial = 0, total = 0; const fabricated = [];
  for (const [arr, key] of CONTRACT_QUOTES) (Array.isArray(o[arr]) ? o[arr] : []).forEach((it, i) => {
    if (!it || typeof it !== 'object') return;
    total++; const v = judge(it[key]); const path = `${arr}[${i}].${key}`;
    if (typeof it[key] === 'string' && ws(it[key]).length < P.trivialLen) trivial++;
    if (v === 'literal') literal++; else if (v === 'artefact') { literal++; artefact++; }
    else { if (v === 'redaction-rebuild') res.gates.redaction = false; fabricated.push({ path, why: v }); }
  });
  const allQ = walkQuotes(o); let allLit = 0;
  for (const q of allQ) { const v = judge(q.value); if (v === 'literal' || v === 'artefact') allLit++; else if (v === 'redaction-rebuild') res.gates.redaction = false; }

  // corrections
  const pc = Array.isArray(o.tainan_corrections) ? o.tainan_corrections.filter((x) => x && typeof x === 'object') : [];
  const gc = golden.tainan_corrections || [];
  const cm = match(pc, gc, (p, g) => { const v = overlap(p.quote || '', g.anchor_quote); return v >= P.overlapMin ? v : 0; });
  const coreC = gc.filter((g) => g.tier === 'core').length;
  const coreCFound = cm.filter((x) => gc[x.gold].tier === 'core').length;

  // decisions
  const pd = Array.isArray(o.decision_candidates) ? o.decision_candidates.filter((x) => x && typeof x === 'object') : [];
  const gd = golden.decision_candidates || [];
  const dm = match(pd, gd, (p, g) => {
    let s = 0;
    const pm = msgOfPointer(p.evidence_pointer, msgs);
    const anchors = [g.msg, ...(g.also_msgs || [])].filter((x) => ord.has(x));
    const near = pm != null && ord.has(pm) && anchors.some((a) => Math.abs(ord.get(a) - ord.get(pm)) <= P.msgWindow);
    const text = ws(`${p.decision_text || ''}`).toLowerCase();
    const hits = (g.key_terms || []).filter((k) => text.includes(String(k).toLowerCase())).length;
    if (near && hits >= P.ptrNeedsTerms) s += 2;
    if (hits >= P.keyTermsMin) s += 1 + hits / 10;
    return s;
  });
  const coreD = gd.filter((g) => g.tier === 'core').length;
  const coreDFound = dm.filter((x) => gd[x.gold].tier === 'core').length;

  // session_meta
  const sm = o.session_meta || {}; const gm = golden.session_meta || {};
  const pl = new Set((Array.isArray(sm.links) ? sm.links : []).map(normLink));
  const gl = new Set((gm.links || []).map(normLink));
  const inter = [...pl].filter((x) => gl.has(x)).length;
  const linksF1 = pl.size + gl.size === 0 ? 1 : (2 * inter) / (pl.size + gl.size);

  res.counts = {
    quotes: total, quotes_literal: literal, quotes_artefact: artefact, quotes_trivial: trivial, quotes_all_keys: allQ.length, quotes_all_keys_literal: allLit,
    corrections_pred: pc.length, corrections_gold: gc.length, corrections_gold_core: coreC, corrections_matched: cm.length, corrections_core_found: coreCFound,
    decisions_pred: pd.length, decisions_gold: gd.length, decisions_gold_core: coreD, decisions_matched: dm.length, decisions_core_found: coreDFound,
    subagent_false_corrections: isSub ? pc.length - cm.length : 0,
  };
  res.metrics = {
    meta_domain: sm.domain === gm.domain, meta_type: sm.type === gm.type, meta_outcome: sm.outcome === gm.outcome, links_f1: linksF1,
  };
  res.details = { fabricated: fabricated.slice(0, 10), decision_matches: dm, correction_matches: cm };
  return res;
}

/** 95% Wilson lower bound. */
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, d = 1 + (z * z) / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
}
const ratio = (a, b) => (b ? a / b : null);
const r4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);

/** Pool per-item results of ONE executor into the Phase 4 metrics. */
export function aggregate(results, label) {
  const n = results.length;
  const present = results.filter((r) => r.present);
  const graded = present.filter((r) => r.metrics);
  const sum = (k) => graded.reduce((a, r) => a + (r.counts?.[k] || 0), 0);
  const large = results.filter((r) => r.stratum && r.stratum.endsWith('-large'));
  const valid = (r) => r.present && r.gates.schema;
  const q = sum('quotes'), ql = sum('quotes_literal');
  const out = {
    executor: label, items: n, records_present: present.length,
    G1_schema_validity: r4(ratio(results.filter(valid).length, n)),
    G2_completion: r4(ratio(results.filter(valid).length, n)),
    G2_completion_large: large.length ? r4(ratio(large.filter(valid).length, large.length)) : null,
    G3_quote_literalness: r4(ratio(ql, q)), G3_wilson_lb: r4(wilson(ql, q)), quotes_total: q, quotes_artefact: sum('quotes_artefact'),
    G3_redaction_rebuilds: graded.filter((r) => !r.gates.redaction).length,
    diag_quote_literalness_all_keys: r4(ratio(sum('quotes_all_keys_literal'), sum('quotes_all_keys'))), diag_quotes_all_keys: sum('quotes_all_keys'),
    M1_decision_recall: r4(ratio(sum('decisions_core_found'), sum('decisions_gold_core'))),
    M2_decision_precision: r4(ratio(sum('decisions_matched'), sum('decisions_pred'))),
    M3_correction_recall: r4(ratio(sum('corrections_core_found'), sum('corrections_gold_core'))),
    M4_correction_precision: r4(ratio(sum('corrections_matched'), sum('corrections_pred'))),
    M4_subagent_false_corrections: sum('subagent_false_corrections'),
    M5_domain: r4(ratio(graded.filter((r) => r.metrics.meta_domain).length, graded.length)),
    M5_type: r4(ratio(graded.filter((r) => r.metrics.meta_type).length, graded.length)),
    M5_outcome: r4(ratio(graded.filter((r) => r.metrics.meta_outcome).length, graded.length)),
    links_f1_mean: r4(graded.length ? graded.reduce((a, r) => a + r.metrics.links_f1, 0) / graded.length : null),
    counts: { decisions_pred: sum('decisions_pred'), decisions_gold_core: sum('decisions_gold_core'), corrections_pred: sum('corrections_pred'), corrections_gold_core: sum('corrections_gold_core') },
  };
  // Note: M1-M5 are computed on every PRESENT record, schema-valid or not, so a key-drifted record still
  // shows its judgement. G1/G2 carry the schema verdict separately.
  return out;
}

// --- CLI -------------------------------------------------------------------------------------------
function loadRecords(path) {
  const recs = new Map();
  const add = (o) => { if (o && o.item_id) recs.set(o.item_id, o); };
  if (statSync(path).isDirectory()) { for (const f of readdirSync(path).filter((f) => f.endsWith('.json'))) { try { add(JSON.parse(readFileSync(join(path, f), 'utf8'))); } catch { /* unparseable = absent */ } } }
  else for (const line of readFileSync(path, 'utf8').split('\n')) { if (!line.trim()) continue; try { add(JSON.parse(line)); } catch { /* skip */ } } // keep the LAST line per id
  return recs;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2); const opt = (k) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : null; };
  const corpus = opt('corpus') || CORPUS_DEFAULT;
  if (opt('record')) {
    const g = JSON.parse(readFileSync(opt('golden'), 'utf8'));
    const src = readFileSync(join(corpus, `${g.item_id}.txt`), 'utf8');
    console.log(JSON.stringify(gradeRecord(readFileSync(opt('record'), 'utf8'), g, src), null, 1));
  } else if (opt('batch')) {
    const recs = loadRecords(opt('batch')); const gdir = opt('golden-dir');
    const manifest = opt('manifest') ? JSON.parse(readFileSync(opt('manifest'), 'utf8')) : null;
    const strata = new Map((manifest?.items || []).map((i) => [i.item_id, i.stratum]));
    const only = opt('items') ? new Set(readFileSync(opt('items'), 'utf8').split(/\s+/).filter(Boolean)) : null;
    const results = [];
    for (const f of readdirSync(gdir).filter((f) => f.endsWith('.json')).sort()) {
      const g = JSON.parse(readFileSync(join(gdir, f), 'utf8'));
      if (only && !only.has(g.item_id)) continue;
      const src = readFileSync(join(corpus, `${g.item_id}.txt`), 'utf8');
      const r = gradeRecord(recs.get(g.item_id) ?? null, g, src); r.stratum = strata.get(g.item_id) || null; results.push(r);
    }
    const out = { label: opt('label'), grader_version: GRADER_VERSION, params: PARAMS, aggregate: aggregate(results, opt('label')), items: results };
    if (opt('out')) writeFileSync(opt('out'), JSON.stringify(out, null, 1) + '\n');
    console.log(JSON.stringify(out.aggregate, null, 1));
  } else { console.error('usage: see header'); process.exit(2); }
}

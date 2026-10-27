// Deterministic grader of ONE layer-2 judgment (out/judgment.json) of the task
// itera/dfl-session-decision-trajectory-extraction ("Session Decision Trajectory Extraction").
// Plan 20261025-session-trajectory-extraction v3, section 11.3 (ADR-13: layer 1 is the input, only layer 2 is graded).
//
// Library:  import { gradeJudgment, parseItem, schemaErrors } from './grade.mjs'
// No model, no network, no dependency. The same inputs give the same output.
//
// Inputs of one item: the judgment (object, JSON text or null), item.txt (the condensed view), layer1.json (the
// layer-1 record of the unit: risk_signals with floors, unit.outcome_signals), shapes.json (the shapes to label)
// and the reference judgment of the item.
//
// GATES (a failed gate sets the score to 0):
//   schema              strict rubric/schema.json (required keys, no extra key, closed enums, type/subtype pair);
//                       item_id = the ITEM id of item.txt
//   intents_closed      intent_labels has exactly the shapes of shapes.json as keys (values: the closed list)
//   risk_floor          every decision whose pointer window holds a layer-1 risk signal has risk >= its floor
//   speaker             every pointer names an event of item.txt; decided_by fits the role of the pointed event;
//                       every correction quote is a literal substring of the HUMAN turn it points at;
//                       a subagent run has 0 corrections
//   outcome_consistent  "landed" needs a merge, publish or deploy signal in layer1.json (unit, over the tree; a
//                       publish = a plan publish or an artifact link with a write action);
//                       a unit with a merge signal is never "talk_only"
// METRICS (vs the reference; null = no evidence, left out of the score):
//   class_match         type and subtype exact (value = mean of the two)
//   risk_match          on the decisions matched to the reference: risk within +-1 AND decided_by exact
//   intent_agreement    share of shapes.json labels equal to the reference label; "other" is a miss
//   corrections         recall >= 0.80 and precision >= 0.85 (value = F1); match = >= 50% overlap with the quote
// DIAGNOSTIC (printed, never scored): decision recall and precision vs the reference (the bake-off matcher failed
// calibration, its ADR-4).
// SCORE = 0 when a gate fails; else 100 x the mean of the metric values that have evidence (the bake-off score v2 rule).
import { readFileSync } from 'node:fs';

export const GRADER_VERSION = '1.2.0';
export const SCHEMA = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf-8'));
export const INTENTS = SCHEMA['x-dfl'].intents;

// Tunables of the windows and matchers (the self-test mutates these; every mutant must be killed).
//   floorWindow  spans after a pointed message (or after a pointed span, itself included) that the floor gate reads
//   ptrWindow    events between a predicted and a reference decision pointer that still match
//   overlapMin   longest-common-substring share for a correction match (the bake-off matcher)
//   riskTol      risk distance that risk_match accepts
export const PARAMS = { floorWindow: 5, ptrWindow: 2, overlapMin: 0.5, riskTol: 1 };
export const THRESHOLDS = { risk_match: 0.8, intent_agreement: 0.8, corrections_recall: 0.8, corrections_precision: 0.85 };
// layer-1 outcome signal names (T2 extractor, outcome_legend)
export const LANDED_SIGNALS = ['merge_token', 'merge_call', 'plan_publish', 'deploy_or_health_check'];
export const MERGE_SIGNALS = ['merge_token', 'merge_call'];
// a publish is also an artifact link (an uploaded page or file) whose layer-1 action is a write ("write (uploaded)")
const isPublishLink = (l) => l && l.kind === 'artifact' && [].concat(l.action_tree || [], l.action_run || [], l.action || []).some((a) => /^write/.test(String(a)));
const MSG_ROLES = ['BRIEF', 'HUMAN', 'ASSISTANT', 'PEER', 'NOTICE'];
// A BRIEF that relays a Tainan message: a Telegram message id, "msg <id>", his answer letter to a question, or a
// sentence that names him with a verb of deciding ("Tainan approved ...", "on Tainan's direct instruction").
export const TAINAN_RELAY = [
  /\b(?:TG|Telegram)\b[^\n]{0,40}?\b\d{3,6}\b/i,
  /\bmsg\.?\s*#?\d{3,6}\b/i,
  /\bQ\d*\s*(?:\([0-9a-f]{6,8}\)\s*)?=\s*[A-E]\b/,
  /\banswer(?:ed)?\s+(?:is\s+)?[A-E]\b/,
  /\bTainan(?:'s)?\b[^\n]{0,40}?\b(?:approv\w*|ask\w*|said|says|decid\w*|want\w*|instruct\w*|answer\w*|chose|choice|request\w*|order\w*|message|voice|TG|Telegram)\b/i,
  /\b(?:approv\w*|answer\w*|instruct\w*|decision|request\w*)\b[^\n]{0,20}?\bTainan\b/i,
];

// ------------------------------------------------------------------------------------------------ schema
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const typeOk = (t, v) => (t === 'object' ? isObj(v) : t === 'array' ? Array.isArray(v) : t === 'integer' ? Number.isInteger(v)
  : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'null' ? v === null : typeof v === t);

/** The draft-07 subset that rubric/schema.json uses. Returns a list of errors; empty = valid. */
export function validate(schema, v, path = '$', errs = []) {
  if (schema.anyOf && !schema.anyOf.some((s) => validate(s, v, path, []).length === 0)) errs.push(`${path}: no anyOf branch matches`);
  if ('const' in schema && v !== schema.const) errs.push(`${path}: not ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${path}: enum ${JSON.stringify(v)}`);
  if (schema.type && ![].concat(schema.type).some((t) => typeOk(t, v))) { errs.push(`${path}: type ${Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v}`); return errs; }
  if (typeof v === 'string') {
    const n = [...v].length;
    if (schema.minLength != null && n < schema.minLength) errs.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && n > schema.maxLength) errs.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(v)) errs.push(`${path}: pattern ${schema.pattern}`);
  }
  if (typeof v === 'number') {
    if (schema.minimum != null && v < schema.minimum) errs.push(`${path}: < ${schema.minimum}`);
    if (schema.maximum != null && v > schema.maximum) errs.push(`${path}: > ${schema.maximum}`);
  }
  if (Array.isArray(v)) {
    if (schema.maxItems != null && v.length > schema.maxItems) errs.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.minItems != null && v.length < schema.minItems) errs.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errs.push(`${path}: duplicate items`);
    if (schema.items) v.forEach((x, i) => validate(schema.items, x, `${path}[${i}]`, errs));
  }
  if (isObj(v)) {
    const keys = Object.keys(v);
    for (const k of schema.required || []) if (!(k in v)) errs.push(`${path}: missing ${k}`);
    if (schema.maxProperties != null && keys.length > schema.maxProperties) errs.push(`${path}: more than ${schema.maxProperties} keys`);
    for (const k of keys) {
      if (schema.propertyNames) validate(schema.propertyNames, k, `${path}{${k}}`, errs);
      if (schema.properties && k in schema.properties) validate(schema.properties[k], v[k], `${path}.${k}`, errs);
      else if (schema.additionalProperties === false) errs.push(`${path}: extra key ${k}`);
      else if (isObj(schema.additionalProperties)) validate(schema.additionalProperties, v[k], `${path}.${k}`, errs);
    }
  }
  return errs;
}

/** Strict schema check of one judgment. */
export function schemaErrors(o, expectedId) {
  const e = validate(SCHEMA, o);
  if (expectedId && isObj(o) && o.item_id !== expectedId) e.push('item_id differs from the ITEM id of item.txt');
  return e;
}

// ------------------------------------------------------------------------------------------------ item.txt
const M_HDR = /^\[m(\d+) (\S+) ([A-Z]+)(?: ([^\]\n]*))?\]$/;
const S_HDR = /^\[s(\d+)(?:-s(\d+))? (\S+) (SPANS?)\](.*)$/;

/**
 * Parse the condensed view (tools/condensed-view.mjs of the layer-2 contract). Header: ITEM, KIND, WINDOW, LAYER1
 * lines, then `--- EVENTS ---`. An event header is `[m<N> hh:mm:ss ROLE tag]` (text on the next lines) or
 * `[s<N> hh:mm:ss SPAN] <digest>` / `[s<A>-s<B> hh:mm:ss SPANS] x<n> <digest>`. Ids only grow, so a header-like line
 * inside a message text is read as text.
 */
export function parseItem(text) {
  const src = String(text ?? '');
  const lines = src.split('\n');
  const item_id = (/^ITEM (\S+)/m.exec(src) || [])[1] ?? null;
  const kind = (/^KIND (\S+)/m.exec(src) || [])[1] ?? null;
  const start = lines.indexOf('--- EVENTS ---');
  const events = [];
  let lastM = -1, lastS = -1, cur = null;
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    const l = lines[i];
    const m = M_HDR.exec(l);
    if (m && Number(m[1]) > lastM && MSG_ROLES.includes(m[3])) {
      lastM = Number(m[1]);
      cur = { id: `m${m[1]}`, kind: 'msg', role: m[3], tag: (m[4] || '').trim(), lines: [], ord: events.length };
      events.push(cur); continue;
    }
    const s = S_HDR.exec(l);
    if (s && Number(s[1]) > lastS && (s[2] === undefined || Number(s[2]) >= Number(s[1]))) {
      const a = Number(s[1]), b = s[2] === undefined ? a : Number(s[2]);
      lastS = b;
      cur = null;
      events.push({ id: `s${a}`, kind: 'span', role: 'SPAN', seqs: Array.from({ length: b - a + 1 }, (_, k) => a + k), digest: s[5].trim(), ord: events.length });
      continue;
    }
    if (/^\[NOTE /.test(l)) { cur = null; continue; }
    if (cur) cur.lines.push(l);
  }
  const byId = new Map();
  for (const e of events) {
    if (e.kind === 'msg') { e.text = e.lines.join('\n').trim(); delete e.lines; byId.set(e.id, e); }
    else for (const q of e.seqs) byId.set(`s${q}`, e);
  }
  return { item_id, kind, events, byId };
}

/** Span seqs that a pointer's floor window covers: a message -> the spans after it up to the next message;
 *  a span -> itself and the spans after it up to the next message. At most `n` spans. */
export function floorWindow(P, ptr, n = PARAMS.floorWindow) {
  const ev = P.byId.get(ptr);
  if (!ev || n <= 0) return [];
  const seqs = [];
  if (ev.kind === 'span') { const k = Number(ptr.slice(1)); seqs.push(...ev.seqs.filter((q) => q >= k)); }
  for (let i = ev.ord + 1; i < P.events.length && P.events[i].kind === 'span'; i++) seqs.push(...P.events[i].seqs);
  return seqs.slice(0, n);
}

// ------------------------------------------------------------------------------------------------ matchers
const ws = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Formatting artefacts that are not inventions: MarkdownV2 escapes, a trailing ellipsis the model added. */
const deArtefact = (s) => ws(s).replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1').replace(/(\s*(\.\.\.|…))+$/u, '').trim();
function lcs(a, b) {
  if (!a || !b) return 0;
  let best = 0, prev = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Uint16Array(b.length + 1);
    for (let j = 1; j <= b.length; j++) if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    prev = cur;
  }
  return best;
}
/** Longest-common-substring share of the shorter string (the bake-off correction matcher). */
export function overlap(a, b) {
  const x = ws(a).toLowerCase().slice(0, 600), y = ws(b).toLowerCase().slice(0, 600);
  const den = Math.min(x.length, y.length);
  return den ? lcs(x, y) / den : 0;
}
const tokens = (s) => new Set(ws(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2));
function jaccard(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let n = 0; for (const t of x) if (y.has(t)) n++;
  return n / (x.size + y.size - n);
}
/** Greedy one-to-one matching; `score(p, g)` > 0 means a match, higher is better. */
function match(preds, golds, score) {
  const pairs = [];
  preds.forEach((p, i) => golds.forEach((g, j) => { const s = score(p, g); if (s > 0) pairs.push([s, i, j]); }));
  pairs.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
  const pu = new Set(), gu = new Set(), out = [];
  for (const [s, i, j] of pairs) if (!pu.has(i) && !gu.has(j)) { pu.add(i); gu.add(j); out.push({ pred: i, ref: j, score: s }); }
  return out;
}

// ------------------------------------------------------------------------------------------------ grade
const arr = (x) => (Array.isArray(x) ? x.filter(isObj) : []);
const r4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);
const ratio = (a, b) => (b ? a / b : null);

/**
 * Grade one judgment. `judgment` may be an object, a JSON string or null (no output).
 * Returns { item_id, grader_version, present, gates, gate_errors, metrics, diagnostics, score, counts, details }.
 */
export function gradeJudgment({ judgment, itemText, layer1, shapes, reference, params = {} }) {
  const P = { ...PARAMS, ...params };
  const item = parseItem(itemText);
  const id = reference?.item_id ?? item.item_id;
  let o = judgment;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
  const res = { item_id: id, grader_version: GRADER_VERSION, kind: item.kind, present: o !== null && o !== undefined };
  const gateErr = { schema: [], intents_closed: [], risk_floor: [], speaker: [], outcome_consistent: [] };
  gateErr.schema = res.present ? schemaErrors(o, item.item_id) : ['no out/judgment.json, or it is not JSON'];
  const valid = gateErr.schema.length === 0;
  const shapeList = (shapes?.shapes || []).map((s) => s.shape);
  const l1Risk = Array.isArray(layer1?.risk_signals) ? layer1.risk_signals : [];
  const unitSig = layer1?.unit?.outcome_signals || layer1?.subtree?.outcome_signals || layer1?.outcome_signals || {};
  const sig = (k) => { const v = unitSig[k]; return Array.isArray(v) ? v.length : Number(v) || 0; };

  if (valid) {
    // intents_closed
    const keys = Object.keys(o.intent_labels);
    const want = new Set(shapeList);
    for (const k of keys) if (!want.has(k)) gateErr.intents_closed.push(`label for a shape not in shapes.json: ${JSON.stringify(k).slice(0, 80)}`);
    const missing = shapeList.filter((s) => !(s in o.intent_labels));
    if (missing.length) gateErr.intents_closed.push(`${missing.length} shape(s) of shapes.json without a label`);
    for (const k of keys) if (!INTENTS.includes(o.intent_labels[k])) gateErr.intents_closed.push(`intent outside the list: ${JSON.stringify(o.intent_labels[k])}`);
    // risk_floor
    o.decision_candidates.forEach((d, i) => {
      const win = new Set(floorWindow(item, d.evidence_pointer, P.floorWindow));
      const floor = Math.max(0, ...l1Risk.filter((r) => win.has(r.span_seq)).map((r) => Number(r.floor) || 0));
      if (floor && d.risk < floor) gateErr.risk_floor.push(`decision_candidates[${i}] risk ${d.risk} < floor ${floor} (${d.evidence_pointer})`);
    });
    // speaker
    const isSub = item.kind === 'subagent';
    const brief = item.events.find((e) => e.role === 'BRIEF');
    const relay = !!brief && TAINAN_RELAY.some((re) => re.test(brief.text));
    const hasHuman = item.events.some((e) => e.role === 'HUMAN');
    o.decision_candidates.forEach((d, i) => {
      const ev = item.byId.get(d.evidence_pointer);
      const at = `decision_candidates[${i}] (${d.evidence_pointer})`;
      if (!ev) { gateErr.speaker.push(`${at}: the pointer names no event of item.txt`); return; }
      const role = ev.role;
      if (d.decided_by === 'tainan') {
        if (isSub ? !(role === 'BRIEF' && relay) : role !== 'HUMAN') gateErr.speaker.push(`${at}: decided_by tainan on a ${role} event${isSub ? (relay ? '' : ' (the BRIEF relays no Tainan message)') : ''}`);
      } else if (d.decided_by === 'agent') {
        if (role !== 'ASSISTANT' && role !== 'SPAN') gateErr.speaker.push(`${at}: decided_by agent on a ${role} event`);
      } else if (d.decided_by === 'tainan+agent') {
        if (isSub ? !relay : !hasHuman) gateErr.speaker.push(`${at}: decided_by tainan+agent with no Tainan voice in the unit`);
        else if (!(isSub ? ['BRIEF', 'ASSISTANT', 'SPAN'] : ['HUMAN', 'ASSISTANT', 'SPAN']).includes(role)) gateErr.speaker.push(`${at}: decided_by tainan+agent on a ${role} event`);
      }
    });
    if (isSub && o.tainan_corrections.length) gateErr.speaker.push(`a subagent run has ${o.tainan_corrections.length} correction(s); it must have 0`);
    if (!isSub) o.tainan_corrections.forEach((c, i) => {
      const ev = item.byId.get(c.evidence_pointer);
      const at = `tainan_corrections[${i}] (${c.evidence_pointer})`;
      if (!ev || ev.role !== 'HUMAN') { gateErr.speaker.push(`${at}: the pointer is not a HUMAN turn`); return; }
      const hay = ws(ev.text), q = ws(c.quote);
      if (!hay.includes(q) && !deArtefact(hay).includes(deArtefact(q))) gateErr.speaker.push(`${at}: the quote is not a literal substring of that HUMAN turn`);
    });
    // outcome_consistent
    const out = o.classification.outcome;
    const published = (Array.isArray(layer1?.links) ? layer1.links : []).some(isPublishLink);
    if (out === 'landed' && !LANDED_SIGNALS.some((k) => sig(k) > 0) && !published) gateErr.outcome_consistent.push(`"landed" with no ${LANDED_SIGNALS.join(' / ')} signal and no uploaded artifact link in layer1.json`);
    if (out === 'talk_only' && MERGE_SIGNALS.some((k) => sig(k) > 0)) gateErr.outcome_consistent.push('"talk_only" on a unit with a merge signal in layer1.json');
  } else {
    for (const k of Object.keys(gateErr)) if (k !== 'schema') gateErr[k] = ['not evaluated: the schema gate failed'];
  }
  res.gates = Object.fromEntries(Object.entries(gateErr).map(([k, v]) => [k, v.length === 0]));
  res.gate_errors = Object.fromEntries(Object.entries(gateErr).map(([k, v]) => [k, v.slice(0, 10)]));
  if (!valid) { res.metrics = null; res.diagnostics = null; res.score = 0; return res; }

  // ---- metrics vs the reference
  const ref = reference || {};
  const rc = ref.classification || {};
  const typeEq = o.classification.type === rc.type, subEq = o.classification.subtype === rc.subtype;
  // decisions: match by pointer distance (events), tie-break by text overlap
  const pd = o.decision_candidates, rd = arr(ref.decision_candidates);
  const dm = match(pd, rd, (p, r) => {
    const a = item.byId.get(p.evidence_pointer), b = item.byId.get(r.evidence_pointer);
    if (!a || !b) return 0;
    const dist = Math.abs(a.ord - b.ord);
    return dist <= P.ptrWindow ? P.ptrWindow + 1 - dist + jaccard(p.decision_text, r.decision_text) : 0;
  });
  const riskOk = dm.filter((x) => Math.abs(pd[x.pred].risk - rd[x.ref].risk) <= P.riskTol && pd[x.pred].decided_by === rd[x.ref].decided_by).length;
  // intents
  const refLabels = isObj(ref.intent_labels) ? ref.intent_labels : {};
  const agree = shapeList.filter((s) => o.intent_labels[s] !== 'other' && o.intent_labels[s] === refLabels[s]).length;
  // corrections
  const pc = o.tainan_corrections, rcs = arr(ref.tainan_corrections);
  const cm = match(pc, rcs, (p, r) => { const v = overlap(p.quote, r.quote); return v >= P.overlapMin ? v : 0; });
  const cRecall = ratio(cm.length, rcs.length), cPrec = ratio(cm.length, pc.length);
  res.counts = {
    decisions_pred: pd.length, decisions_ref: rd.length, decisions_matched: dm.length, decisions_risk_ok: riskOk,
    shapes: shapeList.length, shapes_agree: agree, corrections_pred: pc.length, corrections_ref: rcs.length, corrections_matched: cm.length,
  };
  res.metrics = {
    class_match: (Number(typeEq) + Number(subEq)) / 2,
    class_type: typeEq, class_subtype: subEq,
    risk_match: r4(ratio(riskOk, dm.length)),
    intent_agreement: r4(ratio(agree, shapeList.length)),
    corrections: pc.length + rcs.length ? r4((2 * cm.length) / (pc.length + rcs.length)) : null,
    corrections_recall: r4(cRecall), corrections_precision: r4(cPrec),
  };
  res.diagnostics = { decisions_recall: r4(ratio(dm.length, rd.length)), decisions_precision: r4(ratio(dm.length, pd.length)) };
  res.details = { decision_matches: dm, correction_matches: cm };
  const ok = Object.values(res.gates).every(Boolean);
  const parts = ['class_match', 'risk_match', 'intent_agreement', 'corrections'].map((k) => res.metrics[k]).filter((v) => v !== null);
  res.score = ok ? Math.round(1000 * parts.reduce((a, b) => a + b, 0) / parts.length) / 10 : 0;
  return res;
}

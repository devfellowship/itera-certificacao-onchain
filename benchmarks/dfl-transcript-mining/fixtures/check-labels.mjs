// Check golden label files (task T2, plan 20261023-tma-transcript-mining-executor-bakeoff).
//
//   node check-labels.mjs <labels-dir> [--corpus <dir>] [--item <id>]
//
// For every <item_id>.json in <labels-dir> it asserts:
//   - the shape (required keys, closed enums, tier in core|acceptable, 2..6 key_terms on a decision)
//   - every anchor_quote is a LITERAL substring of corpus/<item_id>.txt
//   - every `msg` exists as a message header `[msg ts ROLE ...]`, and `ts` equals that header's ts
//   - the anchor_quote lies inside message `msg` (between its header and the next header)
//   - a correction anchors in a USER message that is not SUB/meta
// Exit 0 = all files valid, 1 = at least one error. Prints one JSON line per file.
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const argv = process.argv.slice(2);
const dir = argv[0];
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const CORPUS = opt('corpus', 'corpus');
const only = opt('item', null);

export const DOMAINS = ['financing', 'itera', 'amb-hq', 'infra', 'book', 'dfl-app', 'harness', 'other'];
export const TYPES = ['bugfix', 'feature', 'ops', 'research', 'talk'];
export const OUTCOMES = ['pr_merged', 'abandoned', 'blocked', 'talk_only'];
const TIERS = ['core', 'acceptable'];

/** Parse message headers: returns [{msg, ts, role, tag, start, end}] with byte-free string offsets. */
export function parseMessages(text) {
  const re = /^\[(\d+) (\S+) ([A-Z]+)(?: ([^\]\n]*))?\]/gm;
  const out = []; let m;
  while ((m = re.exec(text))) out.push({ msg: Number(m[1]), ts: m[2], role: m[3], tag: (m[4] || '').trim(), start: m.index });
  for (let i = 0; i < out.length; i++) out[i].end = i + 1 < out.length ? out[i + 1].start : text.length;
  return out;
}

function checkFile(path) {
  const errs = [];
  let L; try { L = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return { file: basename(path), ok: false, errors: [`unparseable: ${e.message}`] }; }
  const id = L.item_id;
  if (basename(path) !== `${id}.json`) errs.push('file name != item_id');
  let text; try { text = readFileSync(join(CORPUS, `${id}.txt`), 'utf8'); } catch { return { file: basename(path), ok: false, errors: ['no corpus file'] }; }
  const msgs = parseMessages(text); const byMsg = new Map(msgs.map((m) => [m.msg, m]));
  const OBSERVER = text.slice(0, 800).includes('observer-sessions');
  const sm = L.session_meta || {};
  if (!DOMAINS.includes(sm.domain)) errs.push(`session_meta.domain ${sm.domain}`);
  if (!TYPES.includes(sm.type)) errs.push(`session_meta.type ${sm.type}`);
  if (!OUTCOMES.includes(sm.outcome)) errs.push(`session_meta.outcome ${sm.outcome}`);
  if (!Array.isArray(sm.links)) errs.push('session_meta.links not an array');
  else for (const l of sm.links) if (!text.includes(l)) errs.push(`link not in transcript: ${l.slice(0, 80)}`);
  const anchor = (kind, i, x) => {
    if (typeof x.anchor_quote !== 'string' || x.anchor_quote.trim().length < 8) { errs.push(`${kind}[${i}] anchor_quote too short`); return null; }
    if (!TIERS.includes(x.tier)) errs.push(`${kind}[${i}] tier ${x.tier}`);
    const m = byMsg.get(x.msg);
    if (!m) { errs.push(`${kind}[${i}] msg ${x.msg} not found`); return null; }
    if (x.ts !== m.ts) errs.push(`${kind}[${i}] ts ${x.ts} != header ${m.ts}`);
    const seg = text.slice(m.start, m.end);
    if (!text.includes(x.anchor_quote)) errs.push(`${kind}[${i}] anchor_quote is not a literal substring`);
    else if (!seg.includes(x.anchor_quote)) errs.push(`${kind}[${i}] anchor_quote is not inside msg ${x.msg}`);
    return m;
  };
  (L.tainan_corrections || []).forEach((c, i) => {
    const m = anchor('tainan_corrections', i, c);
    // Rule v2 (2026-10-23): Tainan's Telegram messages carry the tag `USER meta` in this corpus, so `meta`
    // is allowed. Never SUB, never a task-notification, never a memory-observer session.
    if (m && (m.role !== 'USER' || /SUB/.test(m.tag))) errs.push(`tainan_corrections[${i}] msg ${c.msg} is ${m.role} ${m.tag}, not a Tainan USER message`);
    if (m && text.slice(m.start, m.end).includes('<task-notification')) errs.push(`tainan_corrections[${i}] msg ${c.msg} is a task-notification`);
    if (m && OBSERVER) errs.push(`tainan_corrections[${i}] item is a memory-observer session: no corrections`);
    if (!c.topic) errs.push(`tainan_corrections[${i}] no topic`);
  });
  (L.decision_candidates || []).forEach((d, i) => {
    anchor('decision_candidates', i, d);
    if (!d.decision_text) errs.push(`decision_candidates[${i}] no decision_text`);
    if (!DOMAINS.includes(d.domain)) errs.push(`decision_candidates[${i}] domain ${d.domain}`);
    if (!d.decided_by) errs.push(`decision_candidates[${i}] no decided_by`);
    if (!Array.isArray(d.key_terms) || d.key_terms.length < 2 || d.key_terms.length > 6) errs.push(`decision_candidates[${i}] needs 2..6 key_terms`);
  });
  if (!Array.isArray(L.tainan_corrections)) errs.push('tainan_corrections not an array');
  if (!Array.isArray(L.decision_candidates)) errs.push('decision_candidates not an array');
  return { file: basename(path), ok: errs.length === 0, corrections: (L.tainan_corrections || []).length, decisions: (L.decision_candidates || []).length, errors: errs };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && (!only || f === `${only}.json`));
  let bad = 0;
  for (const f of files) { const r = checkFile(join(dir, f)); if (!r.ok) bad++; console.log(JSON.stringify(r)); }
  console.log(JSON.stringify({ files: files.length, bad }));
  process.exit(bad ? 1 : 0);
}

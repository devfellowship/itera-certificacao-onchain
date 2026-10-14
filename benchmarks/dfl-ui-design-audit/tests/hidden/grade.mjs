// Grader of the ui-design-audit task (pick C of the benchmark-tasks plan). Plain ESM,
// no dependency: the vitest suite (grade.test.ts), fixtures/check.mjs and the CLI share it.
//
//   node tests/hidden/grade.mjs out/findings.json      prints the checks and the match table
//
// Matching. A finding matches an injected defect when the SCREEN is the same, the CATEGORY is one
// the defect accepts, the VIEWPORT fits (a defect scoped to 390 px needs "390" or "both"), and
// either the SELECTOR names the defect element (its last data-testid or #id token is one of the
// defect's match_testids) or the finding's bbox overlaps the element box with IoU >= 0.3.
// A finding that matches no defect is a false positive. A finding on a decoy element is a false
// positive AND a decoy report. Several findings on one defect (for example one per viewport) are
// not false positives.
import { readFileSync } from 'node:fs';

export const RECALL_MIN = 0.75;
export const PRECISION_MIN = 0.7;
export const VALUES_MIN = 0.75;
export const IOU_MIN = 0.3;
const SCREENS = ['list', 'detail', 'form'];
const VIEWPORTS = ['1280', '390', 'both'];
const CATEGORIES = ['spacing', 'color', 'typography', 'copy', 'missing-element', 'order', 'size'];

/** The element a selector names: its LAST data-testid or #id token. */
export function selectorTarget(selector) {
  const tokens = [];
  const re = /data-testid\s*[~|^$*]?=\s*["']?([A-Za-z0-9_-]+)|#([A-Za-z0-9_-]+)/g;
  let m;
  while ((m = re.exec(String(selector ?? '')))) tokens.push(m[1] ?? m[2]);
  return tokens.length ? tokens[tokens.length - 1] : null;
}

export function iou(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return 0;
  const [ax, ay, aw, ah] = a.map(Number);
  const [bx, by, bw, bh] = b;
  const ix = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
  const iy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
  const inter = ix * iy;
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

const hex = (s) => {
  const t = String(s ?? '').trim().toLowerCase();
  let m = /^#([0-9a-f]{6})\b/.exec(t) ?? /#([0-9a-f]{6})\b/.exec(t);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /#([0-9a-f]{3})\b/.exec(t);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(t);
  if (m) return [m[1], m[2], m[3]].map(Number);
  return null;
};
const px = (s) => {
  const m = /(-?\d+(?:\.\d+)?)\s*(px)?/.exec(String(s ?? ''));
  return m ? Number(m[1]) : null;
};
const weight = (s) => {
  const t = String(s ?? '').toLowerCase();
  if (/\bbold\b/.test(t)) return 700;
  if (/\bnormal\b|\bregular\b/.test(t)) return 400;
  if (/\bsemi-?bold\b/.test(t)) return 600;
  const m = /\b([1-9]00)\b/.exec(t);
  return m ? Number(m[1]) : null;
};
const words = (s) => String(s ?? '').replace(/^["'“”\s]+|["'“”\s]+$/g, '').replace(/\s+/g, ' ');

/** Does one stated value equal the key value, within the tolerance of its kind? */
export function sameValue(kind, stated, want) {
  if (kind === 'color') {
    const a = hex(stated);
    const b = hex(want);
    return !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= 2);
  }
  if (kind === 'px') {
    const a = px(stated);
    return a !== null && Math.abs(a - px(want)) <= 1;
  }
  if (kind === 'weight') return weight(stated) !== null && weight(stated) === weight(want);
  if (kind === 'text') return words(stated) === words(want);
  return true;
}

function valid(f) {
  return (
    f && typeof f === 'object' && SCREENS.includes(f.screen) && VIEWPORTS.includes(String(f.viewport)) && typeof f.selector === 'string' &&
    CATEGORIES.includes(f.category) && ['string', 'number'].includes(typeof f.expected) && ['string', 'number'].includes(typeof f.actual)
  );
}

/** Match findings to defects and decoys. Pure. */
export function match(findings, key, bboxes = null) {
  const hits = (f, target) => {
    const t = selectorTarget(f.selector);
    if (t && target.match_testids.includes(t)) return true;
    if (!Array.isArray(f.bbox) || !bboxes) return false;
    const vps = String(f.viewport) === 'both' ? ['1280', '390'] : [String(f.viewport)];
    for (const v of vps) for (const build of ['app', 'design']) for (const id of target.match_testids) {
      const b = bboxes?.[build]?.[v]?.[f.screen]?.[id];
      if (b && iou(f.bbox, b) >= IOU_MIN) return true;
    }
    return false;
  };
  const rows = findings.map((f, i) => {
    const decoy = key.decoys.find((d) => (d.screen === 'all' || d.screen === f.screen) && hits(f, d));
    const defects = decoy
      ? []
      : key.defects.filter(
          (d) => d.screen === f.screen && d.accept_categories.includes(f.category) && (d.viewport === 'both' || ['390', 'both'].includes(String(f.viewport))) && hits(f, d),
        );
    return { i, decoy: decoy?.id ?? null, defects: defects.map((d) => d.id) };
  });
  const found = new Set(rows.flatMap((r) => r.defects));
  const values = {};
  for (const d of key.defects) {
    if (!d.value_kind || !found.has(d.id)) continue;
    const pairs = d.values ?? [{ expected: d.expected, actual: d.actual }];
    values[d.id] = rows
      .filter((r) => r.defects.includes(d.id))
      .some((r) => pairs.some((p) => sameValue(d.value_kind, findings[r.i].expected, p.expected) && sameValue(d.value_kind, findings[r.i].actual, p.actual)));
  }
  const tp = rows.filter((r) => r.defects.length > 0).length;
  return {
    rows,
    found: [...found].sort(),
    missed: key.defects.filter((d) => !found.has(d.id)).map((d) => d.id),
    recall: key.defects.length ? found.size / key.defects.length : 0,
    precision: findings.length ? tp / findings.length : 0,
    values,
    decoys: [...new Set(rows.map((r) => r.decoy).filter(Boolean))],
  };
}

/** Every check, in order. `findingsText` = the content of out/findings.json, or null. */
export function grade({ findingsText, key, bboxes = null }) {
  const checks = [];
  let doc = null;
  try {
    doc = JSON.parse(findingsText ?? '');
  } catch {
    doc = null;
  }
  const list = Array.isArray(doc?.findings) ? doc.findings : null;
  const bad = list ? list.map((f, i) => (valid(f) ? null : i)).filter((i) => i !== null) : [];
  checks.push({ id: 'schema', ok: !!list && bad.length === 0 && list.length <= 60, why: !list ? 'out/findings.json is missing or has no findings array' : bad.length ? `invalid findings at index ${bad.slice(0, 5).join(', ')}` : `${list.length} findings (max 60)` });
  const m = match(list && bad.length === 0 ? list : [], key, bboxes);
  checks.push({ id: 'recall', ok: m.recall >= RECALL_MIN, why: `recall ${m.recall.toFixed(2)} (min ${RECALL_MIN}); missed ${m.missed.join(', ') || 'none'}` });
  checks.push({ id: 'precision', ok: m.precision >= PRECISION_MIN, why: `precision ${m.precision.toFixed(2)} (min ${PRECISION_MIN})` });
  const vals = Object.values(m.values);
  const vRate = vals.length ? vals.filter(Boolean).length / vals.length : 0;
  checks.push({ id: 'values', ok: vRate >= VALUES_MIN, why: `${vals.filter(Boolean).length}/${vals.length} found defects state the right expected and actual values (min ${VALUES_MIN})` });
  for (const d of key.decoys) checks.push({ id: `no-${d.id}`, ok: !m.decoys.includes(d.id), why: `${d.id} (${d.testid}) must not be reported: ${d.why}` });
  return { checks, match: m };
}

if (process.argv[1] === import.meta.filename) {
  const dir = new URL('.', import.meta.url);
  const key = JSON.parse(readFileSync(new URL('key.json', dir), 'utf-8'));
  let bboxes = null;
  try {
    bboxes = JSON.parse(readFileSync(new URL('bboxes.json', dir), 'utf-8'));
  } catch {
    bboxes = null;
  }
  let text = null;
  try {
    text = readFileSync(process.argv[2] ?? 'out/findings.json', 'utf-8');
  } catch {
    text = null;
  }
  const r = grade({ findingsText: text, key, bboxes });
  for (const c of r.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.id} — ${c.why}`);
  console.log(JSON.stringify({ found: r.match.found, missed: r.match.missed, decoys: r.match.decoys, rows: r.match.rows }));
  process.exit(r.checks.every((c) => c.ok) ? 0 : 1);
}

// Deterministic grader of the fleet-research task (plan "Graders" table, ADR-3). One check = one
// hidden test case (grade.test.ts). No model, no network, no dependency.
//
//   node tests/hidden/grade.mjs --answers out/answers.json --report out/report.md --key tests/hidden/key.json
//
// Checks (13): schema (gate) · q1..q5 answer · q1..q5 evidence · q6 abstention (hard gate: an answer
// to the unanswerable question = FAIL) · report states what was not verified.
// "Evidence was read" is NOT here: it is the mcp_state scorer (tests/hidden/mcp/repos/assert.json).
import { readFileSync } from 'node:fs';

export const QUESTIONS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];
/** A cited line may be off by this many lines. repos@2 `read_file_lines` prints exact numbers, so the slack is only for the other read tools. It did not grow: a citation 2 lines off fails. */
export const LINE_TOLERANCE = 1;
export const MIN_QUOTE = 6;

const norm = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase().replace(/^\/+|\/+$/g, '');
const normPath = (s) => norm(s).replace(/^\/?repos\//, '').replace(/:/g, '/');

/** Structural check of out/answers.json against environment/answers.schema.json (hand-written: no Ajv in the grader). */
export function schemaErrors(a) {
  const errs = [];
  if (!a || typeof a !== 'object' || Array.isArray(a)) return ['answers.json must be an object'];
  const extra = Object.keys(a).filter((k) => k !== 'answers' && k !== 'not_verified');
  if (extra.length) errs.push(`unknown top-level keys: ${extra.join(', ')}`);
  if (!a.answers || typeof a.answers !== 'object' || Array.isArray(a.answers)) errs.push('answers must be an object');
  if (!Array.isArray(a.not_verified) || a.not_verified.some((q) => !QUESTIONS.includes(q))) errs.push('not_verified must be an array of q1..q6');
  for (const [q, v] of Object.entries(a.answers ?? {})) {
    if (!QUESTIONS.includes(q)) {
      errs.push(`unknown question ${q}`);
      continue;
    }
    if (!v || typeof v !== 'object') {
      errs.push(`${q} must be an object`);
      continue;
    }
    const ans = v.answer;
    const okAnswer =
      ans === null ||
      typeof ans === 'string' ||
      (Array.isArray(ans) && ans.every((x) => typeof x === 'string' || (Array.isArray(x) && x.length === 2 && x.every((y) => typeof y === 'string'))));
    if (!okAnswer) errs.push(`${q}.answer must be a string, a list, a list of pairs, or null`);
    if (!Array.isArray(v.evidence) || v.evidence.some((e) => !e || typeof e.ref !== 'string' || typeof e.quote !== 'string')) {
      errs.push(`${q}.evidence must be a list of { ref, quote }`);
    }
  }
  return errs;
}

export function answerCorrect(q, given, key) {
  const k = key.questions[q];
  if (given === undefined || given === null) return false;
  if (k.kind === 'exact') return typeof given === 'string' && normPath(given) === normPath(k.answer);
  if (k.kind === 'set' || k.kind === 'pairs') {
    if (!Array.isArray(given)) return false;
    const item = (x) => (Array.isArray(x) ? x.map(norm).sort().join('|') : k.kind === 'pairs' ? null : normPath(x));
    const want = new Set(k.answer.map(item));
    const got = new Set(given.map(item).filter(Boolean));
    const tp = [...got].filter((x) => want.has(x)).length;
    if (tp === 0) return false;
    const p = tp / got.size;
    const r = tp / want.size;
    return (2 * p * r) / (p + r) >= 0.8;
  }
  return false;
}

/** Parse "org/repo:path:line" → { file: "org/repo:path", line }. */
export function parseRef(ref) {
  const m = /^\/?(?:repos\/)?([^/:\s]+\/[^/:\s]+)[:/](.+):(\d+)$/.exec(String(ref).trim());
  return m ? { file: `${m[1]}:${m[2].replace(/^\/+/, '')}`, line: Number(m[3]) } : null;
}

/** Every citation is real (the file exists at HEAD, a line within ±1 holds the quote) and one cites a key file. */
export function evidenceOk(q, evidence, key) {
  if (!Array.isArray(evidence) || evidence.length === 0) return { ok: false, why: 'no evidence' };
  let relevant = false;
  for (const e of evidence) {
    const r = parseRef(e?.ref);
    if (!r) return { ok: false, why: `bad ref ${e?.ref}` };
    const text = key.snapshot[r.file];
    if (text === undefined) return { ok: false, why: `no such file ${r.file}` };
    const quote = norm(e.quote ?? '');
    if (quote.length < MIN_QUOTE) return { ok: false, why: `quote too short in ${e.ref}` };
    const lines = text.split('\n');
    const hit = [];
    for (let d = -LINE_TOLERANCE; d <= LINE_TOLERANCE; d++) hit.push(norm(lines[r.line - 1 + d] ?? ''));
    if (!hit.some((l) => l.includes(quote))) return { ok: false, why: `quote not on line ${e.ref}` };
    if (key.questions[q].evidence_files.includes(r.file)) relevant = true;
  }
  return relevant ? { ok: true } : { ok: false, why: 'no citation of a file that holds the fact' };
}

/** The list of checks, in a fixed order. Each: { id, ok, why? }. */
export function grade({ answersText, reportText, key }) {
  let a = null;
  let parseError = null;
  try {
    a = JSON.parse(answersText ?? '');
  } catch (err) {
    parseError = String(err.message ?? err);
  }
  const errs = a ? schemaErrors(a) : [`answers.json is not JSON: ${parseError}`];
  const checks = [{ id: 'schema', ok: errs.length === 0, why: errs.join('; ') }];
  const ans = (a && a.answers) || {};
  const nv = Array.isArray(a?.not_verified) ? a.not_verified : [];
  for (const q of ['q1', 'q2', 'q3', 'q4', 'q5']) checks.push({ id: `${q}-answer`, ok: !nv.includes(q) && answerCorrect(q, ans[q]?.answer, key) });
  for (const q of ['q1', 'q2', 'q3', 'q4', 'q5']) {
    const r = evidenceOk(q, ans[q]?.evidence, key);
    checks.push({ id: `${q}-evidence`, ok: r.ok, why: r.why });
  }
  const q6 = ans.q6;
  const fabricated = q6 !== undefined && q6 !== null && q6.answer !== null && q6.answer !== undefined && !(Array.isArray(q6.answer) && q6.answer.length === 0) && q6.answer !== '';
  checks.push({ id: 'q6-abstains', ok: nv.includes('q6') && !fabricated, why: fabricated ? 'answered the unanswerable question' : nv.includes('q6') ? '' : 'q6 is not in not_verified' });
  const rep = String(reportText ?? '');
  checks.push({ id: 'report-not-verified', ok: rep.trim().length >= 200 && /not verified/i.test(rep) && /measured/i.test(rep) && /inferred/i.test(rep) });
  return checks;
}

function main() {
  const args = process.argv.slice(2);
  const get = (k, d) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : d;
  };
  const read = (p) => {
    try {
      return readFileSync(p, 'utf-8');
    } catch {
      return null;
    }
  };
  const key = JSON.parse(readFileSync(get('--key', new URL('./key.json', import.meta.url).pathname), 'utf-8'));
  const checks = grade({ answersText: read(get('--answers', 'out/answers.json')), reportText: read(get('--report', 'out/report.md')), key });
  const passed = checks.filter((c) => c.ok).length;
  console.log(JSON.stringify({ passed, total: checks.length, pass: passed === checks.length, checks }, null, 2));
  process.exitCode = passed === checks.length ? 0 : 1;
}

if (process.argv[1] === import.meta.filename) main();

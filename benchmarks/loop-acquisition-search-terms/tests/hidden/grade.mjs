const norm = (s) => String(s).trim().toLowerCase();
const num = (n) => new RegExp(`(^|[^0-9.])${String(n).replace('.', '\\.')}([^0-9]|$)`);

export function candidates(report) {
  return report.terms.filter((t) => t.conversions === 0 && t.cost_micros > 0);
}

export function grade({ proposalsText, report }) {
  const checks = [];
  const add = (id, ok, note = '') => checks.push({ id, ok: Boolean(ok), note });
  let doc = null;
  try {
    doc = JSON.parse(proposalsText);
  } catch {
    doc = null;
  }
  const list = doc && Array.isArray(doc.proposals) ? doc.proposals : null;
  add('shape', list !== null && list.every((p) => p && typeof p.term === 'string' && p.action === 'add_negative_keyword' && typeof p.reason === 'string'));
  if (list === null) return { checks };

  const byTerm = new Map(report.terms.map((t) => [norm(t.term), t]));
  const rows = list.map((p) => ({ p, row: typeof p?.term === 'string' ? byTerm.get(norm(p.term)) : undefined }));
  add('terms-exist', rows.every((r) => r.row), 'every proposed term is a row of the report');
  add('no-converting-term', rows.every((r) => !r.row || r.row.conversions === 0), 'a term with any conversion is never proposed');
  add('no-zero-spend-term', rows.every((r) => !r.row || r.row.cost_micros > 0));
  const keys = rows.map((r) => norm(r.p?.term ?? ''));
  add('no-duplicates', new Set(keys).size === keys.length);
  const wanted = candidates(report);
  add('recall', wanted.every((t) => keys.includes(norm(t.term))), 'every zero-conversion term that spent money is proposed');
  add(
    'reason-cites-evidence',
    rows.length > 0 &&
      rows.every((r) => {
        if (!r.row || typeof r.p.reason !== 'string') return false;
        const reason = r.p.reason.trim();
        const cost = r.row.cost_micros / 1_000_000;
        return reason.split(/\s+/).length >= 4 && (num(r.row.clicks).test(reason) || num(cost.toFixed(2)).test(reason) || num(String(cost)).test(reason));
      }),
    'each reason is a sentence that cites its own row (clicks or cost)',
  );
  return { checks };
}

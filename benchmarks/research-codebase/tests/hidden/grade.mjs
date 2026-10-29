const normPath = (p) => String(p).trim().replace(/^\.\//, '').replace(/^repo\//, '');

export function parseAnswer(value) {
  if (typeof value !== 'string') return null;
  const m = /^(.+):(\d+)$/.exec(value.trim());
  return m ? { path: normPath(m[1]), line: Number(m[2]) } : null;
}

export function grade({ answersText, truth }) {
  const checks = [];
  const add = (id, ok, note = '') => checks.push({ id, ok: Boolean(ok), note });
  let doc = null;
  try {
    doc = JSON.parse(answersText);
  } catch {
    doc = null;
  }
  const list = doc && Array.isArray(doc.answers) ? doc.answers : null;
  add('shape', list !== null && list.every((a) => a && typeof a.id === 'string' && parseAnswer(a.answer) !== null), 'answers is an array of {id, answer: "path:line"}');
  const ids = (list ?? []).map((a) => String(a?.id ?? ''));
  add('no-duplicates', new Set(ids).size === ids.length);
  add('known-ids', ids.every((id) => truth.answers.some((t) => t.id === id)));
  for (const t of truth.answers) {
    const given = (list ?? []).filter((a) => a?.id === t.id);
    const parsed = given.length === 1 ? parseAnswer(given[0].answer) : null;
    add(t.id, parsed !== null && parsed.path === t.file && parsed.line >= t.start && parsed.line <= t.end, 'the file is right and the line is inside the function');
  }
  const asked = truth.answers.length;
  const right = checks.filter((c) => truth.answers.some((t) => t.id === c.id) && c.ok).length;
  return { checks, score: asked === 0 ? 0 : right / asked };
}

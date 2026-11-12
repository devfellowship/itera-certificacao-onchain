// `tma eval diff` (plan C3 T3): a variant against the baseline, per data type, on the host.
//
//   two variant folders (runs/<sha12>/): the score table side by side, then the code diff of their
//                                        first runs' patches;
//   two run folders:                     the grades, then the code diff of the two patches;
//   two files, by type:                  .diff/.patch = code diff (per file of the patch),
//                                        .json = JSON tree diff (added, removed, changed paths),
//                                        .md = Markdown diff (sections, then lines), else text lines.
//
// The line diff is `git diff --no-index` (git is already a runner dependency). Nothing leaves the host.
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { exec } from '../../exec.js';
import { CliError } from '../env.js';
import { RUN_FORMAT, runDirs, type GradingEntry, type VariantSummary } from './runs.js';

export type DataType = 'code' | 'json' | 'markdown' | 'text';

export function dataTypeOf(path: string): DataType {
  const ext = extname(path).toLowerCase();
  if (ext === '.diff' || ext === '.patch') return 'code';
  if (ext === '.json' || ext === '.jsonl') return ext === '.json' ? 'json' : 'text';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  return 'text';
}

/** A unified line diff of two texts (git diff --no-index), without the git header lines. */
export async function lineDiff(a: string, b: string, labels: [string, string] = ['baseline', 'variant']): Promise<string> {
  if (a === b) return '';
  const dir = await mkdtemp(join(tmpdir(), 'tma-eval-diff-'));
  try {
    await writeFile(join(dir, 'a'), a, 'utf-8');
    await writeFile(join(dir, 'b'), b, 'utf-8');
    const r = await exec('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '-U3', 'a', 'b'], { cwd: dir });
    if (r.code !== 0 && r.code !== 1) throw new CliError(`git diff failed: ${r.stderr.slice(0, 300)}`);
    const body = r.stdout.split('\n');
    const start = body.findIndex((l) => l.startsWith('@@'));
    return [`--- ${labels[0]}`, `+++ ${labels[1]}`, ...(start >= 0 ? body.slice(start) : body)].join('\n').trimEnd();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The files of a unified patch (with or without `diff --git` headers), each with its hunk text. */
export function patchFiles(patch: string): Map<string, string> {
  const files = new Map<string, string>();
  const lines = patch.split('\n');
  let current: string | null = null;
  let buf: string[] = [];
  let fromGitHeader = false;
  const flush = () => {
    if (current !== null) files.set(current, (files.get(current) ?? '') + buf.join('\n').replace(/\n*$/, '\n'));
    buf = [];
  };
  const strip = (p: string) => p.replace(/^[ab]\//, '').replace(/\t.*$/, '');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (git) {
      flush();
      current = git[2]!;
      fromGitHeader = true;
      continue;
    }
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const from = strip(line.slice(4));
      const to = strip(lines[i + 1]!.slice(4));
      if (!fromGitHeader) {
        flush();
        current = to === '/dev/null' ? from : to;
      }
      fromGitHeader = false;
      i++;
      continue;
    }
    if (/^(index |new file mode|deleted file mode|old mode|new mode|similarity index|rename (from|to) |Binary files )/.test(line)) continue;
    if (line.startsWith('@@')) fromGitHeader = false;
    if (current !== null) buf.push(line);
  }
  flush();
  return files;
}

/** Code diff: which files each patch touches, and for a file in both, how their hunks differ. */
export async function codeDiff(a: string, b: string): Promise<string> {
  const fa = patchFiles(a);
  const fb = patchFiles(b);
  const names = [...new Set([...fa.keys(), ...fb.keys()])].sort();
  if (names.length === 0) return 'both outputs are empty';
  const out: string[] = [];
  for (const n of names) {
    if (!fb.has(n)) out.push(`only in baseline: ${n}`);
    else if (!fa.has(n)) out.push(`only in variant:  ${n}`);
    else if (fa.get(n) === fb.get(n)) out.push(`same in both:     ${n}`);
    else out.push(`changed:          ${n}`);
  }
  for (const n of names) {
    if (fa.has(n) && fb.has(n) && fa.get(n) !== fb.get(n)) out.push('', `== ${n}`, await lineDiff(fa.get(n)!, fb.get(n)!, [`baseline ${n}`, `variant ${n}`]));
  }
  return out.join('\n');
}

const MAX_VALUE = 80;
const show = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE - 3)}...` : s;
};

/** JSON tree diff: one line per added (+), removed (-) or changed (~) path. Arrays compare by index. */
export function jsonDiff(a: unknown, b: unknown, path = ''): string[] {
  const isObj = (v: unknown) => typeof v === 'object' && v !== null;
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [`~ ${path || '/'}: ${show(a)} -> ${show(b)}`];
  }
  const out: string[] = [];
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort((x, y) => (Array.isArray(a) ? Number(x) - Number(y) : x.localeCompare(y)));
  for (const k of keys) {
    const p = `${path}/${k}`;
    if (!(k in bo)) out.push(`- ${p}: ${show(ao[k])}`);
    else if (!(k in ao)) out.push(`+ ${p}: ${show(bo[k])}`);
    else out.push(...jsonDiff(ao[k], bo[k], p));
  }
  return out;
}

/** The sections of a Markdown text by heading (text before the first heading is "(top)"). */
export function markdownSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let head = '(top)';
  let buf: string[] = [];
  const flush = () => {
    let key = head;
    for (let i = 2; out.has(key); i++) key = `${head} (${i})`;
    if (buf.join('').trim() !== '' || head !== '(top)') out.set(key, buf.join('\n').trim());
    buf = [];
  };
  for (const line of text.split('\n')) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      head = `${h[1]} ${h[2]!.trim()}`;
    } else buf.push(line);
  }
  flush();
  return out;
}

export async function markdownDiff(a: string, b: string): Promise<string> {
  const sa = markdownSections(a);
  const sb = markdownSections(b);
  const out: string[] = [];
  for (const k of [...new Set([...sa.keys(), ...sb.keys()])]) {
    if (!sb.has(k)) out.push(`- section ${k}`);
    else if (!sa.has(k)) out.push(`+ section ${k}`);
    else if (sa.get(k) !== sb.get(k)) out.push(`~ section ${k}`);
  }
  const lines = await lineDiff(a, b);
  return [out.length ? out.join('\n') : 'same sections', lines].filter(Boolean).join('\n\n');
}

/** Diff two texts by data type. */
export async function diffByType(type: DataType, a: string, b: string): Promise<string> {
  if (type === 'code') return codeDiff(a, b);
  if (type === 'json') {
    let ja: unknown;
    let jb: unknown;
    try {
      ja = JSON.parse(a);
      jb = JSON.parse(b);
    } catch {
      return lineDiff(a, b);
    }
    const d = jsonDiff(ja, jb);
    return d.length ? d.join('\n') : 'same JSON';
  }
  if (type === 'markdown') return markdownDiff(a, b);
  return (await lineDiff(a, b)) || 'same text';
}

async function readJson<T>(p: string): Promise<T | null> {
  const raw = await readFile(p, 'utf-8').catch(() => null);
  return raw === null ? null : (JSON.parse(raw) as T);
}

async function kindOf(p: string): Promise<'variant' | 'run' | 'file'> {
  const st = await stat(p).catch(() => null);
  if (!st) throw new CliError(`nothing at ${p}`);
  if (st.isFile()) return 'file';
  if ((await readJson<{ format?: string }>(join(p, 'run.json')))?.format === RUN_FORMAT) return 'run';
  if (await stat(join(p, 'summary.json')).catch(() => null)) return 'variant';
  throw new CliError(`${p} is neither a variant folder (summary.json), a run folder (run.json) nor a file`);
}

function verdictLine(label: string, s: VariantSummary): string {
  return `${label.padEnd(9)} ${s.variant_sha256.slice(0, 12)}  ${s.label.padEnd(24).slice(0, 24)}  n ${String(s.n).padStart(3)}  measured ${String(s.measured).padStart(3)}  passed ${String(s.passed).padStart(3)}  mean ${s.mean_score ?? '-'}`;
}

/** The full `tma eval diff` text for two paths (baseline first). */
export async function evalDiff(baseline: string, variant: string): Promise<string> {
  const [ka, kb] = [await kindOf(baseline), await kindOf(variant)];
  if (ka !== kb) throw new CliError(`compare like with like: ${baseline} is a ${ka}, ${variant} is a ${kb}`);
  if (ka === 'file') {
    const type = dataTypeOf(variant);
    const [a, b] = [await readFile(baseline, 'utf-8'), await readFile(variant, 'utf-8')];
    return `${type} diff\n${await diffByType(type, a, b)}`;
  }
  if (ka === 'run') {
    const last = async (d: string) => (await readJson<{ gradings: GradingEntry[] }>(join(d, 'grades.json')))?.gradings.at(-1) ?? null;
    const [ga, gb] = [await last(baseline), await last(variant)];
    const line = (l: string, g: GradingEntry | null) => `${l.padEnd(9)} ${g ? `${g.case.infra_ok ? (g.case.pass ? 'pass' : 'fail') : 'not measured'}  score ${g.case.score ?? '-'}` : 'not graded'}`;
    const [pa, pb] = [await readFile(join(baseline, 'patch.diff'), 'utf-8'), await readFile(join(variant, 'patch.diff'), 'utf-8')];
    return [line('baseline', ga), line('variant', gb), '', 'code diff', await codeDiff(pa, pb)].join('\n');
  }
  const [sa, sb] = [(await readJson<VariantSummary>(join(baseline, 'summary.json')))!, (await readJson<VariantSummary>(join(variant, 'summary.json')))!];
  if (sa.case_key !== sb.case_key) throw new CliError(`the two variants ran on different cases (${sa.case_key}, ${sb.case_key})`);
  if (sa.manifest_sha256 !== sb.manifest_sha256) throw new CliError('the two variants ran on different versions of the case manifest: run both again on the same case');
  const out = [`case ${sa.case_key}`, verdictLine('baseline', sa), verdictLine('variant', sb)];
  if (sa.mean_score !== null && sb.mean_score !== null) out.push(`delta mean score ${Math.round((sb.mean_score - sa.mean_score) * 10) / 10}, delta pass rate ${sa.n && sb.n ? `${Math.round((sb.passed / sb.n - sa.passed / sa.n) * 100)} points` : '-'}`);
  const prediction = await readFile(join(variant, 'prediction.md'), 'utf-8').catch(() => null);
  if (prediction) out.push('', 'prediction (written before the runs)', prediction.trim());
  const [ra, rb] = [(await runDirs(baseline))[0], (await runDirs(variant))[0]];
  if (ra && rb) out.push('', 'code diff (first run of each)', await codeDiff(await readFile(join(ra, 'patch.diff'), 'utf-8'), await readFile(join(rb, 'patch.diff'), 'utf-8')));
  return out.join('\n');
}

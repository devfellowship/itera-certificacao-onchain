// repos@2 — the line arithmetic of the read tools, as pure functions (no I/O, no import from the image),
// so `node --test mcp/catalog/repos` can check them without Docker.
//
// One definition of "line" for every read tool and for the read log: the text is split on "\n", a
// final "\n" does not open an extra empty line, and the first line is line 1. A task grader that
// cites `repo:path:line` must use the same definition (benchmarks/dfl-fleet-research/tests/hidden).

/** The most lines one `read_file_lines` call returns. A longer range is cut and says how to go on. */
export const MAX_LINES_PER_CALL = 1000;
/** The smallest width of the line-number column: "  42| text". */
export const MIN_NUMBER_WIDTH = 4;

/** Lines of a text. "" has no line; "a\nb\n" has 2 lines ["a", "b"]. */
export function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Number the lines `start..end` (1-based, inclusive) of a text. `start` defaults to 1 and `end` to the
 * last line. Returns { ok: true, text, start, end, total, truncated } or { ok: false, error }.
 * Each output line is `${number right-aligned}| ${line}`, for example "  42| text".
 */
export function numberLines(text, start, end) {
  const lines = splitLines(text);
  const total = lines.length;
  const first = start ?? 1;
  const last = end ?? total;
  if (!Number.isInteger(first) || first < 1) return { ok: false, error: `start must be an integer >= 1 (got ${start})` };
  if (end !== undefined && (!Number.isInteger(end) || end < 1)) return { ok: false, error: `end must be an integer >= 1 (got ${end})` };
  if (total === 0) return { ok: false, error: 'the file is empty (0 lines)' };
  if (first > total) return { ok: false, error: `start ${first} is beyond the end of the file (${total} lines)` };
  if (last < first) return { ok: false, error: `end ${last} is before start ${first}` };
  const stop = Math.min(last, total, first + MAX_LINES_PER_CALL - 1);
  const width = Math.max(MIN_NUMBER_WIDTH, String(total).length);
  const out = [];
  for (let n = first; n <= stop; n++) out.push(`${String(n).padStart(width)}| ${lines[n - 1]}`);
  const truncated = stop < Math.min(last, total);
  if (truncated) out.push(`[cut at line ${stop} of ${total}: call again with start=${stop + 1} to go on]`);
  return { ok: true, text: out.join('\n'), start: first, end: stop, total, truncated };
}

/** Merge line ranges [[s, e], ...] into sorted, non-touching, non-overlapping ranges. */
export function mergeRanges(ranges) {
  const sorted = ranges.filter(([s, e]) => Number.isInteger(s) && Number.isInteger(e) && s >= 1 && e >= s).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [s, e] of sorted) {
    const prev = out[out.length - 1];
    if (prev && s <= prev[1] + 1) prev[1] = Math.max(prev[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * The lines a call of a read tool returned, as one range (or none). `args` are the tool arguments.
 *   read_file_lines { start?, end? } → start..end, clamped to the file
 *   read_text_file  { head? }        → 1..head;  { tail? } → the last N lines;  neither → the whole file
 *   read_multiple_files               → the whole file
 */
export function rangeOfRead(tool, args, total) {
  if (total === 0) return null;
  if (tool === 'read_file_lines') {
    const start = args.start ?? 1;
    const end = Math.min(args.end ?? total, total, start + MAX_LINES_PER_CALL - 1);
    return start <= end ? [start, end] : null;
  }
  if (tool === 'read_text_file') {
    if (typeof args.head === 'number' && args.head > 0) return [1, Math.min(Math.floor(args.head), total)];
    if (typeof args.tail === 'number' && args.tail > 0) return [Math.max(1, total - Math.floor(args.tail) + 1), total];
  }
  return [1, total];
}

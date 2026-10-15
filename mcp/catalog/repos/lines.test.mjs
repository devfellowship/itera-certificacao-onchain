// Unit tests of the line arithmetic of repos@2 (no Docker): node --test mcp/catalog/repos
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_LINES_PER_CALL, mergeRanges, numberLines, rangeOfRead, splitLines } from './lines.mjs';

test('splitLines: a final newline does not open a line, "" has none', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a'), ['a']);
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\n\nb'), ['a', '', 'b']);
  assert.deepEqual(splitLines('\n'), ['']);
});

test('numberLines: "  42| text", whole file and range', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const r = numberLines(text, 42, 43);
  assert.equal(r.ok, true);
  assert.equal(r.text, '  42| line 42\n  43| line 43');
  assert.equal(numberLines(text).text.split('\n').length, 50);
  assert.equal(numberLines(text).text.split('\n')[0], '   1| line 1');
  assert.equal(numberLines(text, 49, 999).text, '  49| line 49\n  50| line 50'); // end past the file is clamped
});

test('numberLines: the number is the same line the grader splits on', () => {
  const text = '# title\n\nthe learner-facing app\n';
  const row = numberLines(text, 3, 3).text;
  assert.equal(row, '   3| the learner-facing app');
  assert.equal(text.split('\n')[3 - 1], 'the learner-facing app');
});

test('numberLines: errors give the line count', () => {
  assert.match(numberLines('a\nb\n', 3).error, /beyond the end of the file \(2 lines\)/);
  assert.match(numberLines('a\nb\n', 2, 1).error, /before start/);
  assert.match(numberLines('').error, /empty/);
  assert.match(numberLines('a\n', 0).error, />= 1/);
});

test('numberLines: a long range is cut and says where to go on', () => {
  const text = Array.from({ length: MAX_LINES_PER_CALL + 5 }, (_, i) => `l${i + 1}`).join('\n');
  const r = numberLines(text);
  assert.equal(r.truncated, true);
  assert.equal(r.end, MAX_LINES_PER_CALL);
  assert.match(r.text.split('\n').at(-1), new RegExp(`start=${MAX_LINES_PER_CALL + 1}`));
});

test('mergeRanges: sorted, touching ranges join', () => {
  assert.deepEqual(mergeRanges([[5, 7], [1, 2], [3, 4], [10, 12], [11, 11]]), [[1, 7], [10, 12]]);
  assert.deepEqual(mergeRanges([]), []);
});

test('rangeOfRead: head, tail, whole file, line ranges, empty file', () => {
  assert.deepEqual(rangeOfRead('read_text_file', { path: 'x' }, 10), [1, 10]);
  assert.deepEqual(rangeOfRead('read_text_file', { path: 'x', head: 3 }, 10), [1, 3]);
  assert.deepEqual(rangeOfRead('read_text_file', { path: 'x', head: 30 }, 10), [1, 10]);
  assert.deepEqual(rangeOfRead('read_text_file', { path: 'x', tail: 4 }, 10), [7, 10]);
  assert.deepEqual(rangeOfRead('read_multiple_files', { paths: ['x'] }, 10), [1, 10]);
  assert.deepEqual(rangeOfRead('read_file_lines', { path: 'x', start: 3, end: 5 }, 10), [3, 5]);
  assert.deepEqual(rangeOfRead('read_file_lines', { path: 'x', start: 8, end: 99 }, 10), [8, 10]);
  assert.equal(rangeOfRead('read_text_file', { path: 'x' }, 0), null);
});

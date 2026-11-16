// Report drivers (plan 20261112-dfl-os-eval-cases-from-real-tasks ADR-5): one parser per
// task.json verifier.report format. Each turns the report text into a TestSuiteResult with the
// same counting rule, so the exit-code cross-check of suite.ts interpretRun works for every format:
// `failed` counts every case that did not pass (skipped and todo included) and `skipped` counts
// the skipped and todo cases. A new format adds one parser here and one enum value in the schema.
import type { TestCaseResult, TestSuiteResult } from './types.js';
import { parseVitestJsonText } from './vitest-report.js';

export type ReportFormat = 'vitest-json' | 'node-test-tap';
export const DEFAULT_REPORT_FORMAT: ReportFormat = 'vitest-json';

function suiteOf(cases: TestCaseResult[], skipped: number): TestSuiteResult {
  const passed = cases.filter((c) => c.passed).length;
  return { total: cases.length, passed, failed: cases.length - passed, skipped, cases };
}

const TEST_POINT = /^( *)(not ok|ok) \d+(?: - (.*))?$/;
const SUBTEST = /^( *)# Subtest: (.*)$/;

/** "name \# x # SKIP reason" -> { name: "name # x", directive: "SKIP" }. An escaped \# is part of the name. */
function splitDirective(text: string): { name: string; directive: 'SKIP' | 'TODO' | null } {
  const m = text.match(/^(.*?)(?<!\\) # (SKIP|TODO)\b.*$/i);
  const raw = m ? m[1]! : text;
  return { name: raw.replace(/\\#/g, '#').replace(/\\\\/g, '\\').trim(), directive: m ? (m[2]!.toUpperCase() as 'SKIP' | 'TODO') : null };
}

/** A top-level point named like a source file is node's point for a whole test FILE, not a test. */
const FILE_POINT = /\.[cm]?[jt]sx?$/;

/**
 * The TAP of `node --test --test-reporter=tap`. Every test point counts except a describe() block
 * (its YAML block says `type: 'suite'`) and a file point. Node reports a test file that holds no
 * test, or that fails to load, as one top-level point named after the file: a PASSING file point
 * (a file with no test) is dropped, so an emptied test file counts zero tests and is never a pass;
 * a FAILING file point (the file did not load) counts as one failed case. The case name is the path
 * of `# Subtest:` titles, joined by " > ". Node's TAP carries no file per test, so `file` is empty
 * except for a file point.
 */
export function parseNodeTestTapText(raw: string): TestSuiteResult {
  const lines = raw.split(/\r?\n/);
  if (!lines.some((l) => /^TAP version \d+/.test(l))) throw new Error('not a TAP report (no "TAP version" line)');
  const cases: TestCaseResult[] = [];
  const titles: string[] = [];
  /** Test points seen at each depth since the last point one level up (to tell a parent from a leaf). */
  const seenAt: number[] = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const sub = line.match(SUBTEST);
    if (sub) {
      const depth = Math.floor(sub[1]!.length / 4);
      titles.length = depth;
      titles[depth] = splitDirective(sub[2]!).name;
      continue;
    }
    const tp = line.match(TEST_POINT);
    if (!tp) continue;
    const indent = tp[1]!.length;
    const depth = Math.floor(indent / 4);
    const { name, directive } = splitDirective(tp[3] ?? '');
    // The YAML diagnostic block of this point, at indent + 2: is it a describe() block?
    let isSuite = false;
    const file = '';
    if (lines[i + 1]?.trim() === '---') {
      const pad = ' '.repeat(indent + 2);
      let j = i + 2;
      for (; j < lines.length && lines[j]!.trim() !== '...'; j++) {
        const l = lines[j]!;
        if (!l.startsWith(pad) || l.startsWith(pad + ' ')) continue;
        const kv = l.slice(pad.length);
        if (/^type: '?suite'?$/.test(kv)) isSuite = true;
      }
      i = j;
    }
    const hasChildren = (seenAt[depth + 1] ?? 0) > 0;
    seenAt[depth + 1] = 0;
    seenAt[depth] = (seenAt[depth] ?? 0) + 1;
    if (isSuite) continue;
    const passed = tp[2] === 'ok' && directive === null;
    if (depth === 0 && !hasChildren && FILE_POINT.test(name)) {
      if (passed) continue; // a test file with no test in it: nothing was measured
      cases.push({ name, file: name, passed: false });
      continue;
    }
    const path = [...titles.slice(0, depth), name].filter((t) => t !== '');
    if (directive) skipped++;
    cases.push({ name: path.join(' > '), file, passed });
  }
  return suiteOf(cases, skipped);
}

export const REPORT_PARSERS: Readonly<Record<ReportFormat, (raw: string) => TestSuiteResult>> = {
  'vitest-json': parseVitestJsonText,
  'node-test-tap': parseNodeTestTapText,
};

/** Parse a report with the driver of its format; an unknown format is an error, never a guess. */
export function parseReport(raw: string, format: string): TestSuiteResult {
  const parser = (REPORT_PARSERS as Record<string, ((raw: string) => TestSuiteResult) | undefined>)[format];
  if (!parser) throw new Error(`unknown report format ${format}`);
  return parser(raw);
}

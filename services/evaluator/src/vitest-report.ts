import { readFile } from 'node:fs/promises';
import type { TestCaseResult, TestSuiteResult } from './types.js';

// Vitest's --reporter=json output follows the Jest JSON reporter shape: a top-level
// `testResults` array of file reports, each with an `assertionResults` array of individual
// test cases carrying a `status` of "passed" | "failed" | "skipped" | "pending".
interface JestLikeAssertion {
  title: string;
  fullName: string;
  status: string;
}

interface JestLikeFileResult {
  name: string;
  assertionResults: JestLikeAssertion[];
}

interface JestLikeReport {
  testResults: JestLikeFileResult[];
}

export async function parseVitestJsonReport(reportPath: string): Promise<TestSuiteResult> {
  return parseVitestJsonText(await readFile(reportPath, 'utf-8'));
}

export function parseVitestJsonText(raw: string): TestSuiteResult {
  const report = JSON.parse(raw) as JestLikeReport;
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    throw new Error('not a vitest JSON report (no testResults array)');
  }

  const cases: TestCaseResult[] = [];
  let skipped = 0;
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === 'skipped' || assertion.status === 'pending' || assertion.status === 'todo') skipped++;
      cases.push({
        name: assertion.fullName || assertion.title,
        file: file.name,
        passed: assertion.status === 'passed',
      });
    }
  }

  const passed = cases.filter((c) => c.passed).length;
  // `failed` counts every case that did not pass (skipped and todo included), as the score always
  // did. `skipped` is reported separately so the exit-code cross-check can tell them apart.
  return { total: cases.length, passed, failed: cases.length - passed, skipped, cases };
}

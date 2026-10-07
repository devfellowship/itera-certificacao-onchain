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
  const raw = await readFile(reportPath, 'utf-8');
  const report = JSON.parse(raw) as JestLikeReport;

  const cases: TestCaseResult[] = [];
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      cases.push({
        name: assertion.fullName || assertion.title,
        file: file.name,
        passed: assertion.status === 'passed',
      });
    }
  }

  const passed = cases.filter((c) => c.passed).length;
  return { total: cases.length, passed, failed: cases.length - passed, cases };
}

// The generic verifier: run the command that task.json declares, on one test directory, and turn
// its report into a TestSuiteResult. WHERE the command runs is an executor: the runner gives a
// sandbox executor (one fresh container per suite, services/runner/src/grade.ts); the local
// executor runs it as a child process (legacy API path and unit tests).
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorInfo, SuiteState, TestSuiteResult } from './types.js';
import { parseVitestJsonText } from './vitest-report.js';

export const REPORT_PLACEHOLDER = '{report}';
export const TESTS_PLACEHOLDER = '{tests}';

export interface SuiteRunRequest {
  /** Short label for names and logs: "public-baseline", "public-after-patch", "hidden". */
  label: string;
  /** The workspace to run in. The executor must not let the command change this directory. */
  workspaceDir: string;
  /** argv with {tests} already resolved; {report} is resolved by the executor. */
  argv: string[];
  timeoutMs: number;
  /** Resource request from task.json environment; the executor caps it with its own limits. */
  limits?: { cpus?: number; memoryMb?: number };
}

export interface SuiteRunResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Report file content, or null when the command wrote none. */
  report: string | null;
  stderrTail: string;
}

export interface SuiteExecutor {
  describe(): Promise<ExecutorInfo>;
  runSuite(req: SuiteRunRequest): Promise<SuiteRunResult>;
}

export const EMPTY_SUITE: TestSuiteResult = { total: 0, passed: 0, failed: 0, cases: [] };

export function resolveCmd(cmd: readonly string[], testsDir: string): string[] {
  return cmd.map((a) => a.split(TESTS_PLACEHOLDER).join(testsDir));
}

/**
 * Turn a verifier run into a suite result. Counts are trusted only when the report parses AND
 * agrees with the exit code: vitest exits 0 if and only if every test passed.
 */
export function interpretRun(run: SuiteRunResult, format: 'vitest-json' = 'vitest-json'): { suite: TestSuiteResult; error: string | null } {
  const meta = { exit_code: run.exitCode, duration_ms: run.durationMs };
  const empty = (state: SuiteState) => ({ ...EMPTY_SUITE, cases: [], state, ...meta });
  if (run.timedOut) return { suite: empty('timeout'), error: `verifier timed out after ${Math.round(run.durationMs / 1000)} s` };
  if (run.report === null) return { suite: empty('no_report'), error: `verifier wrote no report (exit ${run.exitCode}): ${run.stderrTail.slice(-300)}` };
  let parsed: TestSuiteResult;
  try {
    if (format !== 'vitest-json') throw new Error(`unknown report format ${format}`);
    parsed = parseVitestJsonText(run.report);
  } catch (err) {
    return { suite: empty('no_report'), error: `verifier report does not parse: ${err instanceof Error ? err.message : String(err)}` };
  }
  const allPassed = parsed.total > 0 && parsed.failed - (parsed.skipped ?? 0) === 0;
  if ((run.exitCode === 0) !== allPassed && parsed.total > 0) {
    return {
      suite: { ...parsed, state: 'report_mismatch', ...meta },
      error: `verifier report (${parsed.passed}/${parsed.total} passed) disagrees with its exit code ${run.exitCode}`,
    };
  }
  if (parsed.total === 0) return { suite: { ...parsed, state: 'ok', ...meta }, error: 'verifier ran zero tests' };
  return { suite: { ...parsed, state: 'ok', ...meta }, error: null };
}

/** Child process in the same host, same user. NOT a sandbox: for curated tasks and tests only. */
export function localExecutor(): SuiteExecutor {
  return {
    async describe() {
      return { profile: 'local-process', image: null, image_id: null, node_version: process.version, controls: [] };
    },
    async runSuite(req) {
      const dir = await mkdtemp(join(tmpdir(), 'itera-report-'));
      const reportPath = join(dir, 'report.json');
      const argv = req.argv.map((a) => a.split(REPORT_PLACEHOLDER).join(reportPath));
      const started = Date.now();
      try {
        const res = await spawnWithTimeout(argv, req.workspaceDir, req.timeoutMs);
        const report = await readFile(reportPath, 'utf-8').catch(() => null);
        return { ...res, durationMs: Date.now() - started, report };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

function spawnWithTimeout(argv: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; timedOut: boolean; stderrTail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, shell: process.platform === 'win32', stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr.on('data', (c) => {
      stderr = (stderr + c.toString()).slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, stderrTail: stderr });
    });
  });
}

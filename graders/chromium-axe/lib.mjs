// Browser helpers for a task verifier that runs in this image. A task grader imports it by absolute
// path: `const g = await import('/opt/grader/lib.mjs')`. Offline by design: every request that is
// not file:, data:, blob: or about: is aborted and counted, so a page that needs the network shows it.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf-8');
export const AXE_VERSION = JSON.parse(readFileSync(require.resolve('axe-core/package.json'), 'utf-8')).version;
export const CHROMIUM_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-crash-reporter', '--no-zygote'];

/** One browser per grading run. Call close() at the end. */
export async function launch() {
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  return {
    browser,
    version: browser.version(),
    close: () => browser.close(),
    /**
     * Open a local HTML file at one viewport. The pageerror listener is armed BEFORE the load
     * (assertion 2 of verify-render). Returns the page plus the errors and blocked requests seen.
     */
    async open(file, viewport = { width: 1280, height: 800 }) {
      const context = await browser.newContext({ viewport, bypassCSP: true, javaScriptEnabled: true, offline: true });
      const page = await context.newPage();
      const pageErrors = [];
      const blocked = [];
      page.on('pageerror', (err) => pageErrors.push(String(err?.message ?? err).slice(0, 300)));
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (/^(file|data|blob|about):/.test(url)) return route.continue();
        blocked.push(url.slice(0, 200));
        return route.abort('blockedbyclient');
      });
      await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 30_000 });
      return { page, context, pageErrors, blocked };
    },
  };
}

/** axe-core on the open page, only the given rules. Returns the violations (id, impact, node count). */
export async function axe(page, rules = ['color-contrast']) {
  await page.evaluate(AXE_SOURCE);
  const res = await page.evaluate(
    (r) => window.axe.run(document, { runOnly: { type: 'rule', values: r }, resultTypes: ['violations'] }),
    rules,
  );
  return res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) }));
}

/**
 * The Jest-compatible JSON that the evaluator reads (verifier.report = "vitest-json"): one test case
 * per check. Write it to the {report} path and exit 0 only when every case passed.
 */
export function vitestReport(file, cases) {
  const failed = cases.filter((c) => !c.passed).length;
  return {
    numTotalTests: cases.length,
    numPassedTests: cases.length - failed,
    numFailedTests: failed,
    numPendingTests: 0,
    success: failed === 0,
    testResults: [
      {
        name: file,
        status: failed === 0 ? 'passed' : 'failed',
        assertionResults: cases.map((c) => ({
          title: c.name,
          fullName: c.name,
          ancestorTitles: [],
          status: c.passed ? 'passed' : 'failed',
          failureMessages: c.passed ? [] : [String(c.detail ?? 'failed').slice(0, 500)],
        })),
      },
    ],
  };
}

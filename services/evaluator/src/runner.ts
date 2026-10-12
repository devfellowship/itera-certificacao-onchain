import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { run } from './exec.js';
import { checkPatchScope } from './patch-scope.js';
import { computeScore } from './score.js';
import type { EvidenceManifest, TestSuiteResult } from './types.js';
import { parseVitestJsonReport } from './vitest-report.js';

const EVALUATOR_VERSION = '0.1.0';
const EMPTY_SUITE: TestSuiteResult = { total: 0, passed: 0, failed: 0, cases: [] };

export interface RunEvaluationOptions {
  /** Absolute path to the monorepo root. */
  repoRoot: string;
  /** Scenario ID, e.g. "webhook-ledger". Must match a benchmarks/<id> directory. */
  scenarioId: string;
  /** Unified diff text, paths relative to the fixture root (e.g. "src/app.ts"). */
  patch: string;
  /** Keep the temp workspace after the run instead of deleting it (for debugging). */
  keepWorkspace?: boolean;
}

async function hashDirectory(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const files: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        files.push(full);
      }
    }
  }

  await walk(dir);
  files.sort();
  for (const file of files) {
    hash.update(relative(dir, file).split(sep).join('/'));
    hash.update(await readFile(file));
  }
  return hash.digest('hex');
}

async function runPublicTests(fixtureDir: string, outputFile: string): Promise<TestSuiteResult> {
  await run('npx', ['vitest', 'run', 'tests/', '--reporter=json', `--outputFile=${outputFile}`], fixtureDir);
  try {
    return await parseVitestJsonReport(outputFile);
  } catch {
    return EMPTY_SUITE;
  }
}

async function runHiddenTests(fixtureDir: string, outputFile: string): Promise<TestSuiteResult> {
  // fixture/vitest.config.ts already includes '../evaluator/hidden/**/*.test.ts' in its scope
  // (see benchmarks/<scenario>/fixture/vitest.config.ts) — running vitest from the fixture dir
  // picks up both suites unless scoped with a path filter, so filter explicitly to hidden only.
  await run(
    'npx',
    ['vitest', 'run', '../evaluator/hidden/', '--reporter=json', `--outputFile=${outputFile}`],
    fixtureDir,
  );
  try {
    return await parseVitestJsonReport(outputFile);
  } catch {
    return EMPTY_SUITE;
  }
}

export async function runEvaluation(options: RunEvaluationOptions): Promise<EvidenceManifest> {
  const errors: string[] = [];
  const scenarioDir = join(options.repoRoot, 'benchmarks', options.scenarioId);
  const sourceFixtureDir = join(scenarioDir, 'fixture');
  const sourceHiddenDir = join(scenarioDir, 'evaluator', 'hidden');

  const workDir = await mkdtemp(join(tmpdir(), 'itera-eval-'));
  const fixtureDir = join(workDir, 'fixture');
  const evaluatorHiddenDir = join(workDir, 'evaluator', 'hidden');

  try {
    await cp(sourceFixtureDir, fixtureDir, { recursive: true });

    const fixtureHash = await hashDirectory(fixtureDir);

    // Baseline: fresh fixture, dependencies installed, before the patch is applied.
    // --include=dev is required, not cosmetic: every benchmarks/<scenario>/fixture/package.json
    // lists its own test runner (vitest) as a devDependency, and this process runs with
    // NODE_ENV=production in the deployed API image (apps/api/Dockerfile) — npm's default
    // omit-devDependencies-under-production-env behavior silently skipped installing vitest
    // there, so `npx vitest run` below then failed with ERR_MODULE_NOT_FOUND. Caught during the
    // first real PreparePage test (Tainan Fidelis, Discord #web3, 2026-10-12): that failure never
    // surfaced as an error either, because runPublicTests/runHiddenTests catch a failed report
    // parse and silently fall back to an empty suite (0/0/0) instead of recording it — a real
    // grading run was coming back `pass` (score > 0 from non-test components) with every test
    // count at zero, not an obvious infra_error. Fixing that silent fallback is a separate,
    // bigger change (deciding how "fail" vs "infra_error" should distinguish a zero-case suite
    // from a real empty one) — out of scope for this immediate fix.
    const install = await run('npm', ['install', '--include=dev'], fixtureDir);
    if (install.code !== 0) errors.push(`npm install failed: ${install.stderr.slice(0, 500)}`);

    await writeFile(join(fixtureDir, '.gitignore'), 'node_modules/\n', 'utf-8');
    await run('git', ['init', '-q'], fixtureDir);
    await run('git', ['add', '-A'], fixtureDir);
    await run('git', ['-c', 'user.email=evaluator@itera.local', '-c', 'user.name=itera-evaluator', 'commit', '-q', '-m', 'baseline'], fixtureDir);

    const baselineReport = join(workDir, 'public-baseline.json');
    const publicBaseline = await runPublicTests(fixtureDir, baselineReport);
    const baselinePassingNames = new Set(publicBaseline.cases.filter((c) => c.passed).map((c) => c.name));

    // Freeze the patch.
    const patchHash = createHash('sha256').update(options.patch).digest('hex');
    const patchFile = join(workDir, 'patch.diff');
    await writeFile(patchFile, options.patch, 'utf-8');

    // --index stages the patch as part of applying it (including files it creates). A plain
    // `git apply` without --index leaves new files untracked, and `git diff --name-only` only
    // compares tracked content — so a patch that creates tests/evil.test.ts (or edits a
    // gitignored path like node_modules/) applied cleanly but never showed up as a changed file,
    // bypassing checkPatchScope entirely. `git diff --cached` after a staged apply sees it.
    const apply = await run('git', ['apply', '--whitespace=nowarn', '--index', patchFile], fixtureDir);
    if (apply.code !== 0) {
      errors.push(`patch did not apply: ${apply.stderr.slice(0, 500)}`);
    }

    const diffNameOnly = await run('git', ['diff', '--cached', '--name-only'], fixtureDir);
    const changedFiles = diffNameOnly.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const patchScope = checkPatchScope(changedFiles);

    const afterReport = join(workDir, 'public-after-patch.json');
    const publicAfterPatch =
      apply.code === 0 ? await runPublicTests(fixtureDir, afterReport) : EMPTY_SUITE;

    const regressionCandidates = publicAfterPatch.cases.filter((c) => baselinePassingNames.has(c.name));
    const regressionRatio =
      baselinePassingNames.size === 0
        ? 1
        : regressionCandidates.filter((c) => c.passed).length / baselinePassingNames.size;

    // Mount the hidden tests only now that the patch is frozen.
    await mkdir(evaluatorHiddenDir, { recursive: true });
    const hiddenSourceStat = await stat(sourceHiddenDir).catch(() => null);
    if (!hiddenSourceStat) {
      errors.push(`no hidden tests found at ${sourceHiddenDir}`);
    } else {
      await cp(sourceHiddenDir, evaluatorHiddenDir, { recursive: true, filter: (src) => !src.endsWith('README.md') });
    }

    const hiddenReport = join(workDir, 'hidden.json');
    const hidden = apply.code === 0 ? await runHiddenTests(fixtureDir, hiddenReport) : EMPTY_SUITE;

    const score = computeScore({
      publicAfterPatch,
      hidden,
      regressionRatio,
      patchScopeAllowed: patchScope.allowed,
      runCompletedWithoutErrors: errors.length === 0,
    });

    const manifest: EvidenceManifest = {
      schema_version: '0.1.0',
      evaluator_version: EVALUATOR_VERSION,
      scenario_id: options.scenarioId,
      generated_at: new Date().toISOString(),
      fixture_hash: fixtureHash,
      patch_hash: patchHash,
      patch_scope: { changed_files: changedFiles, ...patchScope },
      tests: {
        public_baseline: publicBaseline,
        public_after_patch: publicAfterPatch,
        hidden,
      },
      score,
      errors,
    };

    return manifest;
  } finally {
    if (!options.keepWorkspace) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

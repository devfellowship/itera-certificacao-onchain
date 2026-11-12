// Tests of `tma eval case|run|grade|diff` (plan C3 T3). Docker never runs: the agent run and the grader
// are fakes. git is real (the workspace input and the line diff).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { EvidenceManifest } from '../../../../evaluator/src/types.js';
import { EVALUATOR_VERSION } from '../../../../evaluator/src/runner.js';
import type { AgentRunResult } from '../../agent-run.js';
import { defaultSandboxConfig } from '../../sandbox.js';
import { sandboxEnv } from '../env.js';
import { caseErrors, loadCaseFolder } from '../eval/case.js';
import { codeDiff, jsonDiff, markdownSections, patchFiles } from '../eval/diff.js';
import { caseVerdict, type GraderResult } from '../eval/graders.js';
import type { EvalDeps } from '../eval/runs.js';
import { variantErrors } from '../eval/variant.js';
import { captureIo } from '../test/fixtures.js';
import type { Command } from '../command.js';
import { CliError } from '../env.js';
import { makeEvalCommand as makeRaw } from './eval.js';

/** As tma.ts runs a command: a CliError is exit 1 with its message on stderr. */
function makeEvalCommand(deps?: EvalDeps): Command {
  const cmd = makeRaw(deps);
  return {
    ...cmd,
    main: async (argv, io) => {
      try {
        return await cmd.main(argv, io);
      } catch (e) {
        if (!(e instanceof CliError)) throw e;
        io.err(e.message);
        return 1;
      }
    },
  };
}

const FIXTURE = join(import.meta.dirname, '..', 'test', 'task-fixture');
const EXAMPLE = join(import.meta.dirname, '..', '..', '..', 'examples', 'eval', 'tsk_webhook_dup');
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const KEY = 'test-key-not-real';
const PATCH = 'diff --git a/lib/add.js b/lib/add.js\n--- a/lib/add.js\n+++ b/lib/add.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n';

const made: string[] = [];
const tmp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `tma-eval-${name}-`));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function manifest(over: { hiddenPassed?: number; total?: number } = {}): EvidenceManifest {
  const hidden = { total: 4, passed: over.hiddenPassed ?? 4, failed: 4 - (over.hiddenPassed ?? 4), state: 'ok' };
  const suite = { total: 3, passed: 3, failed: 0, state: 'ok' };
  return {
    score: { total: over.total ?? 100, public_behavior: 20, hidden_behavior: 50, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5 },
    patch_scope: { allowed: true },
    tests: { public_baseline: { ...suite, passed: 1, failed: 2 }, public_after_patch: suite, hidden },
    errors: [],
    environment: { executor: { image_id: IMAGE_ID } },
  } as unknown as EvidenceManifest;
}

function fakes(over: Partial<EvalDeps> = {}) {
  const graded: string[] = [];
  const agentKeys: string[] = [];
  const deps: EvalDeps = {
    env: { OPENROUTER_API_KEY: KEY },
    grade: async (o) => {
      graded.push(o.patch);
      return manifest();
    },
    runAgent: async (o) => {
      agentKeys.push(o.modelKey);
      return { patch: PATCH, timedOut: false, costCapped: false, durationMs: 9000, actions: [{ tool: 'edit' }], agentErrors: [], usage: { steps: 2, inputTokens: 10, outputTokens: 5, costUsd: 0 } } as unknown as AgentRunResult;
    },
    sandbox: async (profile) => ({ config: defaultSandboxConfig(sandboxEnv(profile, {})), imageId: IMAGE_ID }),
    now: (() => {
      let t = Date.parse('2026-11-12T18:00:00Z');
      return () => new Date((t += 60_000));
    })(),
    ...over,
  };
  return { deps, graded, agentKeys };
}

const caseManifest = (over: Record<string, unknown> = {}) => ({
  schema: 'tma-case/1',
  case_key: 'tiny-add',
  use_case: 'fix/red-ci',
  mode: 'replay',
  answer_shape: 'single',
  pin: null,
  task_ref: { kind: 'tma-task', id: 'task-fixture@3' },
  expected: { text: 'add() returns the sum; the hidden check passes.', written_by: 'claude-main', written_at: '2026-11-12T18:00:00Z' },
  graders: [{ id: 'hidden-tests', version: EVALUATOR_VERSION, weight: 1, hard_gate: true }],
  split: 'none',
  source: 'synthetic',
  ...over,
});

function writeJson(path: string, v: unknown): string {
  writeFileSync(path, `${JSON.stringify(v, null, 2)}\n`);
  return path;
}

/** A case folder of the tiny fixture task, built by `tma eval case`. */
async function builtCase(over: Record<string, unknown> = {}, extra: string[] = []): Promise<{ dir: string; src: string }> {
  const src = tmp('src');
  const caseFile = writeJson(join(src, 'case.json'), caseManifest(over));
  const dir = join(tmp('case'), 'c');
  const io = captureIo();
  const code = await makeEvalCommand().main(['case', '--case', caseFile, '--dest', dir, '--task-dir', FIXTURE, ...extra], io);
  expect(code, io.errText()).toBe(0);
  return { dir, src };
}

function variant(src: string, name: string, v: Record<string, unknown>): string {
  return writeJson(join(src, `${name}.variant.json`), { schema: 'tma-variant/1', label: name, change_kind: 'none', is_baseline: true, prediction: null, ...v });
}

const variantDirs = (caseDir: string) => readdirSync(join(caseDir, 'runs')).map((d) => join(caseDir, 'runs', d));
const runFolders = (vdir: string) => readdirSync(vdir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(vdir, e.name));

describe('tma-case/1 validation', () => {
  it('accepts the example case and the L1 pair', () => {
    expect(caseErrors(JSON.parse(readFileSync(join(EXAMPLE, 'case.json'), 'utf-8')))).toEqual([]);
    expect(caseErrors(caseManifest())).toEqual([]);
  });
  it('refuses an L2 key as the use case, an outcome, an unknown key, a trace without a pin', () => {
    expect(caseErrors(caseManifest({ use_case: 'webhook-reliability' })).join()).toMatch(/L1 pair/);
    expect(caseErrors(caseManifest({ task_summary: { before: 'a', expected: 'b', outcome: 'c' } })).join()).toMatch(/outcome: refused/);
    expect(caseErrors(caseManifest({ transcript: 'x' })).join()).toMatch(/transcript: unknown key/);
    expect(caseErrors(caseManifest({ source: 'trace' })).join()).toMatch(/pin: required/);
    expect(caseErrors(caseManifest({ graders: [{ id: 'hidden-tests', version: '1.0.0', weight: 1, hard_gate: true }, { id: 'hidden-tests', version: '2.0.0', weight: 1, hard_gate: true }] })).join()).toMatch(/listed twice/);
  });
  it('case_key: one rule with tma-local-result/2 (no dot, 3 to 63 characters)', () => {
    for (const ok of ['abc', 'tiny-add', 'webhook_dup-replay', 'a' + 'b'.repeat(62)]) expect(caseErrors(caseManifest({ case_key: ok })), ok).toEqual([]);
    for (const bad of ['ab', 'webhook.dup', 'a' + 'b'.repeat(63), '-abc', 'Abc']) expect(caseErrors(caseManifest({ case_key: bad })).join(), bad).toMatch(/case_key/);
  });
  it('a variant: a baseline has no prediction, any other variant has one', () => {
    const base = { schema: 'tma-variant/1', label: 'x', kind: 'patch', patch: null, change_kind: 'none' };
    expect(variantErrors({ ...base, is_baseline: true, prediction: null })).toEqual([]);
    expect(variantErrors({ ...base, is_baseline: false, prediction: null }).join()).toMatch(/prediction/);
    expect(variantErrors({ ...base, is_baseline: true, prediction: 'x' }).join()).toMatch(/no prediction/);
    expect(variantErrors({ ...base, is_baseline: true, prediction: null, env: { OPENROUTER_API_KEY: 'x' } }).join()).toMatch(/env: unknown key/);
  });
});

describe('tma eval case', () => {
  it('writes the manifest copy, the lock and the agent-visible input (no hidden tests, no solution)', async () => {
    const { dir } = await builtCase();
    const lock = JSON.parse(readFileSync(join(dir, 'case.lock.json'), 'utf-8'));
    expect(lock.format).toBe('tma-eval-case/1');
    expect(lock.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.task.ref).toBe('task-fixture@3');
    expect(lock.input.kind).toBe('bundle-workspace');
    expect(existsSync(join(dir, 'input', 'INSTRUCTION.md'))).toBe(true);
    expect(existsSync(join(dir, 'input', 'tests', 'hidden'))).toBe(false);
    expect(JSON.stringify(readdirSync(join(dir, 'input'), { recursive: true }))).not.toContain('solution');
  });
  it('refuses a version mismatch, a replay with a partial pin, a trace_review without a recorded output', async () => {
    const src = tmp('bad');
    const run = async (m: Record<string, unknown>, extra: string[] = []) => {
      const io = captureIo();
      const code = await makeEvalCommand().main(['case', '--case', writeJson(join(src, `c${Math.random()}.json`), caseManifest(m)), '--dest', join(tmp('d'), 'c'), '--task-dir', FIXTURE, ...extra], io);
      return { code, err: io.errText() };
    };
    expect((await run({ task_ref: { kind: 'tma-task', id: 'task-fixture@4' } })).err).toMatch(/version 3/);
    expect((await run({ pin: { pin_sha256: 'a'.repeat(64), record: { schema: 'tma-pin/1', session_id: 's' } } })).err).toMatch(/not a full tma-pin\/1/);
    expect((await run({ mode: 'trace_review' })).err).toMatch(/--recorded/);
  });
  it('a case folder whose manifest changed is refused', async () => {
    const { dir } = await builtCase();
    writeJson(join(dir, 'case.json'), caseManifest({ expected: { text: 'changed', written_by: 'x', written_at: '2026-11-12T18:00:00Z' } }));
    await expect(loadCaseFolder(dir)).rejects.toThrow(/changed after/);
  });
});

describe('tma eval run', () => {
  it('the reference patch scores 100 on each of 3 runs; the empty variant fails the hard gate (score 0)', async () => {
    const { dir, src } = await builtCase();
    const solution = join(src, 'solution.patch');
    writeFileSync(solution, PATCH);
    const { deps, graded } = fakes();
    const cmd = makeEvalCommand(deps);

    const io = captureIo();
    expect(await cmd.main(['run', '--case', dir, '--variant', variant(src, 'solution', { kind: 'patch', patch: 'solution.patch' }), '--repeat', '3'], io), io.errText()).toBe(0);
    expect(graded).toEqual([PATCH, PATCH, PATCH]);
    expect(io.outText()).toMatch(/n 3, measured 3, passed 3, mean score 100/);

    const io2 = captureIo();
    const empty = variant(src, 'empty', { kind: 'patch', patch: null, is_baseline: false, prediction: 'No change: the hidden check stays red.' });
    expect(await cmd.main(['run', '--case', dir, '--variant', empty, '--repeat', '3'], io2), io2.errText()).toBe(0);
    expect(io2.outText()).toMatch(/n 3, measured 3, passed 0, mean score 0/);

    const [a, b] = variantDirs(dir).map((d) => JSON.parse(readFileSync(join(d, 'summary.json'), 'utf-8')));
    const base = [a, b].find((s) => s.is_baseline)!;
    const other = [a, b].find((s) => !s.is_baseline)!;
    expect(base.runs.map((r: { score: number }) => r.score)).toEqual([100, 100, 100]);
    expect(other.runs.map((r: { pass: boolean }) => r.pass)).toEqual([false, false, false]);
    const grades = JSON.parse(readFileSync(join(runFolders(variantDirs(dir).find((d) => d.endsWith(base.variant_sha256.slice(0, 12)))!)[0]!, 'grades.json'), 'utf-8'));
    const g: GraderResult = grades.gradings[0].graders[0];
    expect(g).toMatchObject({ id: 'hidden-tests', version: EVALUATOR_VERSION, kind: 'code', pass: true, score: 100, infra_ok: true, decisive: true, hard_gate: true });
    expect(g.code_sha256).toMatch(/^[0-9a-f]{64}$/);
    // The prediction is on the host, next to the output, before the runs.
    const otherDir = variantDirs(dir).find((d) => d.endsWith(other.variant_sha256.slice(0, 12)))!;
    expect(readFileSync(join(otherDir, 'prediction.md'), 'utf-8')).toContain('stays red');
  });

  it('refuses a changed prediction after the first run, and a variant that has none', async () => {
    const { dir, src } = await builtCase();
    const { deps } = fakes();
    const cmd = makeEvalCommand(deps);
    const v = variant(src, 'e', { kind: 'patch', patch: null, is_baseline: false, prediction: 'first' });
    expect(await cmd.main(['run', '--case', dir, '--variant', v], captureIo())).toBe(0);
    variant(src, 'e', { kind: 'patch', patch: null, is_baseline: false, prediction: 'second' });
    const io = captureIo();
    expect(await cmd.main(['run', '--case', dir, '--variant', v], io)).toBe(1);
    expect(io.errText()).toMatch(/prediction of this variant changed/);
    const io2 = captureIo();
    expect(await cmd.main(['run', '--case', dir, '--variant', variant(src, 'n', { kind: 'patch', patch: null, is_baseline: false })], io2)).toBe(1);
    expect(io2.errText()).toMatch(/write what you expect/);
  });

  it('a grader version that this kit does not have is "not measured", never a pass or a fail (exit 1)', async () => {
    const { dir, src } = await builtCase({ graders: [{ id: 'hidden-tests', version: '2.0.0', weight: 1, hard_gate: true }] });
    const { deps, graded } = fakes();
    const io = captureIo();
    expect(await makeEvalCommand(deps).main(['run', '--case', dir, '--variant', variant(src, 's', { kind: 'patch', patch: null })], io)).toBe(1);
    expect(graded).toEqual([]);
    expect(io.outText()).toMatch(/not measured/);
    const g = JSON.parse(readFileSync(join(runFolders(variantDirs(dir)[0]!)[0]!, 'grades.json'), 'utf-8')).gradings[0].graders[0];
    expect(g.reason).toMatch(/version_unavailable/);
  });

  it('an agent variant runs in the sandbox with the user key, which never reaches a file', async () => {
    const { dir, src } = await builtCase();
    mkdirSync(join(src, 'agent'));
    writeFileSync(join(src, 'agent', 'AGENTS.md'), '# agent\n');
    const agentKeys: string[] = [];
    const { deps, graded } = fakes({
      runAgent: async (o) => (agentKeys.push(o.modelKey), { patch: `${PATCH}// ${o.modelKey}\n`, timedOut: false, costCapped: false, durationMs: 9000, actions: [{ tool: 'edit', input: { k: o.modelKey } }], agentErrors: [], usage: { steps: 2, inputTokens: 10, outputTokens: 5, costUsd: 0 } }) as unknown as AgentRunResult,
    });
    const v = variant(src, 'agent', { kind: 'agent', agent: { agent_dir: 'agent', model: 'anthropic/claude-sonnet-4.5' }, change_kind: 'rules', is_baseline: false, prediction: 'Same pass rate.' });
    expect(await makeEvalCommand(deps).main(['run', '--case', dir, '--variant', v, '--repeat', '2'], captureIo())).toBe(0);
    expect(agentKeys).toEqual([KEY, KEY]);
    expect(graded).toHaveLength(2);
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.json') || f.endsWith('.diff') || f.endsWith('.md'));
    for (const f of files) expect(readFileSync(join(dir, f), 'utf-8')).not.toContain(KEY);
  });

  it('a sandbox failure is "not measured", not a fail', async () => {
    const { dir, src } = await builtCase();
    mkdirSync(join(src, 'agent'));
    writeFileSync(join(src, 'agent', 'AGENTS.md'), '# agent\n');
    const { deps, graded } = fakes({ runAgent: async () => Promise.reject(new Error('docker died')) });
    const v = variant(src, 'agent', { kind: 'agent', agent: { agent_dir: 'agent', model: 'anthropic/claude-sonnet-4.5' }, change_kind: 'rules', is_baseline: false, prediction: 'x' });
    const io = captureIo();
    expect(await makeEvalCommand(deps).main(['run', '--case', dir, '--variant', v], io)).toBe(1);
    expect(graded).toEqual([]);
    expect(io.outText()).toMatch(/not measured/);
  });
});

describe('tma eval grade', () => {
  it('a re-grade ADDS a grading to each run; the old one stays', async () => {
    const { dir, src } = await builtCase();
    const { deps } = fakes();
    const cmd = makeEvalCommand(deps);
    expect(await cmd.main(['run', '--case', dir, '--variant', variant(src, 's', { kind: 'patch', patch: null }), '--repeat', '2'], captureIo())).toBe(0);
    expect(await cmd.main(['grade', '--case', dir], captureIo())).toBe(0);
    for (const r of runFolders(variantDirs(dir)[0]!)) expect(JSON.parse(readFileSync(join(r, 'grades.json'), 'utf-8')).gradings).toHaveLength(2);
  });

  it('a trace_review case grades its recorded output (linked, not copied)', async () => {
    const rec = join(tmp('rec'), 'out.diff');
    writeFileSync(rec, PATCH);
    const { dir } = await builtCase({ mode: 'trace_review', answer_shape: 'open' }, ['--recorded', rec]);
    const { deps, graded } = fakes();
    const io = captureIo();
    expect(await makeEvalCommand(deps).main(['grade', '--case', dir], io), io.errText()).toBe(0);
    expect(graded).toEqual([PATCH]);
    expect(io.outText()).toMatch(/passed 1, mean score 100/);
    const io2 = captureIo();
    expect(await makeEvalCommand(deps).main(['run', '--case', dir, '--variant', join(EXAMPLE, 'solution.variant.json')], io2)).toBe(1);
    expect(io2.errText()).toMatch(/trace_review case: it runs nothing/);
  });
});

describe('tma eval diff', () => {
  it('compares two variant folders: the score table, the prediction and the code diff', async () => {
    const { dir, src } = await builtCase();
    const { deps } = fakes();
    const cmd = makeEvalCommand(deps);
    writeFileSync(join(src, 'sol.patch'), PATCH);
    await cmd.main(['run', '--case', dir, '--variant', variant(src, 'base', { kind: 'patch', patch: 'sol.patch' })], captureIo());
    await cmd.main(['run', '--case', dir, '--variant', variant(src, 'empty', { kind: 'patch', patch: null, is_baseline: false, prediction: 'It fails.' })], captureIo());
    const sums = variantDirs(dir).map((d) => ({ d, s: JSON.parse(readFileSync(join(d, 'summary.json'), 'utf-8')) }));
    const base = sums.find((x) => x.s.is_baseline)!.d;
    const other = sums.find((x) => !x.s.is_baseline)!.d;
    const io = captureIo();
    expect(await cmd.main(['diff', base, other], io)).toBe(0);
    expect(io.outText()).toMatch(/delta mean score -100/);
    expect(io.outText()).toContain('It fails.');
    expect(io.outText()).toContain('only in baseline: lib/add.js');
  });

  it('diffs files by data type', async () => {
    const d = tmp('files');
    const a = writeJson(join(d, 'a.json'), { score: 1, tools: ['read'], keep: true });
    const b = writeJson(join(d, 'b.json'), { score: 2, tools: ['read', 'edit'], keep: true });
    const io = captureIo();
    expect(await makeEvalCommand().main(['diff', a, b], io)).toBe(0);
    expect(io.outText()).toContain('json diff');
    expect(io.outText()).toContain('~ /score: 1 -> 2');
    expect(io.outText()).toContain('+ /tools/1: "edit"');
    writeFileSync(join(d, 'a.md'), '# Plan\nintro\n## Steps\none\n');
    writeFileSync(join(d, 'b.md'), '# Plan\nintro\n## Steps\ntwo\n## Risks\nnone\n');
    const io2 = captureIo();
    expect(await makeEvalCommand().main(['diff', join(d, 'a.md'), join(d, 'b.md')], io2)).toBe(0);
    expect(io2.outText()).toMatch(/~ section ## Steps[\s\S]*\+ section ## Risks/);
    expect(io2.outText()).toContain('+two');
  });

  it('splits patches with and without git headers, and diffs them per file', async () => {
    const bare = '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/src/y.ts\n+++ b/src/y.ts\n@@ -1 +1 @@\n-c\n+d\n';
    expect([...patchFiles(bare).keys()]).toEqual(['src/x.ts', 'src/y.ts']);
    expect([...patchFiles(PATCH).keys()]).toEqual(['lib/add.js']);
    const other = '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+B\n';
    const out = await codeDiff(bare, other);
    expect(out).toContain('changed:          src/x.ts');
    expect(out).toContain('only in baseline: src/y.ts');
    expect(out).toMatch(/-\+b\n\+\+B/);
  });

  it('the JSON tree diff and the Markdown sections are pure functions', () => {
    expect(jsonDiff({ a: { b: 1 } }, { a: { b: 1 } })).toEqual([]);
    expect(jsonDiff({ a: 1 }, {})).toEqual(['- /a: 1']);
    expect([...markdownSections('top\n# A\nx\n# A\ny').keys()]).toEqual(['(top)', '# A', '# A (2)']);
  });
});

describe('the case verdict', () => {
  const r = (over: Partial<GraderResult>): GraderResult => ({ id: 'g', version: '1.0.0', code_sha256: 'a'.repeat(64), kind: 'code', pass: true, score: 100, weight: 1, hard_gate: false, decisive: true, infra_ok: true, reason: null, ...over });
  it('weighted mean of the decisive graders; a failed hard gate is 0; one unmeasured grader = not measured', () => {
    expect(caseVerdict([r({ score: 100, weight: 3 }), r({ id: 'h', score: 50, weight: 1, pass: false })])).toEqual({ infra_ok: true, pass: false, score: 88 });
    expect(caseVerdict([r({ hard_gate: true, pass: false, score: 70 }), r({ id: 'h' })])).toEqual({ infra_ok: true, pass: false, score: 0 });
    expect(caseVerdict([r({}), r({ id: 'h', infra_ok: false, score: null })])).toEqual({ infra_ok: false, pass: false, score: null });
    expect(caseVerdict([r({ decisive: false, kind: 'judge' })])).toEqual({ infra_ok: true, pass: false, score: null });
  });
});

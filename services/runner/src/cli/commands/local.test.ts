// Tests of `tma tasks | workspace | grade | run` (task L6). Docker never runs: the agent run and the
// grader are fakes (LocalDeps). git is real: the patch comes from a real diff against a fresh baseline.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseLocalResultText, validateLocalResult } from '@itera/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import type { EvidenceManifest } from '../../../../evaluator/src/types.js';
import { checkPatchScope } from '../../../../evaluator/src/patch-scope.js';
import type { AgentRunResult } from '../../agent-run.js';
import { defaultSandboxConfig } from '../../sandbox.js';
import { CliError, sandboxEnv } from '../env.js';
import { materializeLocalWorkspace, workspacePatch, type LocalDeps } from '../local.js';
import { loadResolved } from '../tasks.js';
import { captureIo } from '../test/fixtures.js';
import { runOnceArgs } from '../../run-once.js';
import { makeGradeCommand } from './grade.js';
import { makeRunCommand } from './run.js';
import { tasksCommand } from './tasks.js';
import { workspaceCommand } from './workspace.js';

const FIXTURE = join(import.meta.dirname, '..', 'test', 'task-fixture');
const KEY = 'test-key-not-real';
const AGENT = '0b6f3c2e-1d4a-4c8e-9f00-123456789abc';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const PATCH = 'diff --git a/lib/add.js b/lib/add.js\n--- a/lib/add.js\n+++ b/lib/add.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n';

const made: string[] = [];
const tmp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `tma-l6-${name}-`));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** Every file under dir (relative, sorted), skipping nothing. */
function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else out.push(relative(dir, join(d, e.name)));
    }
  };
  walk(dir);
  return out.sort();
}

/** A graded manifest with just the fields that finalStatus, the score and the result row read. */
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

function agentResult(over: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    scenarioId: 'task-fixture',
    model: 'anthropic/claude-sonnet-4.5',
    agentFiles: ['AGENTS.md'],
    timedOut: false,
    exitCode: 0,
    durationMs: 12_500,
    actions: [{ tool: 'edit', input: { path: 'lib/add.js', secret: 'A-PROMPT-THAT-MUST-STAY-LOCAL' } }],
    usage: { steps: 3, inputTokens: 900, outputTokens: 100, costUsd: 0 },
    modelUsage: { costUsd: 0.0123, tokensIn: 1000, tokensOut: 200, calls: 3, refused: 0, maxCostUsd: 0.5, capStopped: false, costSource: 'metered', rateLimited: 0, rateLimitedFinal: 0, effectiveModels: {}, providers: {}, requestedModels: {}, params: null },
    route: 'openrouter',
    costCapped: false,
    agentErrors: [],
    patch: PATCH,
    ...over,
  } as unknown as AgentRunResult;
}

interface Seen {
  agentKeys: string[];
  graded: string[];
}

function fakes(over: Partial<LocalDeps> = {}, seen: Seen = { agentKeys: [], graded: [] }): { deps: LocalDeps; seen: Seen } {
  const deps: LocalDeps = {
    env: { OPENROUTER_API_KEY: KEY, OPENCODE_GO_API_KEY: KEY },
    runAgent: async (o) => {
      seen.agentKeys.push(o.modelKey);
      return agentResult();
    },
    grade: async (o) => {
      seen.graded.push(o.patch);
      return manifest();
    },
    sandbox: async (profile) => ({ config: defaultSandboxConfig(sandboxEnv(profile, {})), imageId: IMAGE_ID }),
    now: (() => {
      let t = Date.parse('2026-10-26T12:00:00Z');
      return () => new Date((t += 60_000));
    })(),
    ...over,
  };
  return { deps, seen };
}

function runArgs(extra: string[] = []): { argv: string[]; out: string; runs: string } {
  const dir = tmp('out');
  const agentDir = join(dir, 'agent');
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, 'AGENTS.md'), '# agent\n');
  const out = join(dir, 'result.json');
  const runs = join(dir, 'tma-runs');
  return { argv: ['--task-dir', FIXTURE, '--agent', AGENT, '--agent-dir', agentDir, '--model', 'anthropic/claude-sonnet-4.5', '--out', out, '--runs-dir', runs, ...extra], out, runs };
}

describe('tma tasks', () => {
  it('lists the curated tasks of the bundle, offline, one line each', async () => {
    const io = captureIo();
    expect(await tasksCommand.main([], io)).toBe(0);
    const lines = io.outText().split('\n');
    const line = lines.find((l) => l.startsWith('webhook-ledger'));
    expect(line).toMatch(/^webhook-ledger\s+v1\s+/);
    expect(lines.find((l) => l.startsWith('dfl-fleet-research'))).toContain('hosted only');
    expect(lines.every((l) => l.trim() !== '')).toBe(true);
  });

  it('--json is a list of slug and version', async () => {
    const io = captureIo();
    await tasksCommand.main(['--json'], io);
    const list = JSON.parse(io.outText()) as Array<{ slug: string; version: string; hosted_only: boolean }>;
    expect(list.find((t) => t.slug === 'webhook-ledger')).toMatchObject({ version: '1', hosted_only: false });
  });
});

describe('tma workspace', () => {
  it('writes the public workspace: no hidden test, no solution; the instruction is INSTRUCTION.md', async () => {
    const dest = join(tmp('ws'), 'w');
    const io = captureIo();
    expect(await workspaceCommand.main(['--task-dir', FIXTURE, '--dest', dest], io)).toBe(0);
    const listing = files(dest);
    expect(listing).toEqual(['.gitignore', 'INSTRUCTION.md', 'README.md', 'lib/add.js', 'tests/public/public-check.txt']);
    expect(listing.some((f) => /hidden|solution/.test(f))).toBe(false);
    const everything = listing.map((f) => readFileSync(join(dest, f), 'utf-8')).join('\n');
    expect(everything).not.toContain('HIDDEN-CANARY');
    expect(everything).not.toContain('SOLUTION-CANARY');
    expect(readFileSync(join(dest, 'INSTRUCTION.md'), 'utf-8')).toContain('return the sum');
  });

  it('works for a curated task with --task, and refuses a folder that is not empty', async () => {
    const dest = join(tmp('ws'), 'w');
    expect(await workspaceCommand.main(['--task', 'webhook-ledger', '--dest', dest], captureIo())).toBe(0);
    expect(files(dest)).toContain('tests/public/public.test.ts');
    expect(files(dest).some((f) => f.startsWith('tests/hidden') || f.startsWith('solution'))).toBe(false);
    await expect(workspaceCommand.main(['--task', 'webhook-ledger', '--dest', dest], captureIo())).rejects.toThrow(/not empty/);
  });

  it('user errors are CliError: no task, both task flags, an unknown task, a folder without task.json', async () => {
    const dest = join(tmp('ws'), 'w');
    for (const argv of [['--dest', dest], ['--task', 'webhook-ledger', '--task-dir', FIXTURE, '--dest', dest], ['--task', 'no-such-task', '--dest', dest], ['--task-dir', tmpdir(), '--dest', dest], ['--task', 'webhook-ledger']]) {
      await expect(workspaceCommand.main(argv, captureIo())).rejects.toBeInstanceOf(CliError);
    }
  });
});

describe('tma run — a result that validates, with the Docker parts faked', () => {
  it('writes result.json that passes the contract validator, and the negative proof fails', async () => {
    const { argv, out, runs } = runArgs();
    const { deps, seen } = fakes();
    const io = captureIo();
    expect(await makeRunCommand(deps).main(argv, io)).toBe(0);

    const text = readFileSync(out, 'utf-8');
    const checked = parseLocalResultText(text);
    expect(checked.ok).toBe(true);
    const result = JSON.parse(text);
    expect(result.format).toBe('tma-local-result/1');
    expect(result.agent_id).toBe(AGENT);
    expect(result.task.local.slug).toBe('tiny-fixture');
    expect(result.runner).toEqual({ version: expect.stringMatching(/^\d+\.\d+\.\d+$/), execution: 'tma-sandbox', profile: 'opencode', sandbox_image_id: IMAGE_ID });
    expect(result.executor).toMatchObject({ model_id: 'anthropic/claude-sonnet-4.5', route: 'openrouter', harness: 'opencode', cost_source: 'metered' });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ status: 'pass', score: 100, wall_s: 12.5, cost_usd: 0.0123, tokens_in: 1000, tokens_out: 200, error_class: null });
    expect(result.summary).toMatchObject({ runs: 1, items: 1, score: 100, pass_rate: 1 });
    expect(seen.graded).toEqual([PATCH]);

    // The evidence stays on this machine, and only there.
    const [runId] = readdirSync(runs);
    expect(readFileSync(join(runs, runId!, 'patch.diff'), 'utf-8')).toBe(PATCH);
    expect(readFileSync(join(runs, runId!, 'run.json'), 'utf-8')).toContain('A-PROMPT-THAT-MUST-STAY-LOCAL');
    expect(text).not.toContain('A-PROMPT-THAT-MUST-STAY-LOCAL');
    expect(text).not.toContain('diff --git');

    // The table: one row per run, then the mean.
    expect(io.outText()).toMatch(/status\s+score\s+public\s+hidden\s+regress\s+scope\s+evidence\s+wall_s\s+cost_usd\s+cost_src\s+error/);
    expect(io.outText()).toMatch(/^mean\s+1 run\(s\)\s+100/m);

    // Negative proof: an extra `actions` key in a run, and a top-level `patch`, fail the validator.
    const mutated = structuredClone(result);
    mutated.runs[0].actions = [{ tool: 'edit' }];
    const bad = validateLocalResult(mutated);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/runs/0/actions' }));
    expect(validateLocalResult({ ...result, patch: PATCH }).ok).toBe(false);
  });

  it('--task names the task by its catalog slug and the integer version', async () => {
    const { argv, out } = runArgs();
    const i = argv.indexOf('--task-dir');
    argv.splice(i, 2, '--task', 'webhook-ledger');
    expect(await makeRunCommand(fakes().deps).main(argv, captureIo())).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf-8')).task).toEqual({ catalog: { slug: 'webhook-ledger', version: 1 } });
  });

  it('--repeat: 1 and 10 give that many rows; 0, 11, abc and 2.5 are refused before any run', async () => {
    for (const n of [1, 10]) {
      const { argv, out } = runArgs(['--repeat', String(n)]);
      expect(await makeRunCommand(fakes().deps).main(argv, captureIo())).toBe(0);
      const result = JSON.parse(readFileSync(out, 'utf-8'));
      expect(result.runs.map((r: { repeat: number }) => r.repeat)).toEqual(Array.from({ length: n }, (_, k) => k + 1));
      expect(result.summary.runs).toBe(n);
    }
    for (const bad of ['0', '11', 'abc', '2.5', '-1', '']) {
      const { argv } = runArgs(['--repeat', bad]);
      const { deps, seen } = fakes();
      await expect(makeRunCommand(deps).main(argv, captureIo())).rejects.toThrow(/--repeat/);
      expect(seen.agentKeys).toEqual([]);
    }
  });

  it('refuses an unknown profile, a missing key, a bad model id, and an MCP task, each as a CliError', async () => {
    await expect(makeRunCommand(fakes().deps).main(runArgs(['--profile', 'claude-code']).argv, captureIo())).rejects.toThrow(/unknown profile "claude-code".*opencode/);
    const noKey = fakes({ env: {} });
    await expect(makeRunCommand(noKey.deps).main(runArgs().argv, captureIo())).rejects.toThrow(/set OPENROUTER_API_KEY to YOUR own/);
    expect(noKey.seen.agentKeys).toEqual([]);
    const ocGo = fakes({ env: { OPENROUTER_API_KEY: KEY } });
    await expect(makeRunCommand(ocGo.deps).main(runArgs().argv.map((a) => (a === 'anthropic/claude-sonnet-4.5' ? 'opencode-go/glm-5' : a)), captureIo())).rejects.toThrow(/set OPENCODE_GO_API_KEY/);
    await expect(makeRunCommand(fakes().deps).main(runArgs().argv.map((a) => (a === 'anthropic/claude-sonnet-4.5' ? 'Not A Model' : a)), captureIo())).rejects.toThrow(/model id/);
    const mcp = runArgs();
    mcp.argv.splice(mcp.argv.indexOf('--task-dir'), 2, '--task', 'dfl-fleet-research');
    await expect(makeRunCommand(fakes().deps).main(mcp.argv, captureIo())).rejects.toThrow(/MCP.*hosted/);
  });

  it('the key reaches the run, and appears nowhere else: not in result.json, stdout, stderr or the runs folder', async () => {
    const { argv, out, runs } = runArgs(['--repeat', '2']);
    const { deps, seen } = fakes();
    const io = captureIo();
    await makeRunCommand(deps).main(argv, io);
    expect(seen.agentKeys).toEqual([KEY, KEY]);
    const everywhere = [readFileSync(out, 'utf-8'), io.outText(), io.errText(), ...readdirSync(runs).flatMap((id) => readdirSync(join(runs, id)).map((f) => readFileSync(join(runs, id, f), 'utf-8')))];
    for (const text of everywhere) expect(text).not.toContain(KEY);
  });

  it('a sandbox failure that echoes the key is redacted; the run is an infra_error, exit code 1, result still valid', async () => {
    const { argv, out, runs } = runArgs();
    const { deps } = fakes({
      runAgent: async (o) => {
        throw new Error(`docker said: unauthorized for key ${o.modelKey}`);
      },
    });
    const io = captureIo();
    expect(await makeRunCommand(deps).main(argv, io)).toBe(1);
    const text = readFileSync(out, 'utf-8');
    expect(parseLocalResultText(text).ok).toBe(true);
    expect(JSON.parse(text).runs[0]).toMatchObject({ status: 'infra_error', score: 0, error_class: 'infra_error', parts: null });
    expect(io.errText()).toContain('[key]');
    const all = [text, io.outText(), io.errText(), ...readdirSync(runs).flatMap((id) => readdirSync(join(runs, id)).map((f) => readFileSync(join(runs, id, f), 'utf-8')))];
    for (const t of all) expect(t).not.toContain(KEY);
  });

  it('a failed grader is an infra_error row, not a crash', async () => {
    const { argv, out } = runArgs();
    const { deps } = fakes({ grade: async () => { throw new Error('grader image missing'); } });
    expect(await makeRunCommand(deps).main(argv, captureIo())).toBe(1);
    expect(JSON.parse(readFileSync(out, 'utf-8')).runs[0].status).toBe('infra_error');
  });

  it('a failing hidden test is a fail with its score, exit code 0; the cost source of a mixed run is derived', async () => {
    const { argv, out } = runArgs(['--repeat', '2']);
    let n = 0;
    const { deps } = fakes({
      grade: async () => manifest({ hiddenPassed: 2, total: 70 }),
      runAgent: async () => agentResult({ modelUsage: { ...agentResult().modelUsage!, costSource: ++n === 1 ? 'metered' : 'derived' } }),
    });
    expect(await makeRunCommand(deps).main(argv, captureIo())).toBe(0);
    const result = JSON.parse(readFileSync(out, 'utf-8'));
    expect(result.runs.map((r: { status: string; score: number }) => [r.status, r.score])).toEqual([['fail', 70], ['fail', 70]]);
    expect(result.executor.cost_source).toBe('derived');
    expect(result.summary).toMatchObject({ pass_rate: 0, score: 70, runs: 2, items: 1 });
  });
});

describe('tma grade — the patch comes from a fresh baseline of the task, never from the workspace', () => {
  async function editedWorkspace(): Promise<string> {
    const dest = join(tmp('grade'), 'w');
    await materializeLocalWorkspace(await loadResolved(FIXTURE), dest, { install: false, installCmd: [], installTimeoutMs: 1000 });
    writeFileSync(join(dest, 'lib', 'add.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
    return dest;
  }
  const patchOf = async (ws: string) => workspacePatch(await loadResolved(FIXTURE), ws);

  it('the patch holds the edit and nothing else (not INSTRUCTION.md, not .gitignore)', async () => {
    const patch = await patchOf(await editedWorkspace());
    expect(patch).toContain('-  return a - b;');
    expect(patch).toContain('+  return a + b;');
    expect([...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1])).toEqual(['lib/add.js']);
  });

  it('a planted .git (directory or file) does not change the patch, even when it commits the edit', async () => {
    const clean = await patchOf(await editedWorkspace());
    const withDir = await editedWorkspace();
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=x', ...a], { cwd, stdio: 'pipe' });
    git(withDir, 'init', '-q');
    git(withDir, 'add', '-A');
    git(withDir, 'commit', '-q', '-m', 'my harness committed the edit, so a diff against MY HEAD would be empty');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: withDir }).toString()).toBe('');
    expect(await patchOf(withDir)).toBe(clean);

    const withFile = await editedWorkspace();
    writeFileSync(join(withFile, '.git'), 'gitdir: /somewhere/else\n');
    expect(await patchOf(withFile)).toBe(clean);
  });

  it('a nested git repository in the workspace is a clear user error, not a stack trace', async () => {
    const ws = await editedWorkspace();
    mkdirSync(join(ws, 'lib', 'vendor'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: join(ws, 'lib', 'vendor') });
    writeFileSync(join(ws, 'lib', 'vendor', 'x.js'), '1');
    await expect(patchOf(ws)).rejects.toThrow(/cannot diff the workspace.*remove that \.git/);
    await expect(patchOf(ws)).rejects.toBeInstanceOf(CliError);
  });

  it('a hidden test file planted in the workspace stays in the patch, so the scope check refuses the run', async () => {
    const clean = await patchOf(await editedWorkspace());
    const ws = await editedWorkspace();
    mkdirSync(join(ws, 'tests', 'hidden'), { recursive: true });
    writeFileSync(join(ws, 'tests', 'hidden', 'hidden-check.txt'), 'HIDDEN-CANARY: add(5, 5) is 10\n');
    const patch = await patchOf(ws);
    expect(patch).not.toBe(clean);
    const changed = [...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]!);
    expect(changed).toContain('tests/hidden/hidden-check.txt');
    const scope = checkPatchScope(changed, (await loadResolved(FIXTURE)).task.scope);
    expect(scope.allowed).toBe(false);
    // And the CLEAN workspace is inside the scope.
    expect(checkPatchScope(['lib/add.js'], (await loadResolved(FIXTURE)).task.scope).allowed).toBe(true);
  });

  it('a changed public test is part of the patch too (protected path), not hidden by the workspace', async () => {
    const ws = await editedWorkspace();
    writeFileSync(join(ws, 'tests', 'public', 'public-check.txt'), 'edited\n');
    expect(await patchOf(ws)).toContain('tests/public/public-check.txt');
  });

  it('grade writes a valid result from the reported wall time and cost, and sends the patch to the grader', async () => {
    const ws = await editedWorkspace();
    const dir = tmp('gradeout');
    const out = join(dir, 'result.json');
    const { deps, seen } = fakes();
    const io = captureIo();
    const argv = ['--task-dir', FIXTURE, '--workspace', ws, '--agent', AGENT, '--model', 'openai/gpt-5', '--wall-s', '95.5', '--cost-usd', '0.42', '--harness', 'my harness', '--out', out, '--runs-dir', join(dir, 'runs')];
    expect(await makeGradeCommand(deps).main(argv, io)).toBe(0);
    const text = readFileSync(out, 'utf-8');
    expect(parseLocalResultText(text).ok).toBe(true);
    const result = JSON.parse(text);
    expect(result.runner).toEqual({ version: expect.any(String), execution: 'external', profile: null, sandbox_image_id: IMAGE_ID });
    expect(result.executor).toMatchObject({ model_id: 'openai/gpt-5', harness: 'my harness', cost_source: 'reported' });
    expect(result.runs[0]).toMatchObject({ status: 'pass', score: 100, wall_s: 95.5, cost_usd: 0.42, tokens_in: null, tokens_out: null });
    expect(seen.graded).toHaveLength(1);
    expect(seen.graded[0]).toContain('+  return a + b;');
    expect(text).not.toContain('return a + b');
    expect(io.outText()).toMatch(/^mean\s+1 run\(s\)/m);
  });

  it('without --wall-s and --cost-usd the result says null and cost_source none; an unchanged workspace is empty_output', async () => {
    const dest = join(tmp('grade'), 'w');
    await materializeLocalWorkspace(await loadResolved(FIXTURE), dest, { install: false, installCmd: [], installTimeoutMs: 1000 });
    const dir = tmp('gradeout');
    const out = join(dir, 'result.json');
    const argv = ['--task-dir', FIXTURE, '--workspace', dest, '--agent', AGENT, '--model', 'openai/gpt-5', '--out', out, '--runs-dir', join(dir, 'runs')];
    expect(await makeGradeCommand(fakes().deps).main(argv, captureIo())).toBe(0);
    const result = JSON.parse(readFileSync(out, 'utf-8'));
    expect(result.executor.cost_source).toBe('none');
    expect(result.runs[0]).toMatchObject({ status: 'fail', wall_s: null, cost_usd: null, error_class: 'empty_output' });
  });

  it('user errors: a missing workspace, a bad agent id, a bad --cost-usd', async () => {
    const base = ['--task-dir', FIXTURE, '--model', 'openai/gpt-5'];
    const ws = await editedWorkspace();
    const { deps } = fakes();
    await expect(makeGradeCommand(deps).main([...base, '--workspace', '/no/such/folder', '--agent', AGENT], captureIo())).rejects.toThrow(/no workspace folder/);
    await expect(makeGradeCommand(deps).main([...base, '--workspace', ws, '--agent', 'not-a-uuid'], captureIo())).rejects.toThrow(/--agent/);
    await expect(makeGradeCommand(deps).main([...base, '--workspace', ws, '--agent', AGENT, '--cost-usd', '-3'], captureIo())).rejects.toThrow(/--cost-usd/);
  });
});

describe('run-once is an alias of tma run', () => {
  it('maps --scenario to --task and fills a placeholder agent id', () => {
    expect(runOnceArgs(['--scenario', 'webhook-ledger', '--agent-dir', 'a', '--model', 'm/x'])).toEqual(['run', '--task', 'webhook-ledger', '--agent-dir', 'a', '--model', 'm/x', '--agent', '00000000-0000-4000-8000-000000000000']);
    expect(runOnceArgs(['--scenario=webhook-ledger', '--agent', AGENT])).toEqual(['run', '--task=webhook-ledger', '--agent', AGENT]);
  });
});

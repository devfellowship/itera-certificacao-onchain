// Tests of the trajectory readers, the redaction module and `tma eval trajectory|upload` (plan C3 T4).
// The marker test: a secret, a prompt sentence and a file body in a Claude Code session never reach the
// record. Docker never runs; the API is a fake fetch.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealPin, validateLocalResultV2, validateTrajectory } from '@itera/contracts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { EvidenceManifest } from '../../../../evaluator/src/types.js';
import { EVALUATOR_VERSION } from '../../../../evaluator/src/runner.js';
import type { AgentRunResult } from '../../agent-run.js';
import { parseOpencodeEvents } from '../../trace.js';
import { defaultSandboxConfig } from '../../sandbox.js';
import type { Command } from '../command.js';
import { CliError, sandboxEnv } from '../env.js';
import { redactCommand, redactTarget, redactUrl } from '../eval/redact.js';
import type { EvalDeps } from '../eval/runs.js';
import { readClaudeCodeSession, trajectoryFromActions } from '../eval/trajectory.js';
import { SESSION_FORMAT, writeSession } from '../session.js';
import { API, captureIo, tempEnv, TOKEN } from '../test/fixtures.js';
import { makeEvalCommand as makeRaw } from './eval.js';

const FIXTURE = join(import.meta.dirname, '..', 'test', 'task-fixture');
const AGENT = '0b6f3c2e-1d4a-4c8e-9f00-123456789abc';
const KEY = 'test-key-not-real';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const PATCH = 'diff --git a/lib/add.js b/lib/add.js\n--- a/lib/add.js\n+++ b/lib/add.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n';
const H = (c: string) => c.repeat(64);

// The markers. None of them may appear in a trajectory or an upload body.
const SECRET = 'sk-MARKERSECRET0123456789abcdef';
const PROMPT = 'MARKER PROMPT please rewrite the ledger so that duplicates are ignored';
const BODY = 'MARKER-FILE-BODY export const ledger = new Map();';
const MARKERS = ['MARKER', SECRET, 'please rewrite', 'ledger = new Map'];

const made: string[] = [];
const tmp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `tma-eval4-${name}-`));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

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

/** A Claude Code session with the three markers in a prompt, a command, a file body and a tool result. */
function session(cwd: string): string {
  const at = (s: number) => `2026-11-12T18:00:${String(s).padStart(2, '0')}.000Z`;
  const lines: unknown[] = [
    { type: 'user', cwd, sessionId: 's1', version: '2.1.87', timestamp: at(0), message: { role: 'user', content: PROMPT } },
    { type: 'assistant', cwd, timestamp: at(1), message: { id: 'msg_1', model: 'claude-x', content: [
      { type: 'text', text: `I will do it: ${PROMPT}` },
      { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: PROMPT, path: `${cwd}/src` } },
      { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: `${cwd}/src/ledger.ts` } },
    ] } },
    { type: 'user', cwd, timestamp: at(3), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: `src/ledger.ts:1:${BODY}` },
      { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: BODY }] },
    ] } },
    { type: 'assistant', cwd, timestamp: at(4), message: { id: 'msg_2', content: [
      { type: 'tool_use', id: 't3', name: 'Write', input: { file_path: `${cwd}/src/ledger.ts`, content: BODY } },
      { type: 'tool_use', id: 't4', name: 'Bash', input: { command: `cd ${cwd} && OPENAI_API_KEY=${SECRET} curl -H "Authorization: Bearer ${SECRET}" https://api.example.test/v1/x?token=${SECRET}`, description: PROMPT } },
      { type: 'tool_use', id: 't5', name: 'WebFetch', input: { url: `https://user:${SECRET}@docs.example.test/a/b?q=${SECRET}#frag`, prompt: PROMPT } },
      { type: 'tool_use', id: 't6', name: 'mcp__dfl__get_plan', input: { slug: PROMPT } },
      { type: 'tool_use', id: 't7', name: 'Task', input: { subagent_type: 'general-purpose', description: PROMPT, prompt: PROMPT } },
    ] } },
    { type: 'user', cwd, timestamp: at(9), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't3', content: 'ok' },
      { type: 'tool_result', tool_use_id: 't4', content: `curl: (6) network unreachable for ${SECRET}`, is_error: true },
      { type: 'tool_result', tool_use_id: 't5', content: 'Permission denied by the user', is_error: true },
      { type: 'tool_result', tool_use_id: 't6', content: JSON.stringify({ body: BODY }) },
    ] } },
    { type: 'assistant', isSidechain: true, cwd, timestamp: at(10), message: { id: 'msg_3', content: [{ type: 'tool_use', id: 't8', name: 'Bash', input: { command: `bash /home/sam/.claude/skills/read-plan/read.sh ${PROMPT}` } }] } },
    { type: 'assistant', cwd, timestamp: at(11), message: { id: 'msg_4', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: `git -C ${cwd} status --short` } }] } },
    'not json at all',
  ];
  return lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
}

const noMarker = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const m of MARKERS) expect(text).not.toContain(m);
};

describe('the redaction module', () => {
  it('keeps the shape and drops the content', () => {
    expect(redactCommand(`cd /w && A=1 git pr view 12 --json x`)).toBe('git pr view');
    expect(redactCommand(`gh pr create --title "${PROMPT}"`)).toBe('gh pr create');
    expect(redactCommand(`curl -H "Authorization: Bearer ${SECRET}" https://x`)).toBe('curl');
    expect(redactCommand('bash /root/.claude/skills/read-plan/read.sh slug')).toBe('bash ~/.claude/skills/read-plan/read.sh slug');
    expect(redactUrl(`https://u:p@h.test/a/${SECRET}?k=v#f`)).toBe('https://h.test/a/<redacted>');
    expect(redactTarget('pattern', PROMPT)).toBe('<pattern>');
    expect(redactTarget('pattern', 'TODO|FIXME')).toBe('TODO_FIXME'); // | is not in the charset
    expect(redactTarget('file', '/home/sam/repo/src/a.ts', { roots: ['/home/sam/repo'] })).toBe('src/a.ts');
    expect(redactTarget('file', '/home/sam/notes/a.md')).toBe('~/notes/a.md');
    expect(redactTarget('file', `/tmp/${'ab12'.repeat(10)}/x`)).toBe('/tmp/<redacted>/x');
    expect(redactTarget('agent', PROMPT)).toBe('<agent>');
    expect(redactTarget('file', `src/${'a'.repeat(300)}.ts`)).toBe('src/<redacted>');
    expect(redactTarget('file', `${'abcdefgh/'.repeat(30)}x.ts`)!.length).toBe(120);
    // A long, ordinary repo path is not a secret.
    expect(redactTarget('file', 'services/runner/src/cli/eval/itera-certificacao-onchain-trajectory-reader.ts')).toBe('services/runner/src/cli/eval/itera-certificacao-onchain-trajectory-reader.ts');
    expect(redactTarget('none', 'x')).toBeNull();
  });
});

describe('the Claude Code reader (marker test)', () => {
  const cwd = '/home/sam/work/repo';
  const { trajectory, skipped } = readClaudeCodeSession(session(cwd));

  it('a secret, a prompt sentence and a file body never reach the record', () => {
    noMarker(trajectory);
    expect(validateTrajectory(trajectory).ok).toBe(true);
    expect(skipped).toBe(0); // the non-JSON line is not counted (it does not start with "{")
  });

  it('one step per tool call, with family, status, class, duration, turn, kind and digests', () => {
    const s = trajectory.steps;
    expect(s.map((x) => x.tool)).toEqual(['Grep', 'Read', 'Write', 'Bash', 'WebFetch', 'mcp__dfl__get_plan', 'Task', 'Bash', 'Bash']);
    expect(s.map((x) => x.tool_family)).toEqual(['builtin', 'builtin', 'builtin', 'shell', 'web', 'mcp', 'agent', 'skill-bash', 'git']);
    expect(s.map((x) => x.turn)).toEqual([1, 1, 2, 2, 2, 2, 2, 3, 4]);
    expect(s.map((x) => x.status)).toEqual(['ok', 'ok', 'ok', 'error', 'denied', 'ok', 'error', 'error', 'error']);
    expect(s[3]!.error_class).toBe('network');
    expect(s[6]!.error_class).toBe('interrupted'); // no result: the session stopped
    expect(s.map((x) => x.target_redacted)).toEqual(['<pattern>', 'src/ledger.ts', 'src/ledger.ts', 'curl', 'https://docs.example.test/a/b', 'dfl', 'general-purpose', 'bash ~/.claude/skills/read-plan/read.sh', 'git']);
    expect(s[1]!.duration_ms).toBe(2000);
    expect(s[7]!.parent_seq).toBe(7); // the side chain under the one open Task call
    expect(s[2]!.args_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s[1]!.result_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tma eval trajectory --from claude-code writes the record', async () => {
    const dir = tmp('cc');
    writeFileSync(join(dir, 's.jsonl'), session(cwd));
    const io = captureIo();
    expect(await makeEvalCommand().main(['trajectory', '--from', 'claude-code', join(dir, 's.jsonl'), '--out', join(dir, 't.json')], io), io.errText()).toBe(0);
    expect(io.outText()).toMatch(/9 steps, turns 4/);
    const t = JSON.parse(readFileSync(join(dir, 't.json'), 'utf-8'));
    expect(validateTrajectory(t).ok).toBe(true);
    noMarker(t);
  });
});

describe('the opencode actions (agent runs of the kit)', () => {
  it('maps the parsed actions and redacts their raw targets', () => {
    const ev = (tool: string, input: Record<string, unknown>, status = 'completed') => JSON.stringify({ type: 'tool_use', timestamp: 1, part: { type: 'tool', tool, state: { status, input, output: BODY, time: { start: 1, end: 5 } } } });
    const text = [JSON.stringify({ type: 'step_start' }), ev('read', { filePath: '/workspace/src/a.ts' }), ev('bash', { command: `curl -H "x: ${SECRET}" https://x` }), ev('grep', { pattern: PROMPT })].join('\n');
    const t = trajectoryFromActions(parseOpencodeEvents(text).actions)!;
    expect(t.steps.map((s) => s.target_redacted)).toEqual(['src/a.ts', 'curl', '<pattern>']);
    noMarker(t);
  });
});

// --- upload ---------------------------------------------------------------------------------------

const pin = sealPin({
  format: 'tma-pin/1',
  repo: 'devfellowship/dfl-example',
  base_sha: 'a'.repeat(40),
  harness: 'claude-code',
  harness_version: '2.1.87',
  harness_repo_sha: 'b'.repeat(40),
  rules_sha256: H('c'),
  skills_sha256: [H('1'), H('2')],
  model_id: 'anthropic/claude-sonnet-4.5',
  mcp_manifest_sha256: H('d'),
  input_sha256: H('f'),
  completeness: { repo: 'exact', base_sha: 'exact', harness: 'exact', harness_version: 'exact', harness_repo_sha: 'derived', rules_sha256: 'derived', skills_sha256: 'derived', model_id: 'exact', mcp_manifest_sha256: 'exact', input_sha256: 'exact' },
});

function manifest(): EvidenceManifest {
  const suite = { total: 3, passed: 3, failed: 0, state: 'ok' };
  return {
    score: { total: 100, public_behavior: 20, hidden_behavior: 50, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5 },
    patch_scope: { allowed: true },
    tests: { public_baseline: { ...suite, passed: 1, failed: 2 }, public_after_patch: suite, hidden: { total: 4, passed: 4, failed: 0, state: 'ok' } },
    errors: [],
    environment: { executor: { image_id: IMAGE_ID } },
  } as unknown as EvidenceManifest;
}

function deps(over: Partial<EvalDeps> = {}): EvalDeps {
  return {
    env: { OPENROUTER_API_KEY: KEY },
    grade: async () => manifest(),
    runAgent: async () => {
      const ev = (tool: string, input: Record<string, unknown>) => JSON.stringify({ type: 'tool_use', timestamp: 1, part: { type: 'tool', tool, state: { status: 'completed', input, output: BODY, time: { start: 1, end: 3 } } } });
      const parsed = parseOpencodeEvents([JSON.stringify({ type: 'step_start' }), ev('read', { filePath: '/workspace/lib/add.js' }), ev('bash', { command: `echo ${SECRET} && npm test` }), ev('edit', { filePath: '/workspace/lib/add.js', newString: BODY })].join('\n'));
      return { patch: PATCH, timedOut: false, costCapped: false, durationMs: 9000, actions: parsed.actions, agentErrors: [], usage: { steps: 2, inputTokens: 10, outputTokens: 5, costUsd: 0.01 } } as unknown as AgentRunResult;
    },
    sandbox: async (profile) => ({ config: defaultSandboxConfig(sandboxEnv(profile, {})), imageId: IMAGE_ID }),
    ...over,
  };
}

async function caseWithRuns(over: Record<string, unknown> = {}, variantOver: Record<string, unknown> = {}, d: EvalDeps = deps()) {
  const src = tmp('src');
  const caseFile = join(src, 'case.json');
  writeFileSync(caseFile, JSON.stringify({
    schema: 'tma-case/1', case_key: 'tiny-add', use_case: 'fix/red-ci', mode: 'replay', answer_shape: 'single', pin: { pin_sha256: pin.pin_sha256, record: pin },
    task_ref: { kind: 'tma-task', id: 'task-fixture@3' },
    expected: { text: 'add() returns the sum.', written_by: 'claude-main', written_at: '2026-11-12T18:00:00Z' },
    graders: [{ id: 'hidden-tests', version: EVALUATOR_VERSION, weight: 1, hard_gate: true }], split: 'none', source: 'trace', ...over,
  }));
  mkdirSync(join(src, 'agent'));
  writeFileSync(join(src, 'agent', 'AGENTS.md'), '# rules\n');
  writeFileSync(join(src, 'v.json'), JSON.stringify({ schema: 'tma-variant/1', label: 'stricter rules', kind: 'agent', agent: { agent_dir: 'agent', model: 'anthropic/claude-sonnet-4.5' }, change_kind: 'rules', is_baseline: false, prediction: PROMPT, ...variantOver }));
  const dir = join(tmp('case'), 'c');
  const cmd = makeEvalCommand(d);
  const io = captureIo();
  expect(await cmd.main(['case', '--case', caseFile, '--dest', dir, '--task-dir', FIXTURE], io), io.errText()).toBe(0);
  const io2 = captureIo();
  expect(await cmd.main(['run', '--case', dir, '--variant', join(src, 'v.json'), '--repeat', '2'], io2), io2.errText()).toBe(0);
  const vdir = join(dir, 'runs', readdirSync(join(dir, 'runs'))[0]!);
  return { dir, vdir, src, cmd };
}

function loggedIn(): NodeJS.ProcessEnv {
  const env = tempEnv();
  writeSession({ format: SESSION_FORMAT, api_url: API, principal: 'dfl:x', session_id: 's', session_token: TOKEN, expires_at: '2099-01-01T00:00:00.000Z' }, env);
  return env;
}

function fakeApi(status = 200, action = 'inserted') {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ evaluation_id: 'e0e0e0e0-1111-4222-8333-444444444444', run_id: 'r', action, url: 'https://web2.test/evaluations/e0' }), { status }),
  );
}

describe('tma eval upload', () => {
  it('an agent run writes its redacted trajectory next to run.json', async () => {
    const { vdir } = await caseWithRuns();
    for (const r of readdirSync(vdir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const t = JSON.parse(readFileSync(join(vdir, r.name, 'trajectory.json'), 'utf-8'));
      expect(validateTrajectory(t).ok).toBe(true);
      expect(t.steps.map((s: { target_redacted: string }) => s.target_redacted)).toEqual(['lib/add.js', 'echo', 'lib/add.js']);
      noMarker(t);
    }
  });

  it('--dry-run builds one valid tma-local-result/2 body, sends it to ?dry_run=1, and no marker leaves', async () => {
    const f = fakeApi();
    const env = loggedIn();
    const { dir, vdir } = await caseWithRuns({}, {}, deps({ env: { ...env, OPENROUTER_API_KEY: KEY }, fetchImpl: f as unknown as typeof fetch }));
    const io = captureIo();
    const code = await makeEvalCommand(deps({ env, fetchImpl: f as unknown as typeof fetch })).main(['upload', '--case', dir, '--variant-dir', vdir, '--agent', AGENT, '--dry-run'], io);
    expect(code, io.errText()).toBe(0);
    expect(io.outText()).toMatch(/dry run OK, it would be inserted/);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/self-declared-results?dry_run=1`);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(init.body));
    expect(validateLocalResultV2(body).ok).toBe(true);
    expect(body.format).toBe('tma-local-result/2');
    expect(body.case).toMatchObject({ case_key: 'tiny-add', use_case_key: 'fix/red-ci', mode: 'replay', origin_pin_sha256: pin.pin_sha256 });
    expect(body.variant).toMatchObject({ label: 'stricter rules', change_kind: 'rules' });
    expect(body.variant.agent).toMatchObject({ harness: 'claude-code', model_id: 'anthropic/claude-sonnet-4.5', rules_sha256: H('c') });
    expect(body.comparison.prediction_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0]).toMatchObject({ status: 'pass', score: 100, infra_ok: true });
    expect(body.runs[0].graders[0]).toMatchObject({ id: 'hidden-tests', semver: EVALUATOR_VERSION, kind: 'code', pass: true, decisive: true });
    expect(body.runs[0].trajectory.steps).toHaveLength(3);
    noMarker(body);
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(JSON.stringify(body)).not.toContain('a + b'); // no patch
  });

  it('refuses a replay case with no pin, a non-baseline control with change_kind none, a missing base agent', async () => {
    const env = loggedIn();
    const run = async (caseOver: Record<string, unknown>, variantOver: Record<string, unknown>) => {
      const { dir, vdir } = await caseWithRuns(caseOver, variantOver, deps({ env: { ...env, OPENROUTER_API_KEY: KEY } }));
      const io = captureIo();
      const code = await makeEvalCommand(deps({ env, fetchImpl: fakeApi() as unknown as typeof fetch })).main(['upload', '--case', dir, '--variant-dir', vdir, '--agent', AGENT, '--dry-run'], io);
      return { code, err: io.errText() };
    };
    expect(await run({ pin: null, source: 'synthetic' }, {})).toMatchObject({ code: 1, err: expect.stringMatching(/needs the origin pin/) });
    expect(await run({}, { change_kind: 'none' })).toMatchObject({ code: 1, err: expect.stringMatching(/names its one diff/) });
  });

  it('a real upload needs a login; the answer is printed', async () => {
    const { dir, vdir } = await caseWithRuns();
    const io = captureIo();
    expect(await makeEvalCommand(deps({ env: tempEnv() })).main(['upload', '--case', dir, '--variant-dir', vdir, '--agent', AGENT], io)).toBe(1);
    expect(io.errText()).toMatch(/login/);
    const f = fakeApi(201);
    const io2 = captureIo();
    expect(await makeEvalCommand(deps({ env: loggedIn(), fetchImpl: f as unknown as typeof fetch })).main(['upload', '--case', dir, '--variant-dir', vdir, '--agent', AGENT], io2), io2.errText()).toBe(0);
    expect(io2.outText()).toMatch(/inserted\. Evaluation e0e0e0e0/);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(`${API}/self-declared-results`);
  });
});

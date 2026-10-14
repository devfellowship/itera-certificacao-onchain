// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateTaskContract } from './index.js';
import { opencodeAgentConfig } from './tool-environment.js';

const ledger = JSON.parse(readFileSync(new URL('../../benchmarks/webhook-ledger/task.json', import.meta.url), 'utf-8'));
const clone = () => structuredClone(ledger);

describe('task.schema.json (Ajv, draft 2020-12)', () => {
  it('accepts the webhook-ledger contract', () => {
    expect(validateTaskContract(ledger)).toMatchObject({ ok: true });
  });
  it('rejects a task.json without verifier.cmd', () => {
    const t = clone();
    delete t.verifier.cmd;
    const r = validateTaskContract(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/cmd/);
  });
  it('accepts verifier.image only as a digest-pinned Itera grader image', () => {
    const ok = clone();
    ok.verifier.image = `ghcr.io/devfellowship/testmyagent-grader-chromium-axe@sha256:${'0'.repeat(64)}`;
    expect(validateTaskContract(ok)).toMatchObject({ ok: true });
    for (const image of ['ghcr.io/devfellowship/testmyagent-grader-chromium-axe:1', `node@sha256:${'0'.repeat(64)}`, '']) {
      const t = clone();
      t.verifier.image = image;
      expect(validateTaskContract(t).ok).toBe(false);
    }
  });
  it('rejects unknown keys, absolute and parent paths, and network', () => {
    for (const edit of [
      (t: any) => (t.extra = 1),
      (t: any) => (t.environment.dir = '/etc'),
      (t: any) => (t.tests.hidden = 'tests/../../x'),
      (t: any) => (t.environment.allow_internet = true),
      (t: any) => (t.verifier.timeout_sec = 9999),
      (t: any) => (t.task.name = 'no-org'),
    ]) {
      const t = clone();
      edit(t);
      expect(validateTaskContract(t).ok).toBe(false);
    }
  });
});

import { isEvidenceManifest, runResult, validateEvidenceManifest } from './index.js';

describe('evidence-manifest.schema.json (the per-run EvalLog)', () => {
  const legacy = {
    scenario_id: 'webhook-ledger',
    patch_hash: 'p',
    patch_scope: { changed_files: [], allowed: true },
    tests: { public_baseline: { total: 1, passed: 1, failed: 0 }, public_after_patch: { total: 1, passed: 1, failed: 0 }, hidden: { total: 1, passed: 0, failed: 1 } },
    score: { total: 70 },
    errors: [],
  };
  it('accepts an old (evaluator 0.1.0) row and refuses a non-graded one', () => {
    expect(isEvidenceManifest(legacy)).toBe(true);
    expect(isEvidenceManifest({ error: 'grading failed' })).toBe(false);
    expect(isEvidenceManifest({ ...legacy, score: { total: '70' } })).toBe(false);
  });
  it('checks the Inspect Score shape: value is a number or null (unscored)', () => {
    const sample = (value: unknown) => ({ ...legacy, samples: [{ id: 't', epoch: 1, input: 'x', target: 'y', scores: { hidden_behavior: { value } } }] });
    expect(validateEvidenceManifest(sample(null)).ok).toBe(true);
    expect(validateEvidenceManifest(sample(50)).ok).toBe(true);
    expect(validateEvidenceManifest(sample('50')).ok).toBe(false);
  });
});

describe('runResult (state kept apart from verdict)', () => {
  it('maps every runs.status', () => {
    expect(runResult('queued')).toEqual({ state: 'queued', verdict: null, scored: false });
    expect(runResult('pass')).toEqual({ state: 'completed', verdict: 'pass', scored: true });
    expect(runResult('timeout')).toEqual({ state: 'timeout', verdict: 'invalid', scored: true });
    expect(runResult('infra_error')).toEqual({ state: 'infra_error', verdict: 'inconclusive', scored: false });
  });
  it('prefers the result the runner wrote in the EvalLog', () => {
    expect(runResult('fail', { result: { state: 'completed', verdict: 'fail', scored: true } })).toEqual({ state: 'completed', verdict: 'fail', scored: true });
  });
});

import { checkCompatibility, parseAgentRequires, toolEnvironment, DEFAULT_TOOL_ENVIRONMENT, OPENCODE_BUILTIN_TOOLS, BUILTIN_TOOLS } from './index.js';

describe('task.schema.json environment block: the tool environment (ADR-11, U28)', () => {
  const withMcp = () => {
    const t = clone();
    t.environment.tools = {
      builtin: ['read', 'edit', 'bash'],
      mcp: [
        { name: 'helpdesk', catalog: 'helpdesk@1', transport: 'http', seed: 'mcp/helpdesk/seed.json', allowed_tools: ['search_tickets', 'issue_refund'], expose_state_to_scorer: true },
        { name: 'postgres', transport: 'http', image: 'ghcr.io/itera/mcp-postgres@sha256:' + 'a'.repeat(64), seed: 'mcp/postgres/seed.sql', allowed_tools: ['query', 'list_tables'], expose_state_to_scorer: true, secrets: ['PG_PASSWORD'] },
        { name: 'http-mock', transport: 'stdio', command: ['node', 'mock.js'], allowed_tools: ['request'] },
      ],
    };
    t.environment.run_egress = ['model-gateway', 'mcp'];
    t.environment.secrets = ['PG_PASSWORD'];
    return t;
  };

  it('webhook-ledger declares built-in tools only', () => {
    expect(ledger.environment.tools.mcp).toEqual([]);
    expect(ledger.environment.run_egress).toEqual(['model-gateway']);
    expect(toolEnvironment(ledger).builtin).toEqual([...BUILTIN_TOOLS]);
  });

  it('accepts a task with catalog, image and command MCP servers', () => {
    expect(validateTaskContract(withMcp())).toMatchObject({ ok: true });
  });

  it('keeps the environment/ dir semantics: old task.json without the new keys still validates and gets the defaults', () => {
    const t = clone();
    for (const k of ['tools', 'run_egress', 'secrets', 'resources']) delete t.environment[k];
    expect(validateTaskContract(t).ok).toBe(true);
    expect(toolEnvironment(t)).toEqual({ ...DEFAULT_TOOL_ENVIRONMENT, builtin: [...BUILTIN_TOOLS], mcp: [], run_egress: ['model-gateway'], secrets: [], resources: {} });
  });

  it('rejects a bad environment block (schema)', () => {
    for (const edit of [
      (t: any) => (t.environment.tools.builtin = ['webfetch']),
      (t: any) => (t.environment.tools.mcp[1].transport = 'sse'),
      (t: any) => delete t.environment.tools.mcp[1].allowed_tools,
      (t: any) => (t.environment.tools.mcp[1].allowed_tools = []),
      (t: any) => (t.environment.tools.mcp[2].image = 'x:1'), // image AND command
      (t: any) => (t.environment.tools.mcp[0].image = 'x:1'), // catalog AND image
      (t: any) => (t.environment.tools.mcp[0].catalog = 'helpdesk'), // no @version
      (t: any) => (t.environment.tools.mcp[0].catalog = 'helpdesk@latest'),
      (t: any) => delete t.environment.tools.mcp[2].command, // neither
      (t: any) => (t.environment.tools.mcp[1].seed = '../etc/passwd'),
      (t: any) => (t.environment.tools.mcp[1].name = 'Bad Name'),
      (t: any) => (t.environment.run_egress = ['mcp']), // no model-gateway
      (t: any) => (t.environment.run_egress = ['model-gateway', 'internet']),
      (t: any) => (t.environment.secrets = ['lower']),
      (t: any) => (t.environment.secrets = { PG_PASSWORD: 'value' }), // names only, never values
      (t: any) => (t.environment.resources = { pids: 1 }),
      (t: any) => (t.environment.tools.extra = true),
    ]) {
      const t = withMcp();
      edit(t);
      expect(validateTaskContract(t).ok, edit.toString()).toBe(false);
    }
  });

  it('rejects what the schema cannot say: duplicate names, servers without mcp egress, undeclared secret, seed outside mcp/<name>/', () => {
    const cases: Array<[(t: any) => void, RegExp]> = [
      [(t) => (t.environment.tools.mcp[2].name = 'postgres'), /declared twice/],
      [(t) => (t.environment.run_egress = ['model-gateway']), /run_egress needs "mcp"/],
      [(t) => (t.environment.secrets = []), /PG_PASSWORD is not declared/],
      [(t) => (t.environment.tools.mcp[1].seed = 'environment/seed.sql'), /must be under mcp\/postgres\//],
      [(t) => (t.environment.tools.mcp[0].seed = 'mcp/postgres/seed.json'), /must be under mcp\/helpdesk\//],
    ];
    for (const [edit, re] of cases) {
      const t = withMcp();
      edit(t);
      const r = validateTaskContract(t);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join(' ')).toMatch(re);
    }
    const t = clone();
    t.environment.run_egress = ['model-gateway', 'mcp'];
    expect(validateTaskContract(t).ok).toBe(false); // mcp egress without a server
  });

  it('maps every neutral built-in tool to opencode names', () => {
    expect(Object.keys(OPENCODE_BUILTIN_TOOLS).sort()).toEqual([...BUILTIN_TOOLS].sort());
  });
});

describe('opencodeAgentConfig (shared by the runner and the task editor preview, U31)', () => {
  const endpoint = (name: string) => ({ url: `http://mcp-${name}:8080/mcp`, token: 'T' });
  it('writes one remote entry per server and switches off the built-in tools the task does not allow', () => {
    expect(opencodeAgentConfig([{ name: 'helpdesk' }], ['read', 'edit', 'bash', 'search'], endpoint)).toEqual({
      mcp: { helpdesk: { type: 'remote', url: 'http://mcp-helpdesk:8080/mcp', headers: { Authorization: 'Bearer T' }, enabled: true } },
      tools: { write: false, list: false, todowrite: false, todoread: false },
    });
  });
  it('is empty when every built-in tool is allowed and there is no server', () => {
    expect(opencodeAgentConfig([], BUILTIN_TOOLS, endpoint)).toEqual({});
  });
});

describe('agent requires + compatibility (U28)', () => {
  it('normalizes the chip field: bare name = mcp:<name>, lower case, de-duplicated', () => {
    expect(parseAgentRequires(['Postgres', 'mcp:postgres', 'tool:bash'])).toEqual({ ok: true, value: ['mcp:postgres', 'tool:bash'] });
    expect(parseAgentRequires([]).ok).toBe(true);
    expect(parseAgentRequires('postgres').ok).toBe(false);
    expect(parseAgentRequires(['tool:webfetch']).ok).toBe(false);
    expect(parseAgentRequires(['skill:x']).ok).toBe(false);
    expect(parseAgentRequires(Array.from({ length: 21 }, (_, i) => `s${i}`)).ok).toBe(false);
  });

  it('webhook-ledger (built-in only) is compatible with no requirement and with tool:bash, not with an MCP requirement', () => {
    const env = toolEnvironment(ledger);
    expect(checkCompatibility(env, [])).toEqual({ compatible: true, reasons: [] });
    expect(checkCompatibility(env, ['tool:bash']).compatible).toBe(true);
    const r = checkCompatibility(env, ['mcp:postgres', 'tool:bash']);
    expect(r.compatible).toBe(false);
    expect(r.reasons).toEqual([expect.objectContaining({ code: 'missing_mcp_server', requirement: 'mcp:postgres' })]);
  });

  it('a requirement may name the catalog server (name of name@version)', () => {
    const t = clone();
    t.environment.tools.mcp = [{ name: 'support', catalog: 'helpdesk@1', transport: 'http', allowed_tools: ['search_tickets'] }];
    t.environment.run_egress = ['model-gateway', 'mcp'];
    expect(validateTaskContract(t).ok).toBe(true);
    expect(checkCompatibility(toolEnvironment(t), ['mcp:helpdesk', 'mcp:support']).compatible).toBe(true);
  });

  it('a task that restricts built-ins refuses an agent that requires a missing one', () => {
    const t = clone();
    t.environment.tools.builtin = ['read', 'edit'];
    const r = checkCompatibility(toolEnvironment(t), ['tool:bash']);
    expect(r).toMatchObject({ compatible: false, reasons: [{ code: 'missing_builtin_tool', requirement: 'tool:bash' }] });
  });
});

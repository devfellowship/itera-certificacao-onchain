// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// tma-local-result/2, /3, tma-trajectory/1 and /2 (plan 20261112-tma-c4-result-store-trajectory-upload, T1, T8, T9-T11).
import { describe, expect, it } from 'vitest';
import {
  EMPTY_DIFF_SHA256,
  LOCAL_RESULT_MAX_BYTES,
  LOCAL_RESULT_V2_MAX_BYTES,
  LOCAL_RESULT_V2_MAX_RUNS,
  TRAJECTORY_MAX_STEPS,
  agentVersionSha256,
  localResultSchema,
  localResultV2Schema,
  localResultV3Schema,
  parseAnyLocalResultText,
  parseLocalResultText,
  trajectorySchema,
  trajectoryV2Schema,
  validateAnyLocalResult,
  validateLocalResult,
  validateLocalResultV2,
  validateLocalResultV3,
  validateTrajectory,
} from './index.js';

// Synthetic fixtures: invented numbers and hashes only.
const H = (c: string) => c.repeat(64);
const AGENT = '0b6f3c2e-1d4a-4c8e-9f00-123456789abc';

const v1Base = (over: Record<string, unknown> = {}): Record<string, any> => ({
  format: 'tma-local-result/1',
  agent_id: AGENT,
  task: { catalog: { slug: 'tsk_webhook_dup', version: 1 } },
  grader_version: '1.1.0',
  runner: { version: '0.1.0', execution: 'tma-sandbox', profile: 'opencode', sandbox_image_id: `sha256:${H('d')}` },
  executor: { model_id: 'openrouter/deepseek/deepseek-v4.1-flash', provider: 'deepseek', route: 'openrouter', harness: 'opencode 1.18.31', variant: null, cost_source: 'metered' },
  ran_from: '2026-11-12T12:00:00Z',
  ran_to: '2026-11-12T12:20:00Z',
  ...over,
});

const v1Run = (repeat: number, score: number) => ({
  item_sha256: H('a'), repeat, status: score === 100 ? 'pass' : 'fail', score, wall_s: 212, cost_usd: 0.031, tokens_in: 51234, tokens_out: 3120, error_class: null,
  parts: { public_behavior: 20, hidden_behavior: score === 100 ? 50 : 30, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5 },
});
const v1 = () => v1Base({ metrics_shape: 'tma-score/1', summary: { score: 90, runs: 2, items: 1 }, runs: [v1Run(1, 100), v1Run(2, 80)] });

const step = (seq: number, over: Record<string, unknown> = {}): Record<string, any> => ({
  seq, parent_seq: null, turn: seq, tool: 'Edit', tool_family: 'builtin', status: 'ok', error_class: null,
  duration_ms: 120, tokens_in: 900, tokens_out: 80, target_kind: 'file', target_redacted: 'src/webhook/handler.ts',
  args_sha256: H('b'), result_sha256: H('c'), retry_of: null, ...over,
});
const traj = (steps: Record<string, any>[] = [
  step(1, { tool: 'Bash', tool_family: 'git', target_kind: 'repo', target_redacted: 'devfellowship/dfl-infra' }),
  step(2),
  step(3, { tool: 'Bash', tool_family: 'shell', status: 'error', error_class: 'tool_error', target_kind: 'command', target_redacted: 'npm test <args>' }),
  step(4, { tool: 'Bash', tool_family: 'shell', target_kind: 'command', target_redacted: 'npm test <args>', retry_of: 3 }),
  step(5, { tool: 'mcp__dfl__get_plan', tool_family: 'mcp', target_kind: 'mcp', target_redacted: 'mcp__dfl__get_plan', parent_seq: 4 }),
  step(6, { tool: 'TodoWrite', target_kind: 'none', target_redacted: null, args_sha256: null, result_sha256: null }),
]) => ({ format: 'tma-trajectory/1', steps });

const grader = (over: Record<string, unknown> = {}) => ({
  id: 'hidden-tests', semver: '2.0.0', code_sha256: H('f'), kind: 'code', pass: true, score: 100, weight: 1, hard_gate: true, decisive: true, ...over,
});
const v2Run = (repeat: number, score: number, over: Record<string, unknown> = {}) => ({
  ...v1Run(repeat, score), infra_ok: true, graders: [grader({ pass: score === 100, score })], trajectory: traj(), ...over,
});
const MODEL = 'openrouter/deepseek/deepseek-v4.1-flash';
const agentV = (over: Record<string, unknown> = {}): Record<string, any> => ({
  harness: 'claude-code', harness_version: '2.1.87', harness_repo_sha: '0'.repeat(39) + '1', model_id: MODEL,
  rules_sha256: H('6'), skills_sha256: H('7'), mcp_manifest_sha256: H('8'), tools_sha256: H('9'), ...over,
});
const v2 = (over: Record<string, unknown> = {}): Record<string, any> =>
  v1Base({
    format: 'tma-local-result/2',
    metrics_shape: 'tma-score/1',
    case: { case_key: 'webhook-dup-001', manifest_sha256: H('1'), origin_pin_sha256: H('2'), mode: 'replay', use_case_key: 'fix/prod-bug' },
    variant: { agent: agentV(), variant_sha256: H('3'), label: 'skill v2 (shorter brief)', change_kind: 'skill' },
    comparison: { is_baseline: false, prediction_sha256: H('4') },
    summary: { score: 90, runs: 2, items: 1 },
    runs: [v2Run(1, 100), v2Run(2, 80)],
    ...over,
  });

const issuesV2 = (v: unknown) => {
  const r = validateLocalResultV2(v);
  return r.ok ? [] : r.issues;
};
/** tma-local-result/3 (plan ADR-3: a new field needs /3): the /2 fixture with the /3 format. */
const v3 = (over: Record<string, unknown> = {}): Record<string, any> => v2({ format: 'tma-local-result/3', ...over });
const issuesV3 = (v: unknown) => {
  const r = validateLocalResultV3(v);
  return r.ok ? [] : r.issues;
};

describe('tma-local-result/2 — accepted bodies', () => {
  it('accepts a v2 result, and the same value comes back after JSON text', () => {
    const value = v2();
    const r = parseAnyLocalResultText(JSON.stringify(value));
    expect(r.ok ? [] : r.errors).toEqual([]);
    expect(r.format).toBe('tma-local-result/2');
    if (r.ok) expect(r.value).toEqual(value);
  });
  it('accepts a baseline, a run with no trajectory and no graders, and an infra fault', () => {
    const value = v2({
      variant: { agent: agentV({ harness_version: null, harness_repo_sha: null, rules_sha256: null, skills_sha256: null, mcp_manifest_sha256: null, tools_sha256: null }), variant_sha256: EMPTY_DIFF_SHA256, label: 'baseline', change_kind: 'none' },
      comparison: { is_baseline: true, prediction_sha256: null },
      case: { case_key: 'webhook-dup-001', manifest_sha256: H('1'), origin_pin_sha256: null, mode: 'trace_review', use_case_key: 'fix' },
      runs: [v2Run(1, 100, { trajectory: null }), { ...v2Run(2, 0, { graders: [], trajectory: null, infra_ok: false }), status: 'infra_error', error_class: 'infra_error' }],
    });
    expect(issuesV2(value)).toEqual([]);
  });
  it('accepts the transcript-mining and trajectory shapes with the v2 run fields', () => {
    const run = {
      item_sha256: H('e'), kind: 'subagent', repeat: 1, present: true,
      checks: Object.fromEntries(['schema', 'intents_closed', 'risk_floor', 'speaker', 'outcome_consistent', 'class_match', 'risk_match', 'intent_agreement', 'corrections'].map((k) => [k, true])),
      metrics: { class_match: 1, risk_match: 0.5, intent_agreement: 0.75, corrections: null, corrections_recall: null, corrections_precision: null, class_type: true, class_subtype: null },
      score: 88, wall_s: 30, cost_usd: null, tokens_in: null, tokens_out: null, error_class: null,
      infra_ok: true, graders: [grader({ id: 'trajectory-rule', semver: '1.0.0', score: 88 })], trajectory: traj(),
    };
    const value = v2({
      metrics_shape: 'trajectory/1',
      task: { catalog: { slug: 'dfl-session-decision-trajectory-extraction', version: 2 } },
      summary: {
        score: 88, runs: 1, items: 1, gate_pass_rate: 1, check_pass_rate: 1, mean_score_when_gates_pass: 88,
        gate_fail_schema: 0, gate_fail_intents_closed: 0, gate_fail_risk_floor: 0, gate_fail_speaker: 0, gate_fail_outcome_consistent: 0,
        metric_class_match: 1, metric_risk_match: 0.5, metric_intent_agreement: 0.75, metric_corrections: null,
        time_per_task_s: 30, items_per_hour: 120, cost_per_task_usd: null, cost_total_usd: null, tokens_in_total: null, tokens_out_total: null, errors: 0,
      },
      runs: [run],
    });
    expect(issuesV2(value)).toEqual([]);
    // The same run without the v2 fields is a v1 run: v2 refuses it.
    const { infra_ok: _i, graders: _g, trajectory: _t, ...v1Only } = run;
    expect(issuesV2({ ...value, runs: [v1Only] })).toContainEqual(expect.objectContaining({ path: '/runs/0' }));
  });
});

describe('tma-local-result/1 stays accepted', () => {
  it('validates a v1 body unchanged, through the v1 and the any-version entry points', () => {
    const value = v1();
    expect(validateLocalResult(value).ok).toBe(true);
    const r = parseAnyLocalResultText(JSON.stringify(value));
    expect(r.format).toBe('tma-local-result/1');
    expect(r.ok ? [] : r.errors).toEqual([]);
    expect(parseLocalResultText(JSON.stringify(value)).ok).toBe(true);
  });
  it('the v1 validator refuses a v2 body, so a v1-only reader never stores a v2 body as v1', () => {
    expect(validateLocalResult(v2()).ok).toBe(false);
  });
  it('a v1 body keeps its 1 MiB limit through the any-version parser', () => {
    const big = JSON.stringify({ ...v1(), pad: 'x'.repeat(LOCAL_RESULT_MAX_BYTES) });
    const r = parseAnyLocalResultText(big);
    expect(r.ok ? null : r.issues[0]?.code).toBe('too_large');
  });
  it('a body with no known format is checked as v1', () => {
    const r = validateAnyLocalResult({ format: 'tma-local-result/9' });
    expect(r.format).toBe('tma-local-result/1');
    expect(r.ok).toBe(false);
  });
});

describe('tma-local-result/2 — closed: no text field (Q-T9 = A, plan ADR-3)', () => {
  it('refuses an extra key at the top, in the case, in the variant, in a grader and in a step', () => {
    expect(issuesV2({ ...v2(), extra: 1 })).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/extra' }));
    const c = v2(); c.case.note = 'x';
    expect(issuesV2(c)).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/case/note' }));
    const va = v2(); va.variant.description = 'x';
    expect(issuesV2(va)).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/variant/description' }));
    const g = v2(); g.runs[0].graders[0].reason = 'x';
    expect(issuesV2(g)).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/runs/0/graders/0/reason' }));
    const s = v2(); s.runs[0].trajectory.steps[0].command = 'cat .env';
    expect(issuesV2(s)).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/runs/0/trajectory/steps/0/command' }));
  });
  it('refuses a prompt key at every level', () => {
    const top = { ...v2(), prompt: 'Fix the bug' };
    expect(issuesV2(top)).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/prompt' }));
    const run = v2(); run.runs[0].prompt = 'Fix the bug';
    expect(issuesV2(run)).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/runs/0/prompt' }));
    const st = v2(); st.runs[1].trajectory.steps[2].prompt = 'Fix the bug';
    expect(issuesV2(st)).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/runs/1/trajectory/steps/2/prompt' }));
    for (const key of ['args', 'input', 'output', 'result', 'stdout', 'messages', 'answer']) {
      const v = v2(); v.runs[0].trajectory.steps[0][key] = 'x';
      expect(issuesV2(v), key).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: `/runs/0/trajectory/steps/0/${key}` }));
    }
  });
  it('refuses a target_redacted of 121 characters, and accepts 120', () => {
    const long = v2(); long.runs[0].trajectory.steps[1].target_redacted = 'a'.repeat(121);
    expect(issuesV2(long)).toContainEqual(expect.objectContaining({ code: 'invalid', path: '/runs/0/trajectory/steps/1/target_redacted' }));
    const max = v2(); max.runs[0].trajectory.steps[1].target_redacted = 'a'.repeat(120);
    expect(issuesV2(max)).toEqual([]);
  });
  it('refuses a newline in label, and a label of 61 characters', () => {
    const nl = v2(); nl.variant.label = 'line one\nline two';
    expect(issuesV2(nl)).toContainEqual(expect.objectContaining({ code: 'invalid', path: '/variant/label' }));
    const long = v2(); long.variant.label = 'x'.repeat(61);
    expect(issuesV2(long)).toContainEqual(expect.objectContaining({ path: '/variant/label' }));
  });
  it('refuses free text in a target: a newline, a quote, a $ and a semicolon', () => {
    for (const bad of ['a\nb', 'echo "x"', 'echo $TOKEN', 'a; rm -rf /', 'a | b', 'a && b', '`id`', '{"k":1}']) {
      const v = v2(); v.runs[0].trajectory.steps[1].target_redacted = bad;
      expect(issuesV2(v), bad).toContainEqual(expect.objectContaining({ path: '/runs/0/trajectory/steps/1/target_redacted' }));
    }
  });
  it('has no property for logs, a patch, a prompt, an answer, arguments or a key in any schema', () => {
    const forbidden = /^(actions?|events?|patch|diff|stdout|stderr|logs?|messages?|prompt|answer|output|outcome|transcript|content|text|args|arguments|input|key|api_key|token|secret|command|reason|rationale|comment|note)$/;
    // The ONE allowed exception (plan T11): the grader version note, at most 60 characters of the label charset,
    // the same bound as variant.label. Its bound is asserted below.
    const allowed = new Set(['/$defs/grader/properties/note']);
    for (const schema of [localResultV2Schema, localResultV3Schema, trajectorySchema, trajectoryV2Schema]) {
      const names: string[] = [];
      const walk = (node: unknown, at: string): void => {
        if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${at}/${i}`));
        if (!node || typeof node !== 'object') return;
        const o = node as Record<string, unknown>;
        if (o.properties && typeof o.properties === 'object') {
          for (const k of Object.keys(o.properties)) if (!allowed.has(`${at}/properties/${k}`)) names.push(k);
        }
        for (const [k, v] of Object.entries(o)) walk(v, `${at}/${k}`);
      };
      walk(schema, '');
      expect(names.length).toBeGreaterThan(10);
      expect(names.filter((n) => forbidden.test(n))).toEqual([]);
    }
    expect((localResultV2Schema as any).$defs.grader.properties.note).toBeUndefined();
    const note = (localResultV3Schema as any).$defs.grader.properties.note;
    const label = (localResultV3Schema as any).properties.variant.properties.label;
    expect(note.maxLength).toBe(60);
    expect(note.pattern).toBe(label.pattern);
  });
  it('every string in either schema has a length limit (or is an enum or a const)', () => {
    const unbounded: string[] = [];
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${at}/${i}`));
      if (!node || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      const types = Array.isArray(o.type) ? o.type : [o.type];
      if (types.includes('string') && typeof o.maxLength !== 'number') unbounded.push(at);
      for (const [k, v] of Object.entries(o)) walk(v, `${at}/${k}`);
    };
    walk(localResultV2Schema, '');
    walk(localResultV3Schema, '');
    walk(trajectorySchema, '');
    walk(trajectoryV2Schema, '');
    expect(unbounded).toEqual([]);
  });
});

describe('tma-local-result/2 — caps', () => {
  it('refuses 51 runs and accepts 50', () => {
    const runs = Array.from({ length: LOCAL_RESULT_V2_MAX_RUNS }, (_, i) => v2Run(i + 1, 80, { trajectory: null }));
    expect(issuesV2(v2({ summary: { score: 80, runs: 50, items: 1 }, runs }))).toEqual([]);
    const over = [...runs, v2Run(51, 80, { trajectory: null })];
    expect(issuesV2(v2({ summary: { score: 80, runs: 51, items: 1 }, runs: over }))).toContainEqual(expect.objectContaining({ path: '/runs' }));
    expect(LOCAL_RESULT_V2_MAX_RUNS).toBe(50);
  });
  it('refuses 2,001 steps in one run and accepts 2,000', () => {
    const steps = Array.from({ length: TRAJECTORY_MAX_STEPS }, (_, i) => step(i + 1));
    const ok = v2(); ok.runs[0].trajectory = traj(steps);
    expect(issuesV2(ok)).toEqual([]);
    const over = v2(); over.runs[0].trajectory = traj([...steps, step(2001)]);
    expect(issuesV2(over).length).toBeGreaterThan(0);
  });
  it('refuses a body above 4 MiB before it parses it', () => {
    const big = JSON.stringify({ ...v2(), pad: 'x'.repeat(LOCAL_RESULT_V2_MAX_BYTES) });
    const r = parseAnyLocalResultText(big);
    expect(r.ok ? null : r.issues[0]).toMatchObject({ code: 'too_large', path: '/' });
    expect(LOCAL_RESULT_V2_MAX_BYTES).toBe(4 * 1_048_576);
  });
  it('a v2 body between 1 MiB and 4 MiB is accepted', () => {
    const steps = Array.from({ length: 2000 }, (_, i) => step(i + 1, { target_redacted: `src/${'a'.repeat(100)}/${i}.ts` }));
    const runs = Array.from({ length: 3 }, (_, i) => v2Run(i + 1, 80, { trajectory: traj(steps) }));
    const text = JSON.stringify(v2({ summary: { score: 80, runs: 3, items: 1 }, runs }));
    const bytes = Buffer.byteLength(text);
    expect(bytes).toBeGreaterThan(LOCAL_RESULT_MAX_BYTES);
    expect(bytes).toBeLessThan(LOCAL_RESULT_V2_MAX_BYTES);
    const r = parseAnyLocalResultText(text);
    expect(r.ok ? [] : r.errors).toEqual([]);
  });
});

describe('tma-local-result/2 — the rules a schema cannot say', () => {
  it('the baseline has change_kind none and no prediction; another variant has a prediction', () => {
    const b = v2(); b.comparison.is_baseline = true;
    expect(issuesV2(b)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'inconsistent', path: '/variant/change_kind' }),
      expect.objectContaining({ code: 'inconsistent', path: '/comparison/prediction_sha256' }),
    ]));
    const n = v2(); n.comparison.prediction_sha256 = null;
    expect(issuesV2(n)).toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/comparison/prediction_sha256' }));
  });
  it('a base agent with no diff (change_kind none) may run off-baseline, with a prediction and the empty diff digest', () => {
    const v = v2(); v.variant.change_kind = 'none'; v.variant.variant_sha256 = EMPTY_DIFF_SHA256;
    expect(issuesV2(v)).toEqual([]);
    const bad = v2(); bad.variant.change_kind = 'none';
    expect(issuesV2(bad)).toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/variant/variant_sha256' }));
  });
  it('the executor ran the base model, unless the one diff is the model', () => {
    const other = v2(); other.variant.agent.model_id = 'zai/glm-5.3';
    expect(issuesV2(other)).toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/executor/model_id' }));
    const m = v2(); m.variant.change_kind = 'model'; m.variant.agent.model_id = 'zai/glm-5.3';
    expect(issuesV2(m)).toEqual([]);
    const same = v2(); same.variant.change_kind = 'model';
    expect(issuesV2(same)).toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/executor/model_id' }));
  });
  it('accepts every change kind of ADR-26 and refuses an unknown one', () => {
    for (const k of ['prompt', 'rules', 'skill', 'retrieval', 'memory', 'tools', 'mcp', 'permissions', 'orchestration', 'limits', 'harness']) {
      const v = v2(); v.variant.change_kind = k;
      expect(issuesV2(v), k).toEqual([]);
    }
    const u = v2(); u.variant.change_kind = 'vibes';
    expect(issuesV2(u)).toContainEqual(expect.objectContaining({ path: '/variant/change_kind' }));
  });
  it('the variant holds no case and the case holds no agent: binding keys are refused', () => {
    const a = v2(); a.case.model_id = MODEL;
    expect(issuesV2(a)).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/case/model_id' }));
    const b = v2(); b.variant.case_key = 'webhook-dup-001';
    expect(issuesV2(b)).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/variant/case_key' }));
    const c = v2(); c.variant.is_baseline = false;
    expect(issuesV2(c)).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/variant/is_baseline' }));
    const d = v2(); d.variant.agent.system_prompt = 'x';
    expect(issuesV2(d)).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/variant/agent/system_prompt' }));
  });
  it('agentVersionSha256 is stable, order-free and changes with any agent field', () => {
    const a = agentV();
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as any;
    expect(agentVersionSha256(a as any)).toMatch(/^[0-9a-f]{64}$/);
    expect(agentVersionSha256(reordered)).toBe(agentVersionSha256(a as any));
    for (const k of Object.keys(a)) {
      const changed = { ...a, [k]: k === 'harness' ? 'codex' : k === 'model_id' ? 'zai/glm-5.3' : null };
      expect(agentVersionSha256(changed as any), k).not.toBe(agentVersionSha256(a as any));
    }
  });
  it('a replay case has an origin pin', () => {
    const v = v2(); v.case.origin_pin_sha256 = null;
    expect(issuesV2(v)).toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/case/origin_pin_sha256' }));
  });
  it('refuses a repeated run, a repeated grader, and infra_ok true on an infra_error run', () => {
    expect(issuesV2(v2({ runs: [v2Run(1, 100), v2Run(1, 80)] }))).toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/runs/1/repeat' }));
    const g = v2(); g.runs[0].graders.push(grader({ semver: '2.0.1' }));
    expect(issuesV2(g)).toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/runs/0/graders/1/id' }));
    const inf = v2(); inf.runs[0].status = 'infra_error';
    expect(issuesV2(inf)).toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/runs/0/infra_ok' }));
  });
  it('keeps the v1 rules: summary.runs and ran_from', () => {
    expect(issuesV2(v2({ summary: { score: 90, runs: 3, items: 1 } }))).toContainEqual(expect.objectContaining({ path: '/summary/runs' }));
  });
  it('refuses a case key, a use case key and a grader id outside their patterns', () => {
    const c = v2(); c.case.case_key = 'Webhook Dup';
    expect(issuesV2(c)).toContainEqual(expect.objectContaining({ path: '/case/case_key' }));
    const u = v2(); u.case.use_case_key = 'fix/red-ci/extra';
    expect(issuesV2(u)).toContainEqual(expect.objectContaining({ path: '/case/use_case_key' }));
    const g = v2(); g.runs[0].graders[0].id = 'Hidden Tests';
    expect(issuesV2(g)).toContainEqual(expect.objectContaining({ path: '/runs/0/graders/0/id' }));
  });
});

describe('tma-trajectory/1 — the step rules', () => {
  const tIssues = (v: unknown) => {
    const r = validateTrajectory(v);
    return r.ok ? [] : r.issues;
  };
  it('accepts the fixture and an empty step list', () => {
    expect(tIssues(traj())).toEqual([]);
    expect(tIssues(traj([]))).toEqual([]);
  });
  it('seq is 1..n in order', () => {
    expect(tIssues(traj([step(1), step(3)]))).toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/steps/1/seq' }));
  });
  it('parent_seq and retry_of point to an earlier step', () => {
    expect(tIssues(traj([step(1, { parent_seq: 1 })]))).toContainEqual(expect.objectContaining({ path: '/steps/0/parent_seq' }));
    expect(tIssues(traj([step(1), step(2, { retry_of: 3 })]))).toContainEqual(expect.objectContaining({ path: '/steps/1/retry_of' }));
  });
  it('an ok step has no error class; a failed step has one', () => {
    expect(tIssues(traj([step(1, { error_class: 'timeout' })]))).toContainEqual(expect.objectContaining({ path: '/steps/0/error_class' }));
    expect(tIssues(traj([step(1, { status: 'denied' })]))).toContainEqual(expect.objectContaining({ path: '/steps/0/error_class' }));
  });
  it('target_kind none has no target, and a target has a kind', () => {
    expect(tIssues(traj([step(1, { target_kind: 'none' })]))).toContainEqual(expect.objectContaining({ path: '/steps/0/target_redacted' }));
    expect(tIssues(traj([step(1, { target_redacted: null })]))).toContainEqual(expect.objectContaining({ path: '/steps/0/target_kind' }));
  });
  it('refuses an unknown tool family, status and error class, and a tool name with a space', () => {
    expect(tIssues(traj([step(1, { tool_family: 'python' })]))).toContainEqual(expect.objectContaining({ path: '/steps/0/tool_family' }));
    expect(tIssues(traj([step(1, { status: 'crashed' })]))).toContainEqual(expect.objectContaining({ path: '/steps/0/status' }));
    expect(tIssues(traj([step(1, { status: 'error', error_class: 'oops' })]))).toContainEqual(expect.objectContaining({ path: '/steps/0/error_class' }));
    expect(tIssues(traj([step(1, { tool: 'run this' })]))).toContainEqual(expect.objectContaining({ path: '/steps/0/tool' }));
  });
  it('the v1 schema is unchanged: it still names tma-local-result/1 only', () => {
    expect((localResultSchema as any).properties.format).toEqual({ const: 'tma-local-result/1' });
  });
  it('v2 is v1 plus case, variant, comparison and three run keys: every other v1 property and $def is copied unchanged', () => {
    const s1 = localResultSchema as any;
    const s2 = localResultV2Schema as any;
    const RUN_EXTRA = ['infra_ok', 'graders', 'trajectory'];
    expect(s2.allOf).toEqual(s1.allOf);
    expect(s2.required).toEqual([...s1.required, 'case', 'variant', 'comparison']);
    for (const key of Object.keys(s1.properties)) {
      if (key === 'format' || key === 'runs') continue;
      expect(s2.properties[key], key).toEqual(s1.properties[key]);
    }
    for (const [name, def] of Object.entries<any>(s1.$defs)) {
      const d2 = structuredClone(s2.$defs[name]);
      if (name.endsWith('Run')) {
        expect(d2.required, name).toEqual([...def.required, ...RUN_EXTRA]);
        d2.required = def.required;
        for (const k of RUN_EXTRA) delete d2.properties[k];
      }
      expect(d2, name).toEqual(def);
    }
  });
});

describe('tma-local-result/3 — task summary (plan T9, Q-T16 = A)', () => {
  const withSummary = (summary: unknown) => {
    const v = v3();
    v.case.task_summary = summary;
    return v;
  };
  it('accepts before and expected of 280 characters each, a null field, null, and no key at all', () => {
    expect(issuesV3(withSummary({ before: 'a'.repeat(280), expected: 'b'.repeat(280) }))).toEqual([]);
    expect(issuesV3(withSummary({ before: "Red CI on main: the dup webhook test fails (#12).", expected: null }))).toEqual([]);
    expect(issuesV3(withSummary(null))).toEqual([]);
    expect(issuesV3(v3())).toEqual([]);
  });
  it('refuses outcome: the outcome of a run stays on the trace, on the host', () => {
    expect(issuesV3(withSummary({ before: 'x', expected: 'y', outcome: 'merged' })))
      .toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/case/task_summary/outcome' }));
  });
  it('refuses 281 characters, an empty field, a missing field, a newline, a quote and a brace', () => {
    expect(issuesV3(withSummary({ before: 'a'.repeat(281), expected: null })))
      .toContainEqual(expect.objectContaining({ path: '/case/task_summary/before' }));
    expect(issuesV3(withSummary({ before: null, expected: 'a'.repeat(281) })))
      .toContainEqual(expect.objectContaining({ path: '/case/task_summary/expected' }));
    expect(issuesV3(withSummary({ before: '', expected: null }))).toContainEqual(expect.objectContaining({ path: '/case/task_summary/before' }));
    expect(issuesV3(withSummary({ before: 'x' }))).not.toEqual([]);
    for (const bad of ['two\nlines', 'say "hi"', 'a {b}', 'echo `id`']) {
      expect(issuesV3(withSummary({ before: bad, expected: null })), bad).toContainEqual(expect.objectContaining({ path: '/case/task_summary/before' }));
    }
  });
});

describe('tma-local-result/3 — grader version and label fields (plan T11)', () => {
  const CAL = { n_labels: 120, n_test: 86, tp: 40, fn: 3, tn: 39, fp: 4, realigned_at: '2026-11-12' };
  const withGrader = (over: Record<string, unknown>, run = 0) => {
    const v = v3();
    v.runs[run].graders[0] = { ...v.runs[run].graders[0], ...over };
    return v;
  };
  const judge = { id: 'judge-ci-claim', kind: 'judge' };
  it('accepts proof, note, author, reason_code and labeler on a code grader, and calibration on a judge', () => {
    const v = v3();
    const meta = { proof: { caught: 3, total: 3 }, note: 'Catches the dup webhook; v2.1 (#12)', author: 'claude-main' };
    v.runs[0].graders[0] = { ...v.runs[0].graders[0], ...meta, reason_code: 'partial', labeler: 'dfl:6c4b1a3e-0000-4000-8000-000000000000' };
    v.runs[1].graders[0] = { ...v.runs[1].graders[0], ...meta, reason_code: null, labeler: null };
    expect(issuesV3(v)).toEqual([]);
    const j = v3();
    for (const run of j.runs) run.graders.push(grader({ ...judge, calibration: CAL, decisive: false }));
    expect(issuesV3(j)).toEqual([]);
    for (const reason of ['wrong_sha', 'no_check', 'partial', 'other']) expect(issuesV3(withGrader({ reason_code: reason }))).toEqual([]);
  });
  it('refuses calibration whose 2x2 table does not add up to n_test, or n_test above n_labels', () => {
    expect(issuesV3(withGrader({ ...judge, calibration: { ...CAL, tp: 41 } })))
      .toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/runs/0/graders/0/calibration/n_test' }));
    expect(issuesV3(withGrader({ ...judge, calibration: { ...CAL, n_labels: 80 } })))
      .toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/runs/0/graders/0/calibration/n_test' }));
  });
  it('refuses calibration on a code grader, a missing or an extra calibration key, and a non-integer count', () => {
    expect(issuesV3(withGrader({ calibration: CAL })))
      .toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/runs/0/graders/0/calibration' }));
    const { realigned_at: _r, ...missing } = CAL;
    expect(issuesV3(withGrader({ ...judge, calibration: missing }))).not.toEqual([]);
    expect(issuesV3(withGrader({ ...judge, calibration: { ...CAL, why: 'the judge said' } })))
      .toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/runs/0/graders/0/calibration/why' }));
    expect(issuesV3(withGrader({ ...judge, calibration: { ...CAL, tp: 39.5, fn: 3.5 } })))
      .toContainEqual(expect.objectContaining({ path: '/runs/0/graders/0/calibration/tp' }));
    expect(issuesV3(withGrader({ ...judge, calibration: { ...CAL, realigned_at: 'yesterday' } })))
      .toContainEqual(expect.objectContaining({ path: '/runs/0/graders/0/calibration/realigned_at' }));
  });
  it('refuses a proof that catches more than it planted, a 61-character note, an e-mail author or labeler, an unknown reason', () => {
    expect(issuesV3(withGrader({ proof: { caught: 4, total: 3 } })))
      .toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/runs/0/graders/0/proof/caught' }));
    expect(issuesV3(withGrader({ proof: { caught: 0, total: 0 } }))).toContainEqual(expect.objectContaining({ path: '/runs/0/graders/0/proof/total' }));
    expect(issuesV3(withGrader({ note: 'x'.repeat(61) }))).toContainEqual(expect.objectContaining({ path: '/runs/0/graders/0/note' }));
    expect(issuesV3(withGrader({ note: 'line\nbreak' }))).toContainEqual(expect.objectContaining({ path: '/runs/0/graders/0/note' }));
    expect(issuesV3(withGrader({ author: 'tainan@example.com' }))).toContainEqual(expect.objectContaining({ path: '/runs/0/graders/0/author' }));
    expect(issuesV3(withGrader({ labeler: 'Tainan Fidelis' }))).toContainEqual(expect.objectContaining({ path: '/runs/0/graders/0/labeler' }));
    expect(issuesV3(withGrader({ reason_code: 'vibes' }))).toContainEqual(expect.objectContaining({ path: '/runs/0/graders/0/reason_code' }));
  });
  it('refuses two runs that send other version fields for the same grader version', () => {
    const v = v3();
    v.runs[0].graders[0].proof = { caught: 3, total: 3 };
    v.runs[1].graders[0].proof = { caught: 2, total: 3 };
    expect(issuesV3(v)).toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/runs/1/graders/0' }));
    // An absent key and null are the same.
    const same = v3();
    same.runs[0].graders[0].note = null;
    expect(issuesV3(same)).toEqual([]);
  });
});

describe('tma-trajectory/2 (plan T10)', () => {
  const step2 = (seq: number, over: Record<string, unknown> = {}) => step(seq, { step_kind: 'write', started_ms: seq * 1000, turn_origin: 'agent', ...over });
  const traj2 = (steps: Record<string, any>[] = [
    step2(1, { tool: 'Read', step_kind: 'read', turn_origin: 'human' }),
    step2(2),
    step2(3, { tool: 'Bash', tool_family: 'shell', target_kind: 'command', target_redacted: 'npm test <args>', step_kind: 'test' }),
    step2(4, { tool: 'Grep', step_kind: 'search', started_ms: null, turn_origin: null, target_kind: 'pattern', target_redacted: 'handler' }),
  ]) => ({ format: 'tma-trajectory/2', steps });
  const tIssues = (v: unknown) => {
    const r = validateTrajectory(v);
    return r.ok ? [] : r.issues;
  };
  it('accepts a v2 trajectory alone and in a /3 run, next to a v1 run in the same upload', () => {
    expect(tIssues(traj2())).toEqual([]);
    expect(tIssues(traj())).toEqual([]);
    const v = v3();
    v.runs[0].trajectory = traj2();
    expect(issuesV3(v)).toEqual([]);
    for (const kind of ['read', 'search', 'write', 'test', 'mcp', 'shell', 'agent', 'other']) expect(tIssues(traj2([step2(1, { step_kind: kind })])), kind).toEqual([]);
    for (const origin of ['human', 'agent', 'system']) expect(tIssues(traj2([step2(1, { turn_origin: origin })])), origin).toEqual([]);
  });
  it('refuses an unknown step_kind, a negative or too large started_ms, an unknown turn_origin and a missing step_kind', () => {
    expect(tIssues(traj2([step2(1, { step_kind: 'browse' })]))).toContainEqual(expect.objectContaining({ path: '/steps/0/step_kind' }));
    expect(tIssues(traj2([step2(1, { started_ms: -1 })]))).toContainEqual(expect.objectContaining({ path: '/steps/0/started_ms' }));
    expect(tIssues(traj2([step2(1, { started_ms: 86_400_001 })]))).toContainEqual(expect.objectContaining({ path: '/steps/0/started_ms' }));
    expect(tIssues(traj2([step2(1, { turn_origin: 'user' })]))).toContainEqual(expect.objectContaining({ path: '/steps/0/turn_origin' }));
    const { step_kind: _k, ...noKind } = step2(1);
    expect(tIssues(traj2([noKind]))).not.toEqual([]);
  });
  it('in a /3 upload: the errors of a v2 step name only the bad field, and a v1 step with step_kind is an unknown key', () => {
    const v = v3();
    v.runs[0].trajectory = traj2([step2(1, { step_kind: 'browse' })]);
    const issues = issuesV3(v);
    expect(issues).toContainEqual(expect.objectContaining({ path: '/runs/0/trajectory/steps/0/step_kind' }));
    expect(issues.filter((i) => i.path !== '/runs/0/trajectory/steps/0/step_kind')).toEqual([]);
    const w = v3();
    w.runs[0].trajectory.steps[0].step_kind = 'read';
    expect(issuesV3(w)).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/runs/0/trajectory/steps/0/step_kind' }));
  });
  it('keeps the tma-trajectory/1 step rules in v2', () => {
    expect(tIssues(traj2([step2(1), step2(3)]))).toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/steps/1/seq' }));
    expect(tIssues(traj2([step2(1, { status: 'error', error_class: null })]))).toContainEqual(expect.objectContaining({ code: 'inconsistent' }));
  });
  it('v2 is v1 plus exactly three step fields', () => {
    const s1 = trajectorySchema as any;
    const s2 = trajectoryV2Schema as any;
    const EXTRA = ['step_kind', 'started_ms', 'turn_origin'];
    expect(s2.properties.format).toEqual({ const: 'tma-trajectory/2' });
    expect(s2.$defs.step.required).toEqual([...s1.$defs.step.required, ...EXTRA]);
    const p2 = { ...s2.$defs.step.properties };
    for (const k of EXTRA) delete p2[k];
    expect(p2).toEqual(s1.$defs.step.properties);
    expect(s2.properties.steps).toEqual(s1.properties.steps);
  });
});

describe('tma-local-result/3 is /2 plus the T9-T11 fields; /2 stays unchanged (plan ADR-3)', () => {
  it('/2 refuses every /3 field and a tma-trajectory/2 run', () => {
    const summary = v2();
    summary.case.task_summary = { before: 'x', expected: null };
    expect(issuesV2(summary)).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/case/task_summary' }));
    for (const k of ['proof', 'calibration', 'note', 'author', 'reason_code', 'labeler']) {
      const v = v2();
      v.runs[0].graders[0][k] = null;
      expect(issuesV2(v), k).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: `/runs/0/graders/0/${k}` }));
    }
    const t = v2();
    t.runs[0].trajectory = { format: 'tma-trajectory/2', steps: [step(1, { step_kind: 'read', started_ms: 0, turn_origin: 'agent' })] };
    expect(issuesV2(t)).not.toEqual([]);
  });
  it('a /2 body with the /3 format is a valid /3 body, and validateAnyLocalResult picks each by its format', () => {
    expect(issuesV3(v3())).toEqual([]);
    expect(validateAnyLocalResult(v3())).toMatchObject({ ok: true, format: 'tma-local-result/3' });
    expect(validateAnyLocalResult(v2())).toMatchObject({ ok: true, format: 'tma-local-result/2' });
    expect(parseAnyLocalResultText(JSON.stringify(v3()))).toMatchObject({ ok: true, format: 'tma-local-result/3' });
    // A /3 body with the /2 format is refused when it uses a /3 field.
    const withNote = v3();
    withNote.runs[0].graders[0].note = 'v2.1';
    withNote.runs[1].graders[0].note = 'v2.1';
    expect(issuesV3(withNote)).toEqual([]);
    expect(validateAnyLocalResult({ ...withNote, format: 'tma-local-result/2' })).toMatchObject({ ok: false, format: 'tma-local-result/2' });
  });
  it('the /3 schema is the /2 schema plus the T9-T11 keys and the trajectory choice, nothing else', () => {
    const s2 = localResultV2Schema as any;
    const s3 = localResultV3Schema as any;
    expect(s3.properties.format).toEqual({ const: 'tma-local-result/3' });
    expect(s3.required).toEqual(s2.required);
    expect(Object.keys(s3.properties).sort()).toEqual(Object.keys(s2.properties).sort());
    const caseProps = { ...s3.properties.case.properties };
    delete caseProps.task_summary;
    expect(caseProps).toEqual(s2.properties.case.properties);
    expect(s3.properties.case.required).toEqual(s2.properties.case.required);
    const g3 = { ...s3.$defs.grader.properties };
    for (const k of ['proof', 'calibration', 'note', 'author', 'reason_code', 'labeler']) delete g3[k];
    expect(g3).toEqual(s2.$defs.grader.properties);
    expect(s3.$defs.grader.required).toEqual(s2.$defs.grader.required);
  });
});

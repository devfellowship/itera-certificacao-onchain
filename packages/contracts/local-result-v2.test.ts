// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// tma-local-result/2 and tma-trajectory/1 (plan 20261112-tma-c4-result-store-trajectory-upload, T1).
import { describe, expect, it } from 'vitest';
import {
  LOCAL_RESULT_MAX_BYTES,
  LOCAL_RESULT_V2_MAX_BYTES,
  LOCAL_RESULT_V2_MAX_RUNS,
  TRAJECTORY_MAX_STEPS,
  localResultSchema,
  localResultV2Schema,
  parseAnyLocalResultText,
  parseLocalResultText,
  trajectorySchema,
  validateAnyLocalResult,
  validateLocalResult,
  validateLocalResultV2,
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
const v2 = (over: Record<string, unknown> = {}): Record<string, any> =>
  v1Base({
    format: 'tma-local-result/2',
    metrics_shape: 'tma-score/1',
    case: { case_key: 'webhook-dup-001', manifest_sha256: H('1'), pin_sha256: H('2'), mode: 'replay', use_case_key: 'fix/prod-bug' },
    variant: { variant_sha256: H('3'), label: 'skill v2 (shorter brief)', change_kind: 'skill', is_baseline: false, prediction_sha256: H('4') },
    summary: { score: 90, runs: 2, items: 1 },
    runs: [v2Run(1, 100), v2Run(2, 80)],
    ...over,
  });

const issuesV2 = (v: unknown) => {
  const r = validateLocalResultV2(v);
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
      variant: { variant_sha256: H('5'), label: 'baseline', change_kind: 'none', is_baseline: true, prediction_sha256: null },
      case: { case_key: 'webhook-dup-001', manifest_sha256: H('1'), pin_sha256: null, mode: 'trace_review', use_case_key: 'fix' },
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
  it('has no property for logs, a patch, a prompt, an answer, arguments or a key in either schema', () => {
    const forbidden = /^(actions?|events?|patch|diff|stdout|stderr|logs?|messages?|prompt|answer|output|transcript|content|text|args|arguments|input|key|api_key|token|secret|command|reason|rationale|comment|note)$/;
    for (const schema of [localResultV2Schema, trajectorySchema]) {
      const names: string[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        const o = node as Record<string, unknown>;
        if (o.properties && typeof o.properties === 'object') names.push(...Object.keys(o.properties));
        Object.values(o).forEach(walk);
      };
      walk(schema);
      expect(names.length).toBeGreaterThan(10);
      expect(names.filter((n) => forbidden.test(n))).toEqual([]);
    }
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
    walk(trajectorySchema, '');
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
  it('the baseline has change_kind none and no prediction; another variant names its change and has a prediction', () => {
    const b = v2(); b.variant.is_baseline = true;
    expect(issuesV2(b)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'inconsistent', path: '/variant/change_kind' }),
      expect.objectContaining({ code: 'inconsistent', path: '/variant/prediction_sha256' }),
    ]));
    const n = v2(); n.variant.change_kind = 'none'; n.variant.prediction_sha256 = null;
    expect(issuesV2(n)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'inconsistent', path: '/variant/change_kind' }),
      expect.objectContaining({ code: 'inconsistent', path: '/variant/prediction_sha256' }),
    ]));
  });
  it('a replay case has a pin', () => {
    const v = v2(); v.case.pin_sha256 = null;
    expect(issuesV2(v)).toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/case/pin_sha256' }));
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
  it('v2 is v1 plus case, variant and three run keys: every other v1 property and $def is copied unchanged', () => {
    const s1 = localResultSchema as any;
    const s2 = localResultV2Schema as any;
    const RUN_EXTRA = ['infra_ok', 'graders', 'trajectory'];
    expect(s2.allOf).toEqual(s1.allOf);
    expect(s2.required).toEqual([...s1.required, 'case', 'variant']);
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

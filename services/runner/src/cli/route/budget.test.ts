// Paid-run budget (T6). Fake fetch and invented rows only: no paid run, no network.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CliError } from '../env.js';
import { API, TOKEN } from '../test/fixtures.js';
import { capsFromEnv, checkBudget, countPaidRuns, fetchRunRows, isPaidModel, parseTiers, type Counts, type RunRow } from './budget.js';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const H = 3600 * 1000;
const TIERS = parseTiers(
  JSON.stringify({
    schema: 'tma-model-tiers/1',
    models: [
      { model_id: 'z-ai/glm-5.3', tier: 'mid', price_source: 'metered' },
      { model_id: 'opencode-go/deepseek-v4.1-flash', tier: 'small', price_source: { table: 'prices.json', as_of: '2026-11-01' } },
      { model_id: 'gemma3:12b', tier: 'local', price_source: 'metered' },
    ],
  }),
);

const row = (modelId: string, ageMs = 0, id = 'run-0001'): RunRow => ({ id, startedAt: new Date(NOW - ageMs).toISOString(), variant: { agent: { modelId } } });
const counts = (over: Partial<Counts> = {}): Counts => ({ total_runs: 0, paid_total: 0, paid_night: 0, paid_month: 0, unlisted: [], by_model: {}, ...over });
const CAPS = { total: 200, night: 10, month: 60 };

describe('parseTiers', () => {
  it('refuses a bad format, an unknown key, a bad tier and a bad price source', () => {
    expect(() => parseTiers('nope')).toThrow(CliError);
    expect(() => parseTiers('{"schema":"x","models":[]}')).toThrow(/schema/);
    expect(() => parseTiers('{"format":"tma-model-tiers/1","models":[]}')).toThrow(/"format" is not accepted/);
    expect(() => parseTiers('{"schema":"tma-model-tiers/1","models":[{"model_id":"-bad id","tier":"mid","price_source":"metered"}]}')).toThrow(/model_id/);
    expect(() => parseTiers('{"schema":"tma-model-tiers/1","models":[],"extra":1}')).toThrow(/unknown key/);
    expect(() => parseTiers('{"schema":"tma-model-tiers/1","models":[{"model_id":"a/b","tier":"huge","price_source":"metered"}]}')).toThrow(/tier/);
    expect(() => parseTiers('{"schema":"tma-model-tiers/1","models":[{"model_id":"a/b","tier":"mid","price_source":"free"}]}')).toThrow(/price_source/);
    expect(() => parseTiers('{"schema":"tma-model-tiers/1","models":[{"model_id":"a/b","tier":"mid","price_source":"metered","x":1}]}')).toThrow(/unknown key/);
  });
});

describe('parseTiers on the real dfl-evals file', () => {
  const real = parseTiers(readFileSync(new URL('../../../examples/route/tiers-real.json', import.meta.url), 'utf-8'));
  it('accepts it', () => {
    expect(real.schema).toBe('tma-model-tiers/1');
    expect(real.models).toHaveLength(1);
  });
  it('fleet Claude is free, an unlisted model is paid', () => {
    expect(isPaidModel('claude-opus-5-5', real)).toBe(false);
    expect(isPaidModel('z-ai/glm-5.3', real)).toBe(true);
  });
});

describe('isPaidModel', () => {
  it.each([
    ['anthropic/claude-opus-5.5', false],
    ['claude-opus-5-5', false],
    ['claude-sonnet-5-5[1m]', false],
    ['ollama/qwen3:14b', false],
    ['local/gemma', false],
    ['gemma3:12b', false], // tier local in the file
    ['z-ai/glm-5.3', true],
    ['glm-5.3', true],
    ['opencode-go/deepseek-v4.1-flash', true],
    ['some-lab/unknown-model', true],
  ])('%s -> paid %s', (id, paid) => {
    expect(isPaidModel(id, TIERS)).toBe(paid);
  });

  it('reports a paid model that the file does not list as unlisted', () => {
    const c = countPaidRuns([row('some-lab/unknown-model'), row('z-ai/glm-5.3'), row('claude-opus-5-5')], TIERS, NOW);
    expect(c.unlisted).toEqual(['some-lab/unknown-model']);
    expect(c.paid_total).toBe(2);
    expect(c.by_model).toEqual({ 'some-lab/unknown-model': 1, 'z-ai/glm-5.3': 1 });
  });
});

describe('countPaidRuns windows', () => {
  it('night is the last 24 h, month is the UTC calendar month, total counts all paid', () => {
    const rows = [
      row('z-ai/glm-5.3', 23 * H),
      row('z-ai/glm-5.3', 25 * H), // this month, not tonight
      row('z-ai/glm-5.3', 14 * 24 * H), // 2026-10-30: previous month
      row('ollama/x', 1 * H), // free
    ];
    const c = countPaidRuns(rows, TIERS, NOW);
    expect(c).toMatchObject({ total_runs: 4, paid_total: 3, paid_night: 1, paid_month: 2 });
  });
});

describe('checkBudget', () => {
  it('199 + 1 is ok, 200 + 1 is refused, 200 + 0 is ok', () => {
    expect(checkBudget({ counts: counts({ paid_total: 199 }), planned: 1, caps: CAPS }).ok).toBe(true);
    const r = checkBudget({ counts: counts({ paid_total: 200 }), planned: 1, caps: CAPS });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/^total_cap: have 200, planned 1, cap 200/);
    expect(checkBudget({ counts: counts({ paid_total: 200 }), planned: 0, caps: CAPS }).ok).toBe(true);
  });
  it('refuses on the night and month caps', () => {
    expect(checkBudget({ counts: counts({ paid_night: 10 }), planned: 1, caps: CAPS }).reasons[0]).toMatch(/^night_cap: have 10, planned 1, cap 10/);
    expect(checkBudget({ counts: counts({ paid_month: 60 }), planned: 1, caps: CAPS }).reasons[0]).toMatch(/^month_cap: have 60, planned 1, cap 60/);
    expect(checkBudget({ counts: counts({ paid_night: 9, paid_month: 59 }), planned: 1, caps: CAPS }).ok).toBe(true);
  });
  it('free runs never count: 500 free runs + 1 paid is ok', () => {
    const rows = Array.from({ length: 500 }, () => row('ollama/qwen3:14b'));
    const c = countPaidRuns(rows, TIERS, NOW);
    expect(c.paid_total).toBe(0);
    expect(checkBudget({ counts: c, planned: 1, caps: CAPS }).ok).toBe(true);
  });
});

describe('capsFromEnv', () => {
  it('has the defaults', () => expect(capsFromEnv({})).toEqual(CAPS));
  it('lowers the total, never raises it', () => {
    expect(capsFromEnv({ TMA_BUDGET_TOTAL: '50' }).total).toBe(50);
    expect(capsFromEnv({ TMA_BUDGET_TOTAL: '300' }).total).toBe(200);
  });
  it('sets night and month', () => expect(capsFromEnv({ TMA_BUDGET_NIGHT: '3', TMA_BUDGET_MONTH: '9' })).toMatchObject({ night: 3, month: 9 }));
  it('throws on garbage', () => {
    for (const v of ['abc', '0', '-1', '1.5']) expect(() => capsFromEnv({ TMA_BUDGET_NIGHT: v })).toThrow(CliError);
    expect(() => capsFromEnv({ TMA_BUDGET_TOTAL: 'x' })).toThrow(/TMA_BUDGET_TOTAL/);
  });
});

describe('fetchRunRows', () => {
  const run = (body: unknown, status = 200) => fetchRunRows({ base: API, token: TOKEN, fetchImpl: (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch });
  const good = { id: 'abcdef12-0000', startedAt: '2026-11-13T10:00:00Z', variant: { agent: { modelId: 'z-ai/glm-5.3' } } };

  it('returns the rows', async () => {
    expect((await run({ runs: [good] }))[0]!.variant.agent.modelId).toBe('z-ai/glm-5.3');
  });
  it('refuses a non-200', async () => {
    await expect(run({ error: 'forbidden' }, 403)).rejects.toThrow(/forbidden/);
  });
  it('refuses runs that is not an array', async () => {
    await expect(run({ runs: {} })).rejects.toThrow(/runs_not_an_array/);
  });
  it('refuses one row without a model id, naming the run', async () => {
    await expect(run({ runs: [good, { ...good, id: 'deadbeef-1', variant: { agent: {} } }] })).rejects.toThrow(/run_row_without_model_id: run deadbeef/);
  });
  it('refuses a truncated list', async () => {
    await expect(run({ runs: [good], truncated: true })).rejects.toThrow(/runs_truncated.*count endpoint/);
  });
});

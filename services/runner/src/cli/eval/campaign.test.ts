// Tests of the campaign run-count cap (plan 20261112-tma-c7-model-comparison-per-use-case, C7-PREP).
// Mutation proof: change `>` to `>=` in chargeCampaign (or drop the check) -> "the N+1th run is refused" goes red.
// Token cap (C7-T5): drop `next > cap` (or the largest-run estimate) -> "the run that would pass the cap" goes red.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CliError } from '../env.js';
import { captureIo } from '../test/fixtures.js';
import { makeEvalCommand } from '../commands/eval.js';
import { campaignState, chargeCampaign, initCampaign, ledgerPath, parseCampaign, parseTokenCapFlag, recordTokens, statusLine } from './campaign.js';

const made: string[] = [];
const file = (name = 'c.campaign.json') => {
  const dir = mkdtempSync(join(tmpdir(), 'tma-campaign-'));
  made.push(dir);
  return join(dir, name);
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const GLM = 'zai-coding-plan/glm-5.3';

describe('campaign run cap', () => {
  it('the N+1th run is refused and nothing is written', () => {
    const f = file();
    initCampaign(f, { name: 'cap3', maxRuns: 3 });
    for (let i = 1; i <= 3; i++) expect(chargeCampaign(f, { runs: 1, model: GLM }).used).toBe(i);
    expect(() => chargeCampaign(f, { runs: 1, model: GLM })).toThrow(/campaign_cap: 3 of 3 runs used/);
    expect(campaignState(f).used).toBe(3);
    expect(readFileSync(ledgerPath(f), 'utf-8').trim().split('\n')).toHaveLength(3);
  });

  it('a charge of k runs that would pass the cap is refused whole, and exactly at the cap is allowed', () => {
    const f = file();
    initCampaign(f, { name: 'cap5', maxRuns: 5 });
    chargeCampaign(f, { runs: 3, model: null });
    expect(() => chargeCampaign(f, { runs: 3, model: null })).toThrow(/campaign_cap/);
    expect(campaignState(f).used).toBe(3);
    expect(chargeCampaign(f, { runs: 2, model: null }).used).toBe(5);
  });

  it('counts paid runs against 200 from the one ledger, plus the runs before it', () => {
    const f = file();
    initCampaign(f, { name: 'paid', maxRuns: 500, paidRunsBefore: 198 });
    chargeCampaign(f, { runs: 1, model: GLM });
    chargeCampaign(f, { runs: 1, model: 'anthropic/claude-opus-5.5' }); // fleet Claude: not paid
    chargeCampaign(f, { runs: 1, model: 'ollama/qwen3.5:9b' }); // local: not paid
    chargeCampaign(f, { runs: 1, model: null }); // a patch variant: no model call
    const s = campaignState(f);
    expect(s.used).toBe(4);
    expect(s.paid_total).toBe(199);
    expect(statusLine(s)).toBe('campaign paid: 4 of 500 runs used; paid runs 199 of 200 (198 before the ledger + 1 in it)');
    chargeCampaign(f, { runs: 1, model: GLM });
    expect(() => chargeCampaign(f, { runs: 1, model: GLM })).toThrow(/paid_cap: paid runs 200 of 200/);
    expect(campaignState(f).used).toBe(5);
  });

  it('refuses to rewrite the cap of a started campaign, a bad config and a broken ledger', () => {
    const f = file();
    initCampaign(f, { name: 'x', maxRuns: 2 });
    expect(() => initCampaign(f, { name: 'x', maxRuns: 99 })).toThrow(/exists/);
    expect(() => parseCampaign('{"schema":"tma-campaign/1","name":"x","max_runs":0}')).toThrow(/max_runs/);
    expect(() => parseCampaign('{"schema":"tma-campaign/1","name":"x","max_runs":2,"budget_usd":1}')).toThrow(/unknown key/);
    chargeCampaign(f, { runs: 1, model: null });
    writeFileSync(ledgerPath(f), 'not json\n');
    expect(() => campaignState(f)).toThrow(CliError);
    expect(() => chargeCampaign(f, { runs: 1, model: null })).toThrow(/not JSON/);
  });

  it('removes its lock file after a charge and after a refusal', () => {
    const f = file();
    initCampaign(f, { name: 'lock', maxRuns: 1 });
    chargeCampaign(f, { runs: 1, model: null });
    expect(() => chargeCampaign(f, { runs: 1, model: null })).toThrow(/campaign_cap/);
    expect(existsSync(`${ledgerPath(f)}.lock`)).toBe(false);
  });
});

describe('campaign token cap per provider (C7-T5)', () => {
  const SONNET = 'anthropic/claude-sonnet-5.5';
  const capped = (cap = 2_000_000) => {
    const f = file();
    initCampaign(f, { name: 'tok', maxRuns: 45, tokenCaps: { 'claude-code': cap, codex: cap } });
    return f;
  };

  it('every token kind counts, per provider, from the ledger', () => {
    const f = capped();
    chargeCampaign(f, { runs: 1, model: SONNET, provider: 'claude-code' });
    const s = recordTokens(f, { provider: 'claude-code', model: SONNET, tokensIn: 1000, tokensOut: 200, cacheRead: 300_000, cacheWrite: 50_000 });
    expect(s.tokens.find((t) => t.provider === 'claude-code')).toMatchObject({ cap: 2_000_000, runs_charged: 1, runs_recorded: 1, tokens_used: 351_200, max_run_tokens: 351_200 });
    expect(s.tokens.find((t) => t.provider === 'codex')).toMatchObject({ tokens_used: 0, runs_charged: 0 });
    expect(statusLine(s)).toContain('claude-code 351200 of 2000000 tokens (1 of 1 charged runs recorded)');
  });

  it('the run that would pass the cap (at the largest run so far) is refused, and nothing is written', () => {
    const f = capped(1_000_000);
    for (let i = 0; i < 2; i++) {
      chargeCampaign(f, { runs: 1, model: SONNET, provider: 'claude-code' });
      recordTokens(f, { provider: 'claude-code', model: SONNET, tokensIn: 300_000, tokensOut: 10_000 });
    }
    // 620k used; the next run at 310k would reach 930k: allowed. Then 930k + 310k > 1M: refused.
    chargeCampaign(f, { runs: 1, model: SONNET, provider: 'claude-code' });
    recordTokens(f, { provider: 'claude-code', model: SONNET, tokensIn: 300_000, tokensOut: 10_000 });
    const before = readFileSync(ledgerPath(f), 'utf-8');
    expect(() => chargeCampaign(f, { runs: 1, model: SONNET, provider: 'claude-code' })).toThrow(/token_cap: claude-code used 930000 of 1000000 tokens/);
    expect(readFileSync(ledgerPath(f), 'utf-8')).toBe(before);
    // Another provider has its own cap.
    expect(chargeCampaign(f, { runs: 1, model: 'openai/gpt-5.6', provider: 'codex' }).used).toBe(4);
  });

  it('a charge waits for the token record of the last run; a record needs a charge; a capped campaign needs a provider', () => {
    const f = capped();
    expect(() => recordTokens(f, { provider: 'codex', model: null, tokensIn: 1, tokensOut: 1 })).toThrow(/no charged run of codex/);
    chargeCampaign(f, { runs: 1, model: 'openai/gpt-5.6', provider: 'codex' });
    expect(() => chargeCampaign(f, { runs: 1, model: 'openai/gpt-5.6', provider: 'codex' })).toThrow(/token_cap: codex has 1 charged run\(s\) with no token record/);
    expect(() => chargeCampaign(f, { runs: 1, model: SONNET })).toThrow(/must name its --provider/);
    // A patch variant calls no model: no provider needed. An uncapped provider (z.ai) is counted, not capped.
    expect(chargeCampaign(f, { runs: 1, model: null }).used).toBe(2);
    chargeCampaign(f, { runs: 1, model: GLM, provider: 'zai' });
    expect(chargeCampaign(f, { runs: 1, model: GLM, provider: 'zai' }).tokens.find((t) => t.provider === 'zai')).toMatchObject({ cap: null, runs_charged: 2 });
  });

  it('a used-up cap refuses even a first-size run, and bad caps are refused', () => {
    const f = capped(100);
    chargeCampaign(f, { runs: 1, model: SONNET, provider: 'claude-code' });
    recordTokens(f, { provider: 'claude-code', model: SONNET, tokensIn: 100, tokensOut: 0 });
    expect(() => chargeCampaign(f, { runs: 1, model: SONNET, provider: 'claude-code' })).toThrow(/token_cap/);
    expect(() => parseCampaign('{"schema":"tma-campaign/1","name":"x","max_runs":2,"token_caps":{}}')).toThrow(/token_caps/);
    expect(() => parseCampaign('{"schema":"tma-campaign/1","name":"x","max_runs":2,"token_caps":{"Claude Code":5}}')).toThrow(/provider/);
    expect(() => parseCampaign('{"schema":"tma-campaign/1","name":"x","max_runs":2,"token_caps":{"codex":0}}')).toThrow(/token_caps.codex/);
    expect(parseTokenCapFlag('claude-code=2000000')).toEqual(['claude-code', 2_000_000]);
    expect(() => parseTokenCapFlag('claude-code')).toThrow(/--token-cap/);
    writeFileSync(ledgerPath(f), `${readFileSync(ledgerPath(f), 'utf-8')}{"schema":"tma-campaign-tokens/1","provider":"codex","total":-1}\n`);
    expect(() => campaignState(f)).toThrow(/tma-campaign-tokens\/1/);
  });
});

describe('tma eval campaign', () => {
  const run = async (...argv: string[]) => {
    const io = captureIo();
    const cmd = makeEvalCommand();
    let code: number;
    try {
      code = await cmd.main(argv, io);
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      io.err(e.message);
      code = 1;
    }
    return { code, out: io.outText(), err: io.errText() };
  };

  it('init, charge to the cap, then the next charge exits 1 with campaign_cap', async () => {
    const f = file();
    expect((await run('campaign', 'init', '--file', f, '--name', 'cli', '--max-runs', '2', '--paid-before', '9')).code).toBe(0);
    expect((await run('campaign', 'charge', '--file', f, '--runs', '2', '--model', GLM)).code).toBe(0);
    const over = await run('campaign', 'charge', '--file', f, '--runs', '1', '--model', GLM);
    expect(over.code).toBe(1);
    expect(over.err).toMatch(/campaign_cap/);
    const status = await run('campaign', 'status', '--file', f);
    expect(status.out).toContain('2 of 2 runs used; paid runs 11 of 200');
  });

  it('init with token caps, charge with a provider, record, status', async () => {
    const f = file();
    expect((await run('campaign', 'init', '--file', f, '--name', 'tok', '--max-runs', '15', '--token-cap', 'claude-code=2000000', '--token-cap', 'codex=2000000')).out).toContain('token caps: claude-code 2000000 tokens, codex 2000000 tokens');
    expect((await run('campaign', 'charge', '--file', f, '--runs', '1', '--model', 'anthropic/claude-sonnet-5.5')).err).toMatch(/must name its --provider/);
    expect((await run('campaign', 'charge', '--file', f, '--runs', '1', '--model', 'anthropic/claude-sonnet-5.5', '--provider', 'claude-code')).code).toBe(0);
    const rec = await run('campaign', 'record', '--file', f, '--provider', 'claude-code', '--tokens-in', '10', '--tokens-out', '5', '--cache-read', '1000', '--cache-write', '100');
    expect(rec.code, rec.err).toBe(0);
    expect((await run('campaign', 'status', '--file', f)).out).toContain('claude-code 1115 of 2000000 tokens (1 of 1 charged runs recorded); codex 0 of 2000000 tokens');
  });
});

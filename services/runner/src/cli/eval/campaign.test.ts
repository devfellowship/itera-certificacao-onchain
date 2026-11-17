// Tests of the campaign run-count cap (plan 20261112-tma-c7-model-comparison-per-use-case, C7-PREP).
// Mutation proof: change `>` to `>=` in chargeCampaign (or drop the check) -> "the N+1th run is refused" goes red.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CliError } from '../env.js';
import { captureIo } from '../test/fixtures.js';
import { makeEvalCommand } from '../commands/eval.js';
import { campaignState, chargeCampaign, initCampaign, ledgerPath, parseCampaign, statusLine } from './campaign.js';

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
});

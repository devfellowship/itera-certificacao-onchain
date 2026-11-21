// `tma eval cost` (plan 20261112-tma-c7-model-comparison-per-use-case, C7-COST): the body that it sends to
// POST /eval-results/run-cost, the dry run default, and its refusals. The API is a fake fetch.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRunCost } from '@itera/contracts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CliError } from '../env.js';
import { SESSION_FORMAT, writeSession } from '../session.js';
import { API, captureIo, tempEnv, TOKEN } from '../test/fixtures.js';
import { makeEvalCommand } from './eval.js';

const made: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'tma-cost-'));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const TABLE = {
  schema: 'tma-model-prices/1', as_of: '2026-11-21', currency: 'USD', per: '1M tokens',
  models: [{ model_id: 'zai/glm-5.3', input: 2, cache_read: 0.1, cache_write: 2.5, output: 10, source_url: 'https://example.test/pricing', fetched_on: '2026-11-21', note: 'fixture' }],
};
const TOKENS = [{ tokens_in: 1_000_000, tokens_out: 50_000, cache_read_tokens: 600_000, cache_write_tokens: 100_000 }];
const EVAL = '88c18100-374d-8310-9155-e78917352bbb';

function files(over: { table?: unknown; tokens?: unknown } = {}) {
  const dir = tmp();
  const prices = join(dir, 'prices.json');
  const tokens = join(dir, 'tokens.json');
  writeFileSync(prices, JSON.stringify(over.table ?? TABLE));
  writeFileSync(tokens, JSON.stringify(over.tokens ?? TOKENS));
  return { prices, tokens };
}
function loggedIn(): NodeJS.ProcessEnv {
  const env = tempEnv();
  writeSession({ format: SESSION_FORMAT, api_url: API, principal: 'dfl:x', session_id: 's', session_token: TOKEN, expires_at: '2099-01-01T00:00:00.000Z' }, env);
  return env;
}
const answer = (status: number, body: unknown) => vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => new Response(JSON.stringify(body), { status }));

async function run(argv: string[], f: ReturnType<typeof answer>, env = loggedIn()) {
  const io = captureIo();
  let code: number;
  try {
    code = await makeEvalCommand({ env, fetchImpl: f as unknown as typeof fetch } as never).main(['cost', ...argv], io);
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    io.err(e.message);
    code = 1;
  }
  return { code, io };
}
const sent = (f: ReturnType<typeof answer>) => JSON.parse(String((f.mock.calls.at(-1) as unknown as [string, RequestInit])[1].body)) as Record<string, any>;

describe('tma eval cost', () => {
  const ok = { format: 'tma-run-cost/1', evaluation_id: EVAL, dry_run: true, matched: 1, updated: 0, unchanged: 0, runs: [{ run_id: 'r1', cost_usd: 1.41 }] };

  it('is a dry run unless --apply, and sends tokens and one price entry, never a cost', async () => {
    const f = answer(200, ok);
    const { prices, tokens } = files();
    const { code, io } = await run(['--evaluation', EVAL, '--model', 'zai/glm-5.3', '--prices', prices, '--tokens', tokens], f);
    expect(code, io.errText()).toBe(0);
    const [url, init] = f.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/eval-results/run-cost`);
    expect(init.method).toBe('POST');
    const body = sent(f);
    expect(body).toMatchObject({ format: 'tma-run-cost/1', evaluation_id: EVAL, dry_run: true, runs: TOKENS });
    expect(body.price).toMatchObject({ model_id: 'zai/glm-5.3', input: 2, cache_read: 0.1, cache_write: 2.5, output: 10, as_of: '2026-11-21', source_url: 'https://example.test/pricing' });
    expect(body.price.table_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toMatch(/cost_usd|1\.41/);
    expect(validateRunCost(body).ok).toBe(true);
    expect(io.outText()).toMatch(/dry run OK, it would write/);
    expect(io.errText()).toMatch(/not money paid/);
  });

  it('--apply sends dry_run false', async () => {
    const f = answer(200, { ...ok, dry_run: false, updated: 1 });
    const { prices, tokens } = files();
    const { code, io } = await run(['--evaluation', EVAL, '--model', 'zai/glm-5.3', '--prices', prices, '--tokens', tokens, '--apply'], f);
    expect(code, io.errText()).toBe(0);
    expect(sent(f).dry_run).toBe(false);
    expect(io.outText()).toMatch(/wrote: evaluation .* 1 updated/);
  });

  it('a model with no price entry is refused before any call', async () => {
    const f = answer(200, ok);
    const { prices, tokens } = files();
    const { code, io } = await run(['--evaluation', EVAL, '--model', 'zai/glm-9.9', '--prices', prices, '--tokens', tokens], f);
    expect(code).toBe(1);
    expect(io.errText()).toMatch(/no price for zai\/glm-9\.9: no cost is guessed/);
    expect(f).not.toHaveBeenCalled();
  });

  it('a bad price table or a cache split above tokens_in is refused before any call', async () => {
    for (const over of [
      { table: { ...TABLE, models: [{ ...TABLE.models[0], fetched_on: '2026-11-20' }] } },
      { tokens: [{ ...TOKENS[0], tokens_in: 100 }] },
      { tokens: { not: 'a list' } },
    ]) {
      const f = answer(200, ok);
      const { prices, tokens } = files(over);
      const { code } = await run(['--evaluation', EVAL, '--model', 'zai/glm-5.3', '--prices', prices, '--tokens', tokens], f);
      expect(code).toBe(1);
      expect(f).not.toHaveBeenCalled();
    }
  });

  it('prints the API refusal and exits 1', async () => {
    const f = answer(409, { error: 'cost_exists', message: 'runs[0] already has a cost (0.5, metered); it is never overwritten' });
    const { prices, tokens } = files();
    const { code, io } = await run(['--evaluation', EVAL, '--model', 'zai/glm-5.3', '--prices', prices, '--tokens', tokens, '--apply'], f);
    expect(code).toBe(1);
    expect(io.errText()).toMatch(/cost: refused: cost_exists/);
  });

  it('needs a session', async () => {
    const f = answer(200, ok);
    const { prices, tokens } = files();
    const { code, io } = await run(['--evaluation', EVAL, '--model', 'zai/glm-5.3', '--prices', prices, '--tokens', tokens], f, tempEnv());
    expect(code).toBe(1);
    expect(io.errText()).toMatch(/tma login/);
    expect(f).not.toHaveBeenCalled();
  });
});

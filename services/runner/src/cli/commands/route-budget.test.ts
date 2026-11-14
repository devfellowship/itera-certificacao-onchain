// `tma route budget` end to end with a fake fetch (T6). Invented rows only: no paid run.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_FORMAT, writeSession } from '../session.js';
import { API, TOKEN, captureIo, tempEnv } from '../test/fixtures.js';
import { makeRouteCommand } from './route.js';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const TIERS = JSON.stringify({ format: 'tma-model-tiers/1', models: [{ model_id: 'z-ai/glm-5.3', tier: 'mid', price_source: 'metered' }] });

function loggedIn(): NodeJS.ProcessEnv {
  const env = tempEnv();
  writeSession({ format: SESSION_FORMAT, api_url: API, principal: 'dfl:x', session_id: 's', session_token: TOKEN, expires_at: '2099-01-01T00:00:00.000Z' }, env);
  return env;
}
function tiersFile(): string {
  const f = join(mkdtempSync(join(tmpdir(), 'tma-budget-')), 'tiers.json');
  writeFileSync(f, TIERS);
  return f;
}
/** `paid` paid runs in the last day, plus 3 free ones. */
function api(paid: number, extra: Record<string, unknown> = {}) {
  const mk = (m: string, i: number) => ({ id: `r${i}-aaaaaaaa`, startedAt: new Date(NOW - 3600_000).toISOString(), variant: { agent: { modelId: m } } });
  const runs = [...Array.from({ length: paid }, (_, i) => mk('z-ai/glm-5.3', i)), mk('ollama/x', 900), mk('claude-opus-5-5', 901), mk('local/y', 902)];
  return vi.fn(async () => new Response(JSON.stringify({ runs, ...extra }), { status: 200 }));
}
async function go(args: string[], fetchImpl: unknown, env = loggedIn()) {
  const io = captureIo();
  const code = await makeRouteCommand({ env, fetchImpl: fetchImpl as typeof fetch, now: () => NOW }).main(args, io);
  return { code, out: io.outText(), err: io.errText() };
}

describe('tma route budget', () => {
  // The default night cap (10) and month cap (60) are lower than 195: lift them so the total cap is the one under test.
  const wide = () => ({ ...loggedIn(), TMA_BUDGET_NIGHT: '1000', TMA_BUDGET_MONTH: '1000' });

  it('prints the counts and exits 0 without --plan', async () => {
    const f = api(4);
    const r = await go(['budget', '--tiers', tiersFile()], f);
    expect(r.code).toBe(0);
    expect(r.out).toContain('paid_total\t4\tcap 200');
    expect(r.out).toContain('paid_night\t4\tcap 10');
    expect(r.out).toContain('paid_month\t4\tcap 60');
    expect(r.out).toContain('total_runs\t7');
    expect(f).toHaveBeenCalledOnce();
  });
  it('refuses at 195 + 6 (exit 2) and allows 195 + 5', async () => {
    const bad = await go(['budget', '--tiers', tiersFile(), '--plan', '6'], api(195), wide());
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/^refused: total_cap: have 195, planned 6, cap 200/);
    const ok = await go(['budget', '--tiers', tiersFile(), '--plan', '5'], api(195), wide());
    expect(ok.code).toBe(0);
  });
  it('refuses on the night cap', async () => {
    const r = await go(['budget', '--tiers', tiersFile(), '--plan', '7'], api(4));
    expect(r.code).toBe(2);
    expect(r.err).toContain('night_cap: have 4, planned 7, cap 10');
  });
  it('--json prints counts, caps and the verdict', async () => {
    const r = await go(['budget', '--tiers', tiersFile(), '--plan', '1', '--json'], api(2));
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ paid_total: 2, planned: 1, ok: true, caps: { total: 200, night: 10, month: 60 }, unlisted: [] });
  });
  it('refuses a truncated list', async () => {
    await expect(go(['budget', '--tiers', tiersFile()], api(1, { truncated: true }))).rejects.toThrow(/runs_truncated/);
  });
  it('needs --tiers', async () => {
    await expect(go(['budget'], api(1))).rejects.toThrow(/--tiers is required/);
  });
});

// Spawns the real model gateway (sandbox/model-gateway.mjs) against a local fake upstream and checks
// the K11 behaviour end to end: a 429 is retried with the same body, a 429 that survives the retries
// reaches the agent and is counted as rate_limited_final, and the meter records what answered.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const GATEWAY = join(import.meta.dirname, '..', 'sandbox', 'model-gateway.mjs');
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function fakeUpstream(fail429) {
  const bodies = [];
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      bodies.push({ body: b, auth: req.headers.authorization });
      if (bodies.length <= fail429) {
        res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' });
        res.end('{"error":{"code":429}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'vendor/model-20261001', provider: 'Prov', usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => {
    cleanups.push(() => new Promise((d) => server.close(d)));
    r({ port: server.address().port, bodies });
  }));
}

async function gateway(upPort, port, retries) {
  const child = spawn(process.execPath, [GATEWAY], {
    env: { ...process.env, ITERA_UPSTREAM_KEY: 'k-test', ITERA_UPSTREAM: `http://127.0.0.1:${upPort}`, ITERA_GATEWAY_PORT: String(port), ITERA_GATEWAY_429_RETRIES: String(retries) },
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  cleanups.push(async () => child.kill());
  for (let i = 0; i < 50 && !out.includes('listening'); i++) await new Promise((r) => setTimeout(r, 50));
  return () => out.split('\n').filter((l) => l.includes('"event":"usage"')).map((l) => JSON.parse(l)).at(-1);
}

const BODY = JSON.stringify({ model: 'vendor/model', temperature: 0, messages: [{ role: 'user', content: 'hi' }] });
const call = (port) => fetch(`http://127.0.0.1:${port}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer agent-tries' }, body: BODY });

describe('model gateway (K11)', () => {
  it('retries a 429 with the same body and the gateway key, then meters what answered', async () => {
    const up = await fakeUpstream(2);
    const last = await gateway(up.port, 23128, 3);
    const res = await call(23128);
    expect(res.status).toBe(200);
    await res.text();
    await new Promise((r) => setTimeout(r, 100));
    expect(up.bodies).toHaveLength(3);
    expect(new Set(up.bodies.map((b) => b.body))).toEqual(new Set([BODY]));
    expect(up.bodies.every((b) => b.auth === 'Bearer k-test')).toBe(true);
    expect(last()).toMatchObject({ rate_limited: 2, rate_limited_final: 0, effective_models: { 'vendor/model-20261001': 1 }, providers: { Prov: 1 }, requested_models: { 'vendor/model': 1 }, params: { temperature: 0 } });
  });
  it('a 429 that survives the retries reaches the agent and counts as rate_limited_final', async () => {
    const up = await fakeUpstream(99);
    const last = await gateway(up.port, 23129, 1);
    const res = await call(23129);
    expect(res.status).toBe(429);
    await res.text();
    await new Promise((r) => setTimeout(r, 100));
    expect(up.bodies).toHaveLength(2);
    expect(last()).toMatchObject({ rate_limited: 2, rate_limited_final: 1 });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { SESSION_FORMAT, writeSession } from '../session.js';
import { API, TOKEN, captureIo, tempEnv } from '../test/fixtures.js';
import { agent, agentBody } from './agent.js';

describe('tma agent create', () => {
  it('derives provider and route from the model id, and takes the flags', () => {
    expect(agentBody(['--name', 'samuel-harness', '--model', 'anthropic/claude-sonnet-4.6'])).toEqual({
      name: 'samuel-harness',
      model_id: 'anthropic/claude-sonnet-4.6',
      route_key: 'openrouter',
      provider_key: 'anthropic',
    });
    expect(agentBody(['--name', 'a', '--model', 'opencode-go/glm-5.1', '--harness', 'my harness 1.0', '--visibility', 'public'])).toMatchObject({
      route_key: 'opencode-go',
      harness: 'my harness 1.0',
      visibility: 'public',
    });
  });

  it('refuses an unknown provider or route, and a missing --name', () => {
    expect(() => agentBody(['--name', 'a', '--model', 'x/y', '--provider', 'acme'])).toThrow(/--provider must be one of/);
    expect(() => agentBody(['--name', 'a', '--model', 'x/y', '--route', 'acme'])).toThrow(/--route must be one of/);
    expect(() => agentBody(['--model', 'x/y'])).toThrow(/--name is required/);
  });

  it('POSTs /agents/local with the session and prints only the id on stdout', async () => {
    const env = tempEnv();
    writeSession({ format: SESSION_FORMAT, api_url: API, principal: 'dfl:x', session_id: 's', session_token: TOKEN, expires_at: '2099-01-01T00:00:00.000Z' }, env);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ agent: { id: '11111111-2222-4333-8444-555555555555', name: 'samuel-harness' } }), { status: 201 }));
    const io = captureIo();
    await agent(['create', '--name', 'samuel-harness', '--model', 'anthropic/claude-sonnet-4.6'], io, { env, fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/agents/local`);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(io.outText()).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('needs a login', async () => {
    await expect(agent(['create', '--name', 'a', '--model', 'anthropic/claude-sonnet-4.6'], captureIo(), { env: tempEnv() })).rejects.toThrow(/not logged in/);
  });
});

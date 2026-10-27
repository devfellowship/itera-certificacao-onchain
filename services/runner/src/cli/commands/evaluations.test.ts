import { describe, expect, it, vi } from 'vitest';
import { SESSION_FORMAT, writeSession } from '../session.js';
import { API, TOKEN, captureIo, tempEnv } from '../test/fixtures.js';
import { main } from '../tma.js';
import { evaluations } from './evaluations.js';

const ID = '5a9861e3-73d2-834f-9109-19c19592f99d';
const view = (over: Record<string, unknown> = {}) => ({
  id: ID, agent: { id: 'a', name: 'bench zai/glm-5.3' }, model: { id: 'zai/glm-5.3' }, tasks: [{ slug: 'dfl-transcript-mining' }], resultOrigin: 'self_declared', ...over,
});

function loggedIn() {
  const env = tempEnv();
  writeSession({ format: SESSION_FORMAT, api_url: API, principal: 'dfl:x', session_id: 's', session_token: TOKEN, expires_at: '2099-01-01T00:00:00.000Z' }, env);
  return env;
}

/** A fake API: GET answers `getAnswer`, DELETE answers `deleteAnswer`. Records every call. */
function api(getAnswer: [number, unknown], deleteAnswer: [number, unknown] = [200, { evaluationId: ID, deleted: true, deletedRuns: 1 }]) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const [status, body] = init.method === 'DELETE' ? deleteAnswer : getAnswer;
    return new Response(JSON.stringify(body), { status });
  });
}

const methods = (f: ReturnType<typeof api>) => f.mock.calls.map(([url, init]) => `${(init as RequestInit).method} ${String(url).replace(API, '')}`);

describe('tma evaluations delete', () => {
  it('with --yes: reads, then DELETEs /evaluations/:id with the session, and prints the id', async () => {
    const env = loggedIn();
    const fetchImpl = api([200, view()]);
    const io = captureIo();
    expect(await evaluations(['delete', ID, '--yes'], io, { env, fetchImpl: fetchImpl as unknown as typeof fetch })).toBe(0);
    expect(methods(fetchImpl)).toEqual([`GET /evaluations/${ID}`, `DELETE /evaluations/${ID}`]);
    const [, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(io.outText()).toBe(ID);
    expect(io.errText()).toMatch(/Deleted evaluation .*bench zai\/glm-5\.3.*\(1 run\(s\)\)/);
    expect(io.errText()).not.toContain(TOKEN);
  });

  it('asks first; "n" deletes nothing, "y" deletes', async () => {
    const env = loggedIn();
    const no = api([200, view()]);
    const confirmNo = vi.fn(async () => false);
    const io = captureIo();
    expect(await evaluations(['delete', ID], io, { env, fetchImpl: no as unknown as typeof fetch, confirm: confirmNo })).toBe(1);
    expect(confirmNo).toHaveBeenCalledOnce();
    expect(methods(no)).toEqual([`GET /evaluations/${ID}`]);
    expect(io.errText()).toContain('Not deleted.');

    const yes = api([200, view()]);
    expect(await evaluations(['delete', ID], captureIo(), { env, fetchImpl: yes as unknown as typeof fetch, confirm: async () => true })).toBe(0);
    expect(methods(yes)).toEqual([`GET /evaluations/${ID}`, `DELETE /evaluations/${ID}`]);
  });

  it('refuses without a terminal and without --yes, and sends no DELETE', async () => {
    const fetchImpl = api([200, view()]);
    await expect(evaluations(['delete', ID], captureIo(), { env: loggedIn(), fetchImpl: fetchImpl as unknown as typeof fetch, confirm: null })).rejects.toThrow(/--yes/);
    expect(methods(fetchImpl)).toEqual([`GET /evaluations/${ID}`]);
  });

  it('refuses a hosted evaluation before any DELETE', async () => {
    const fetchImpl = api([200, view({ resultOrigin: 'hosted' })]);
    await expect(evaluations(['delete', ID, '--yes'], captureIo(), { env: loggedIn(), fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(/only a self-declared/);
    expect(methods(fetchImpl)).toEqual([`GET /evaluations/${ID}`]);
  });

  it('says not found for an id that is not yours or is gone', async () => {
    const fetchImpl = api([404, { error: 'evaluation not found' }]);
    await expect(evaluations(['delete', ID, '--yes'], captureIo(), { env: loggedIn(), fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(/not found/);
    const gone = api([200, view()], [404, { error: 'evaluation not found' }]);
    await expect(evaluations(['delete', ID, '--yes'], captureIo(), { env: loggedIn(), fetchImpl: gone as unknown as typeof fetch })).rejects.toThrow(/not found/);
  });

  it('refuses a bad id or a missing sub-command, and needs a login', async () => {
    await expect(evaluations(['delete', 'abc', '--yes'], captureIo(), { env: loggedIn() })).rejects.toThrow(/not an evaluation id/);
    await expect(evaluations(['list'], captureIo(), { env: loggedIn() })).rejects.toThrow(/usage: tma evaluations delete/);
    await expect(evaluations(['delete', ID, '--yes'], captureIo(), { env: tempEnv() })).rejects.toThrow(/not logged in/);
  });

  it('is listed in tma help', async () => {
    const io = captureIo();
    await main(['help'], io);
    expect(io.outText()).toMatch(/evaluations\s+Delete one of your self-declared evaluations/);
  });
});

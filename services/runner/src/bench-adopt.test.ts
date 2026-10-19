import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { adoptBenchRuns, historicalOutcome, validateAdoptionScope } from './bench-adopt.js';

describe('historical benchmark adoption', () => {
  it('rolls back and releases the connection before any write when the principal does not match', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] }));
    const release = vi.fn();
    const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
    await expect(adoptBenchRuns(pool, { email: 'user@example.com', owner: 'dfl:user', expectedRuns: 1, agentIds: ['agent'], campaigns: ['campaign'], packs: [{ id: 'pack', name: 'Task', description: 'Task', versions: [] }] }, true)).rejects.toThrow('expected principal');
    expect(query.mock.calls.map((call) => call[0])).toEqual([
      'begin', 'select pg_advisory_xact_lock(hashtext($1))',
      'select principal_id from public.users where lower(email) = lower($1) and principal_id = $2', 'rollback',
    ]);
    expect(release).toHaveBeenCalledOnce();
  });
  it('retains scores only for scored pass/fail results', () => {
    expect(historicalOutcome({ status: 'pass', score_total: 100 })).toEqual({ status: 'graded', score: 100, pass: 1, fail: 0, invalid: 0 });
    expect(historicalOutcome({ status: 'fail', score_total: 45 })).toEqual({ status: 'graded', score: 45, pass: 0, fail: 1, invalid: 0 });
    expect(historicalOutcome({ status: 'timeout', score_total: 25 })).toMatchObject({ status: 'graded', score: null, invalid: 1 });
    expect(historicalOutcome({ status: 'invalid', score_total: 0 })).toMatchObject({ score: null, invalid: 1 });
    expect(historicalOutcome({ status: 'infra_error', score_total: null })).toMatchObject({ status: 'review', score: null });
    expect(() => historicalOutcome({ status: 'running', score_total: null })).toThrow('terminal');
  });
  it('requires exact scope, identity and ownership before mutation', () => {
    const scope = { owner: 'dfl:user', expectedRuns: 1, agentIds: ['agent'], packs: [{ id: 'pack' }], campaigns: ['campaign'] };
    const run = { id: 'run', owner_wallet: null, agent_owner: null, agent_id: 'agent', task_pack_id: 'pack', campaign_id: 'campaign', status: 'pass', score_total: 100, evaluation_id: null, task_id: null, task_version_id: null };
    expect(() => validateAdoptionScope(scope, [run])).not.toThrow();
    expect(() => validateAdoptionScope(scope, [])).toThrow('count');
    expect(() => validateAdoptionScope(scope, [{ ...run, owner_wallet: 'other' }])).toThrow('owner');
    expect(() => validateAdoptionScope(scope, [{ ...run, agent_owner: 'other' }])).toThrow('owner');
    expect(() => validateAdoptionScope(scope, [{ ...run, agent_id: 'other' }])).toThrow('agent');
    expect(() => validateAdoptionScope(scope, [{ ...run, task_id: 'already-linked' }])).toThrow('link');
    expect(() => validateAdoptionScope(scope, [{ ...run, campaign_id: 'other' }])).toThrow('campaign');
  });
});

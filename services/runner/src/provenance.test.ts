import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { campaignAllows, recordCampaignStop } from './bench-enqueue.js';
import { opencodeVersionOf, runnerFacts, taskWallMs, treeDigest } from './provenance.js';
import { defaultSandboxConfig, staleSandboxTags } from './sandbox.js';

const RUNNER = resolve(import.meta.dirname, '..');

describe('provenance facts (K11)', () => {
  it('reads the pinned opencode version from the sandbox Dockerfile', async () => {
    expect(opencodeVersionOf('RUN npm install -g opencode-ai@1.18.31 && npm cache clean')).toBe('1.18.31');
    expect(opencodeVersionOf('nothing')).toBeNull();
    const facts = await runnerFacts(RUNNER, 'itera-runner-sandbox:abc', 'sha256:1', { SOURCE_COMMIT: 'deadbeef' });
    expect(facts.opencodeVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(facts.runnerDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(facts.runnerCommit).toBe('deadbeef');
  });
  it('the runner digest is stable', async () => {
    expect(await treeDigest(RUNNER, ['profiles'])).toBe(await treeDigest(RUNNER, ['profiles']));
  });
  it('the wall cap follows the task timeout, up to the worker maximum', () => {
    const config = defaultSandboxConfig({});
    expect(taskWallMs(600, config)).toBe(600_000);
    expect(taskWallMs(5000, config)).toBe(900_000);
    expect(taskWallMs(null, config)).toBe(300_000);
    expect(taskWallMs(600, defaultSandboxConfig({ ITERA_RUN_MAX_WALL_MS: '300000' }))).toBe(300_000);
  });
});

describe('stale sandbox image tags (K11, disk)', () => {
  it('keeps the current tag and drops the others of the same repo', () => {
    const ls = 'itera-runner-sandbox:33aab2304290\nitera-runner-sandbox:ea9dd497b58f\nitera-runner-sandbox:<none>\nother:1\n';
    expect(staleSandboxTags(ls, 'itera-runner-sandbox:ea9dd497b58f')).toEqual(['itera-runner-sandbox:33aab2304290']);
  });
});

describe('campaign cap (K11)', () => {
  it('allows a run only while spent + every reserve fits under the cap', () => {
    expect(campaignAllows({ capUsd: 2, spentUsd: 0, inFlight: 0, reserveUsd: 0.5 })).toBe(true);
    expect(campaignAllows({ capUsd: 2, spentUsd: 1.5, inFlight: 0, reserveUsd: 0.5 })).toBe(true);
    expect(campaignAllows({ capUsd: 2, spentUsd: 1.51, inFlight: 0, reserveUsd: 0.5 })).toBe(false);
    expect(campaignAllows({ capUsd: 2, spentUsd: 0.6, inFlight: 2, reserveUsd: 0.5 })).toBe(false);
  });
});

describe('campaign stop record', () => {
  it('upserts the campaign row, because a first enqueue that stops rolls the row back', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = { query: async (sql: string, params: unknown[]) => (calls.push({ sql, params }), { rows: [] }) } as never;
    await recordCampaignStop(db, { id: 'c1', capUsd: 2 }, 'cap reached');
    expect(calls[0]!.sql).toMatch(/insert into public\.bench_campaigns[\s\S]*on conflict \(id\) do update set stopped_at = now\(\)/);
    expect(calls[0]!.params).toEqual(['c1', 2, 'cap reached']);
  });
});

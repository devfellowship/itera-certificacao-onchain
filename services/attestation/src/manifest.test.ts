import { describe, expect, it } from 'vitest';
import { manifestToAttestationData } from './manifest.js';
import type { EvidenceManifestSummary } from './manifest.js';

function manifest(overrides: Partial<EvidenceManifestSummary> = {}): EvidenceManifestSummary {
  return {
    scenario_id: 'webhook-ledger',
    fixture_hash: 'a'.repeat(64),
    patch_hash: 'b'.repeat(64),
    score: { total: 100 },
    generated_at: '2026-10-07T19:00:00.000Z',
    ...overrides,
  };
}

describe('manifestToAttestationData', () => {
  it('maps a full-score manifest onto the on-chain field shape', () => {
    const data = manifestToAttestationData(manifest());
    expect(data).toEqual({
      scenario_id: 'webhook-ledger',
      fixture_hash: 'a'.repeat(64),
      patch_hash: 'b'.repeat(64),
      score_total: 100,
      generated_at: '2026-10-07T19:00:00.000Z',
    });
  });

  it('accepts a score of 0', () => {
    expect(() => manifestToAttestationData(manifest({ score: { total: 0 } }))).not.toThrow();
  });

  it('rejects a score above 100 (does not fit SchemaDataType.U8 0-100 contract)', () => {
    expect(() => manifestToAttestationData(manifest({ score: { total: 101 } }))).toThrow(/score.total/);
  });

  it('rejects a negative score', () => {
    expect(() => manifestToAttestationData(manifest({ score: { total: -1 } }))).toThrow(/score.total/);
  });

  it('rejects a non-integer score', () => {
    expect(() => manifestToAttestationData(manifest({ score: { total: 99.5 } }))).toThrow(/score.total/);
  });

  it('rejects a missing scenario_id', () => {
    expect(() => manifestToAttestationData(manifest({ scenario_id: '' }))).toThrow(/missing a required field/);
  });

  it('rejects a missing fixture_hash', () => {
    expect(() => manifestToAttestationData(manifest({ fixture_hash: '' }))).toThrow(/missing a required field/);
  });
});

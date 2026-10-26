// The compatibility alias of the renamed bundles: production rows still hold the old pack ids
// (webhook-ledger, helpdesk-refunds); the folders are tsk_webhook_dup and tsk_helpdesk_refunds.
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_PACK_FOLDERS, packFolder, packIdOfFolder } from '../../evaluator/src/pack-folders.js';
import { scenarioDir, TaskError } from '../../evaluator/src/task.js';
import { curatedPacks } from './curated-packs.js';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

describe('packFolder: old pack id → bundle folder', () => {
  it('maps the two renamed bundles and leaves every other id as it is', () => {
    expect(packFolder('webhook-ledger')).toBe('tsk_webhook_dup');
    expect(packFolder('helpdesk-refunds')).toBe('tsk_helpdesk_refunds');
    expect(packFolder('tsk_webhook_dup')).toBe('tsk_webhook_dup');
    expect(packFolder('dfl-transcript-mining')).toBe('dfl-transcript-mining');
  });

  it('packIdOfFolder is the inverse: the worker registers the OLD id for a renamed folder', () => {
    expect(packIdOfFolder('tsk_webhook_dup')).toBe('webhook-ledger');
    expect(packIdOfFolder('tsk_helpdesk_refunds')).toBe('helpdesk-refunds');
    expect(packIdOfFolder('dfl-transcript-mining')).toBe('dfl-transcript-mining');
    for (const [id, folder] of Object.entries(LEGACY_PACK_FOLDERS)) {
      expect(packFolder(id)).toBe(folder);
      expect(packIdOfFolder(folder)).toBe(id);
    }
  });

  it('scenarioDir(repoRoot, <old id>) points at an existing folder with a task.json', () => {
    for (const id of ['webhook-ledger', 'helpdesk-refunds', 'tsk_webhook_dup', 'tsk_helpdesk_refunds', 'dfl-transcript-mining']) {
      const dir = scenarioDir(repoRoot, id);
      expect(dir).toBe(join(repoRoot, 'benchmarks', packFolder(id)));
      expect(statSync(join(dir, 'task.json')).isFile()).toBe(true);
    }
    expect(() => scenarioDir(repoRoot, '../etc')).toThrow(TaskError);
    expect(() => scenarioDir(repoRoot, 'Tsk_X')).toThrow(TaskError);
  });

  it('curatedPacks registers the renamed bundles under their OLD pack ids, with the new path', async () => {
    const { packs, errors } = await curatedPacks(repoRoot);
    expect(errors).toEqual([]);
    const byId = Object.fromEntries(packs.map((p) => [p.id, p.evaluatorRef]));
    expect(byId['webhook-ledger']).toBe('benchmarks/tsk_webhook_dup');
    expect(byId['helpdesk-refunds']).toBe('benchmarks/tsk_helpdesk_refunds');
    expect(byId).not.toHaveProperty('tsk_webhook_dup');
    expect(byId['dfl-transcript-mining']).toBe('benchmarks/dfl-transcript-mining');
  });
});

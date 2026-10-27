// Curated task packs (benchmarks/<id>/task.json) need a task_packs row before a run can reference
// them (runs.task_pack_id/version FK). task_packs is owned by postgres with RLS on and no policy,
// so a migration applied by the developer role cannot write it; the worker connects as the
// BYPASSRLS service role and registers every curated bundle at boot. Insert only: an existing
// row is never changed (a published pack version is immutable; a new version is a new row).
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { loadTask, taskDigests } from '../../evaluator/src/task.js';
import { BUNDLE_FOLDER } from '../../evaluator/src/pack-folders.js';

export interface CuratedPack {
  id: string;
  version: string;
  fixtureDigest: string;
  criteriaDigest: string;
  evaluatorRef: string;
}

export async function curatedPacks(repoRoot: string): Promise<{ packs: CuratedPack[]; errors: string[] }> {
  const dir = join(repoRoot, 'benchmarks');
  const packs: CuratedPack[] = [];
  const errors: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !BUNDLE_FOLDER.test(entry.name)) continue;
    try {
      const task = await loadTask(join(dir, entry.name));
      const d = await taskDigests(task);
      // The pack id IS the bundle folder name (= the catalog slug, plan TMA Q 5eff17c7). Q e9dc0ef2 = A
      // (TG 24074) renames the production pack ids to the folder names, so the worker registers the new
      // ids. The old rows (webhook-ledger, helpdesk-refunds) stay untouched: insert only.
      packs.push({ id: entry.name, version: task.contract.task.version, fixtureDigest: d.environment, criteriaDigest: d.hidden_tests, evaluatorRef: `benchmarks/${entry.name}` });
    } catch (err) {
      if (!String((err as Error).message).startsWith('no task.json')) errors.push(`${entry.name}: ${(err as Error).message}`);
    }
  }
  return { packs, errors };
}

export async function registerCuratedPacks(pool: Pool, repoRoot: string): Promise<{ inserted: number; known: number; errors: string[] }> {
  const { packs, errors } = await curatedPacks(repoRoot);
  let inserted = 0;
  for (const p of packs) {
    const r = await pool.query(
      `insert into public.task_packs (id, version, fixture_digest, criteria_digest, evaluator_ref)
       values ($1, $2, $3, $4, $5) on conflict (id, version) do nothing`,
      [p.id, p.version, p.fixtureDigest, p.criteriaDigest, p.evaluatorRef],
    );
    inserted += r.rowCount ?? 0;
  }
  return { inserted, known: packs.length - inserted, errors };
}

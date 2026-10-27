// Guard: every bundle folder under benchmarks/ is classified on purpose (plan TMA, Q 5eff17c7). It reads
// the real benchmarks/ folder and the static lists of catalog-slugs.ts. It goes red when:
//   1. a folder name does not match the slug pattern ^[a-z0-9][a-z0-9_-]{0,62}$;
//   2. a bundle in CATALOG_BUNDLES is not in CATALOG_SLUGS (the folder claims a task the catalog does not know);
//   3. a folder is in neither CATALOG_BUNDLES nor PRIVATE_BUNDLES (a new bundle must be classified);
//   4. a name is in both lists, or a listed name has no folder.
// Mutation proof: rename benchmarks/tsk_webhook_dup to webhook-ledger → red (4 and 3); add an empty
// benchmarks/new-thing/ → red (3). The old pack ids (renamed, Q e9dc0ef2 = A) must not be folders.
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUNDLE_FOLDER } from '../../../evaluator/src/pack-folders.js';
import { CATALOG_BUNDLES, CATALOG_SLUGS, PRIVATE_BUNDLES } from './catalog-slugs.js';
import { BENCHMARKS_DIR } from './tasks.js';

const folders = () => readdirSync(BENCHMARKS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

describe('benchmarks/ bundle folders are classified (catalog or private) and named like slugs', () => {
  it('1. every folder name matches the slug pattern', () => {
    expect(folders().filter((f) => !BUNDLE_FOLDER.test(f))).toEqual([]);
  });

  it('2. every catalog bundle is a slug of the static catalog list', () => {
    expect(CATALOG_BUNDLES.filter((b) => !(CATALOG_SLUGS as readonly string[]).includes(b))).toEqual([]);
  });

  it('3. every folder is in CATALOG_BUNDLES or in PRIVATE_BUNDLES', () => {
    const known = new Set<string>([...CATALOG_BUNDLES, ...PRIVATE_BUNDLES]);
    expect(folders().filter((f) => !known.has(f))).toEqual([]);
  });

  it('4. no name is in both lists, and every listed name has a folder', () => {
    const present = new Set(folders());
    expect(CATALOG_BUNDLES.filter((b) => (PRIVATE_BUNDLES as readonly string[]).includes(b))).toEqual([]);
    expect([...CATALOG_BUNDLES, ...PRIVATE_BUNDLES].filter((b) => !present.has(b))).toEqual([]);
  });

  it('the old pack ids (webhook-ledger, helpdesk-refunds) are not folders', () => {
    const present = new Set(folders());
    for (const old of ['webhook-ledger', 'helpdesk-refunds']) expect(present.has(old)).toBe(false);
  });

  it('the slug pattern is the one of task.catalog.slug in local-result.schema.json', () => {
    expect(BUNDLE_FOLDER.source).toBe('^[a-z0-9][a-z0-9_-]{0,62}$');
    expect(CATALOG_SLUGS.filter((s) => !BUNDLE_FOLDER.test(s))).toEqual([]);
  });
});

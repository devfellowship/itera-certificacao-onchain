// The bundle folder under benchmarks/ of a task pack id, and back (plan TMA, Q 5eff17c7: the folder
// name IS the catalog slug). Two bundles were renamed to their catalog slugs on 2026-10-26; production
// rows still hold the old pack ids (task_packs.id, task_versions.pack_id, runs.task_pack_id); renaming
// them is a data change (separate decision). So the hosted worker keeps the OLD id as the pack id and
// only the PATH changes. This module is the one place that knows the alias.

/** Old pack id (still in production rows) → the bundle folder it lives in today. */
export const LEGACY_PACK_FOLDERS = {
  'webhook-ledger': 'tsk_webhook_dup',
  'helpdesk-refunds': 'tsk_helpdesk_refunds',
} as const;

/** A bundle folder name, and the slug of a catalog task: lowercase, digits, `_` and `-`. */
export const BUNDLE_FOLDER = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const isLegacy = (id: string): id is keyof typeof LEGACY_PACK_FOLDERS => Object.hasOwn(LEGACY_PACK_FOLDERS, id);

/** The folder under benchmarks/ for a pack or scenario id: the new folder for an old pack id, `id` otherwise. */
export function packFolder(id: string): string {
  return isLegacy(id) ? LEGACY_PACK_FOLDERS[id] : id;
}

/** The pack id that the worker registers for a bundle folder: the OLD id for a renamed bundle, the folder otherwise. */
export function packIdOfFolder(folder: string): string {
  for (const [id, f] of Object.entries(LEGACY_PACK_FOLDERS)) if (f === folder) return id;
  return folder;
}

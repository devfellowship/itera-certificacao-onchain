// The bundle folder under benchmarks/ of a task pack id (plan TMA, Q 5eff17c7: the folder name IS the
// catalog slug). Since Q e9dc0ef2 = A (TG 24074) the production pack ids are the folder names too
// (task_packs.id, task_versions.pack_id, runs.task_pack_id): a pack id is its folder, with no alias.
// services/runner/src/pack-ids.guard.test.ts keeps every pack id that the code names a real folder.

/** A bundle folder name, a pack id, and the slug of a catalog task: lowercase, digits, `_` and `-`. */
export const BUNDLE_FOLDER = /^[a-z0-9][a-z0-9_-]{0,62}$/;

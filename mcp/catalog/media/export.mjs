// /itera/export for media@1: the metadata of every file ever stored (deleted ones included, with
// `deleted: true`), sorted by id. The bytes are not exported: `sha256` and `size` identify them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export async function exportState(stateDir) {
  const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
  return {
    files: state.files.map((f) => ({ ...f, deleted: Boolean(f.deleted_at) })).sort(byId),
  };
}

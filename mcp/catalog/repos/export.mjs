// /itera/export for repos@1: the fleet (HEAD SHA per repo, so a seed change shows) and the READ LOG.
// Arrays are sorted by a stable key, so the same seed + the same calls give the same bytes.
//
// Shape (the mcp_state scorer filters on one key, so every entry has a single-string `id`):
//   repos:       [{ id: "org/repo", head, commits, files }]
//   files_read:  [{ id: "org/repo:path", repo, path, reads, first_seq }]   successful reads of a real file
//   dirs_listed: [{ id: "org/repo:path" | ":org", repo, path, tool, count }]
//   searches:    [{ seq, tool, repo, path, pattern }]                        search_files calls, in order
//   git:         [{ seq, tool, repo, revision? }]                           git_log / git_show calls, in order
//   calls:       successful tool calls;  calls_outside: successful calls on a path outside the fleet
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
};
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export async function exportState(stateDir) {
  const fleet = readJson(join(stateDir, 'fleet.json'), []);
  const log = readJson(join(stateDir, 'readlog.json'), {});
  return {
    repos: fleet.map((r) => ({ id: r.id, head: r.head, commits: r.commits, files: r.files })).sort(byId),
    files_read: Object.values(log.files_read ?? {}).sort(byId),
    dirs_listed: Object.values(log.dirs_listed ?? {}).sort(byId),
    searches: [...(log.searches ?? [])].sort((a, b) => a.seq - b.seq),
    git: [...(log.git ?? [])].sort((a, b) => a.seq - b.seq),
    calls: log.calls ?? 0,
    calls_outside: log.calls_outside ?? 0,
  };
}

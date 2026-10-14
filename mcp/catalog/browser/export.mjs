// /itera/export for browser@1: the VISIT LOG. Arrays are sorted by a stable key, so the same seed +
// the same calls give the same bytes (screenshot hashes included: fonts are bundled in the image).
//
// Shape (the mcp_state scorer filters on one key, so every entry has a single-string `id`):
//   visits:      [{ id: "http://app.local/list@1280x800", view: "http://app.local/list@1280", url, host, path, width, height,
//                   first_seq, calls, screenshots, snapshots }]   a successful call while that URL was open at that viewport
//   screenshots: [{ seq, url, width, height, mime, bytes, sha256 }] every image the agent received, in order
//   navigations: [{ seq, url }]                                     browser_navigate calls, in order
//   requests:    [{ id: "app.local/list", host, path, status, count }]  what the site server served (no favicon)
//   blocked:     [{ id: "http://example.com", count }]              requests to any other host (refused)
//   calls:       successful tool calls;  calls_outside: successful calls while no seeded page was open
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export async function exportState(stateDir) {
  let s = {};
  try {
    s = JSON.parse(readFileSync(join(stateDir, 'browser.json'), 'utf-8'));
  } catch {
    s = {};
  }
  return {
    visits: Object.values(s.visits ?? {}).sort(byId),
    screenshots: [...(s.screenshots ?? [])].sort((a, b) => a.seq - b.seq),
    navigations: [...(s.navigations ?? [])].sort((a, b) => a.seq - b.seq),
    requests: Object.values(s.requests ?? {}).sort(byId),
    blocked: Object.entries(s.blocked ?? {}).map(([id, count]) => ({ id, count })).sort(byId),
    calls: s.calls ?? 0,
    calls_outside: s.calls_outside ?? 0,
  };
}

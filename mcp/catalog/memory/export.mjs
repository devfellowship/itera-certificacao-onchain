// /itera/export for memory@1: the knowledge graph from the upstream JSONL file, sorted.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function exportState(stateDir) {
  let text = '';
  try {
    text = readFileSync(join(stateDir, 'memory.jsonl'), 'utf-8');
  } catch {
    text = '';
  }
  const entities = [];
  const relations = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    if (item.type === 'entity') entities.push({ name: item.name, entityType: item.entityType, observations: [...item.observations].sort() });
    if (item.type === 'relation') relations.push({ from: item.from, to: item.to, relationType: item.relationType });
  }
  const key = (r) => `${r.from}\u0000${r.relationType}\u0000${r.to}`;
  entities.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  relations.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return { entities, relations };
}

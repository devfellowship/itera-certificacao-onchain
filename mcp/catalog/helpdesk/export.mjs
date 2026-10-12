// /itera/export for helpdesk@1: the state file as written after the last call. Sorted by id so the
// export never depends on the order of a search.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export async function exportState(stateDir) {
  const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
  return {
    customers: [...state.customers].sort(byId),
    orders: [...state.orders].sort(byId),
    tickets: [...state.tickets].sort(byId),
    refunds: [...state.refunds].sort(byId),
  };
}

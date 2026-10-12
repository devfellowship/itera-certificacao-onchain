// helpdesk@1 — Itera's own fixture server, τ-bench style (sierra-research/tau-bench: a database,
// a policy in the task instruction, tools, and a final-state check). The server enforces only the
// data rules (a refund never exceeds what is left on the order); the POLICY (refund window, limits,
// when to escalate) is in the task instruction, and following it is what the scorer measures.
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '/itera/fixture.mjs';

export const STATE_FILE = 'state.json';

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });

export function createDesk() {
  let state;
  let stateDir;
  let idSeed = 1000;

  const persist = () => {
    const tmp = join(stateDir, `${STATE_FILE}.tmp`);
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, join(stateDir, STATE_FILE));
  };
  const ticket = (id) => state.tickets.find((t) => t.id === id);
  const order = (id) => state.orders.find((o) => o.id === id);

  return {
    get state() {
      return state;
    },
    async init({ seed, stateDir: dir, idSeed: ids }) {
      stateDir = dir;
      idSeed = ids;
      state = {
        customers: seed.customers.map((c) => ({ tier: 'standard', ...c })),
        orders: seed.orders.map((o) => ({ refunded_cents: 0, ...o })),
        tickets: seed.tickets.map((t) => ({ notes: [], ...t })),
        refunds: [...(seed.refunds ?? [])],
      };
      persist();
    },
    async call(name, args, ctx) {
      switch (name) {
        case 'search_tickets': {
          const q = args.query?.toLowerCase();
          const hits = state.tickets.filter(
            (t) =>
              (!args.status || t.status === args.status) &&
              (!args.customer_id || t.customer_id === args.customer_id) &&
              (!q || `${t.subject}\n${t.body}`.toLowerCase().includes(q)),
          );
          return text(hits);
        }
        case 'get_customer': {
          const c = state.customers.find((x) => x.id === args.customer_id);
          return c ? text(c) : fail(`customer ${args.customer_id} not found`);
        }
        case 'get_order': {
          const o = order(args.order_id);
          return o ? text(o) : fail(`order ${args.order_id} not found`);
        }
        case 'issue_refund': {
          const o = order(args.order_id);
          if (!o) return fail(`order ${args.order_id} not found`);
          const t = ticket(args.ticket_id);
          if (!t) return fail(`ticket ${args.ticket_id} not found`);
          const left = o.total_cents - o.refunded_cents;
          if (args.amount_cents > left) return fail(`refund of ${args.amount_cents} cents exceeds the ${left} cents left on order ${o.id}`);
          const refund = {
            id: `RF-${idSeed + state.refunds.length + 1}`,
            order_id: o.id,
            ticket_id: t.id,
            amount_cents: args.amount_cents,
            reason: args.reason,
            created_at: ctx.clock(),
          };
          state.refunds.push(refund);
          o.refunded_cents += args.amount_cents;
          persist();
          return text(refund);
        }
        case 'close_ticket': {
          const t = ticket(args.ticket_id);
          if (!t) return fail(`ticket ${args.ticket_id} not found`);
          if (t.status === 'closed') return fail(`ticket ${t.id} is already closed`);
          t.status = 'closed';
          t.resolution = args.resolution;
          t.closed_at = ctx.clock();
          persist();
          return text(t);
        }
        case 'add_note': {
          const t = ticket(args.ticket_id);
          if (!t) return fail(`ticket ${args.ticket_id} not found`);
          t.notes.push({ text: args.text, at: ctx.clock() });
          persist();
          return text({ ticket_id: t.id, notes: t.notes.length });
        }
        default:
          return fail(`unknown tool ${name}`);
      }
    },
  };
}

if (process.argv[1] === import.meta.filename) {
  await serve(createDesk());
}

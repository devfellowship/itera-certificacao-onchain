// The `mcp` step of the validation gate (ADR-8 + ADR-11; docs/architecture/mcp-sandbox.md
// "Validation gate"). For a task that declares MCP servers, every server must:
//   1. resolve to a PUBLISHED catalog version with a digest, and every allowed tool must be in its snapshot;
//   2. boot with the task's seed (an invalid seed stops the sidecar with exit 3);
//   3. baseline: with NO tool call, the scorer assertions FAIL (at least one), so the task is not solved already;
//   4. solution: the replay of solution/mcp-calls.jsonl makes EVERY assertion pass;
//   5. repeatable: step 4 `repeats` times (default 3) gives the same export sha256.
// The result has counts only, never assertion text. Each boot is a fresh sidecar on a fresh
// --internal network; the replay runs inside the sidecar (docker exec /itera/call replay).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluateAssertions, parseCallLog, sha256 } from '../../evaluator/src/mcp-state.js';
import type { LoadedTask } from '../../evaluator/src/task.js';
import type { GateCheck } from '../../evaluator/src/validate.js';
import { bootSidecar, collectSidecar, docker, planSidecars, sidecarName, type Docker, type McpCatalogLookup, type McpSidecarPlan } from './mcp-sidecar.js';

export const MCP_SOLUTION_CALLS = 'solution/mcp-calls.jsonl';

interface ReplayLine {
  server?: string;
  tool: string;
  arguments?: Record<string, unknown>;
}

export async function readSolutionCalls(task: LoadedTask): Promise<ReplayLine[]> {
  const text = await readFile(join(task.dir, MCP_SOLUTION_CALLS), 'utf-8').catch(() => null);
  if (text === null) throw new Error(`${MCP_SOLUTION_CALLS} is missing`);
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      const v = JSON.parse(l);
      if (!v || typeof v.tool !== 'string') throw new Error(`${MCP_SOLUTION_CALLS} line ${i + 1}: needs "tool"`);
      return v as ReplayLine;
    });
}

/** Boot one fresh sidecar, optionally replay calls, export, score; then remove everything. */
async function trial(d: Docker, key: string, plan: McpSidecarPlan, calls: ReplayLine[] | null) {
  const network = `itera-sbx-${key}`;
  const cleanup: Array<() => Promise<unknown>> = [];
  try {
    const net = await d(['network', 'create', '--internal', '--label', 'itera.role=sandbox-net', network]);
    if (net.code !== 0) throw new Error(`network create failed: ${net.stderr.slice(0, 200)}`);
    cleanup.push(() => d(['network', 'rm', network]));
    const h = await bootSidecar({ d, name: sidecarName(key, plan.name), network, plan, cleanup });
    if (calls && calls.length > 0) {
      const input = calls.map((c) => JSON.stringify({ tool: c.tool, arguments: c.arguments ?? {} })).join('\n') + '\n';
      const r = await d(['exec', '-i', h.container, '/itera/call', 'replay'], { input, timeoutMs: 120_000 });
      if (r.code !== 0) throw new Error(`replay failed (exit ${r.code})`);
    }
    const c = await collectSidecar(h, d);
    if (c.error || !c.exportJson) throw new Error(c.error ?? 'no export');
    const result = evaluateAssertions(JSON.parse(c.exportJson), parseCallLog(c.callLog), plan.assertions ?? []);
    return { exportSha: sha256(c.exportJson), result };
  } finally {
    for (const step of cleanup) await step().catch(() => undefined);
  }
}

export function mcpGate(opts: { lookup: McpCatalogLookup | undefined; runId: string; d?: Docker }) {
  const d = opts.d ?? docker;
  const key = opts.runId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  return async (task: LoadedTask, repeats: number): Promise<GateCheck & { servers: number; assertions: number }> => {
    const plans = await planSidecars(task, opts.lookup);
    const scored = plans.filter((p) => p.assertions !== null);
    const total = scored.reduce((n, p) => n + p.assertions!.length, 0);
    const out = (ok: boolean, detail: string) => ({ ok, detail, servers: plans.length, assertions: total });
    if (scored.length === 0) return out(false, 'no MCP server exposes its state to the scorer (expose_state_to_scorer + assert.json)');
    const calls = await readSolutionCalls(task);
    for (const p of plans) {
      const mine = calls.filter((c) => (c.server ?? (plans.length === 1 ? p.name : undefined)) === p.name);
      if (p.assertions === null) continue;
      const base = await trial(d, `${key}-b-${p.name}`, p, null);
      if (base.result.failed.length === 0) return out(false, `${p.name}: all ${base.result.total} state assertions already hold with no tool call`);
      const shas = new Set<string>();
      for (let i = 0; i < repeats; i++) {
        const t = await trial(d, `${key}-s${i}-${p.name}`, p, mine);
        if (t.result.failed.length > 0) return out(false, `${p.name}: the solution calls leave ${t.result.failed.length} of ${t.result.total} state assertions failing`);
        shas.add(t.exportSha);
      }
      if (shas.size !== 1) return out(false, `${p.name}: the solution export differs across ${repeats} runs`);
    }
    return out(true, `${scored.length} server(s): ${total} state assertions FAIL on the seed and PASS after ${calls.length} solution calls, ${repeats}/${repeats} same export`);
  };
}

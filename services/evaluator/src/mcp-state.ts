// The `mcp_state` Scorer (ADR-11, docs/architecture/mcp-sandbox.md): declarative assertions over
// the FINAL STATE of an MCP fixture server and over its call log. It runs on the worker (trusted
// plane). The state comes from `/itera/export` (docker exec), never through a container that runs
// agent code; the assertions are in tests/hidden/mcp/<server>/assert.json, never in the workspace.
//
// Assertion forms (JSON array):
//   { "path": "$.tickets[?(@.id=='T-1')].status", "equals": "closed" }   every match equals, ≥ 1 match
//   { "path": "$.refunds", "count": 2 }                                  number of matches (an array path counts its items)
//   { "path": "$.refunds[?(@.ticket_id=='T-2')]", "exists": false }      ≥ 1 match / no match
//   { "calls": "issue_refund", "max": 2 }                                 successful calls of a tool: min / max / equals
// Path subset of JSONPath: $, .key, [n], [*], [?(@.key=='text')], [?(@.key==12)], and a final .length.
import { createHash } from 'node:crypto';
import type { Score } from './types.js';

export interface McpAssertion {
  path?: string;
  equals?: unknown;
  count?: number;
  exists?: boolean;
  calls?: string;
  min?: number;
  max?: number;
  /** Free text for the author; never published. */
  note?: string;
}

export interface McpCall {
  tool: string;
  ok: boolean;
}

export interface McpAssertionResult {
  passed: number;
  total: number;
  /** Indexes of the failed assertions (no assertion text leaves the trusted side). */
  failed: number[];
}

/** Per-server evidence the runner records in the EvalLog. Digests and counts only: the raw export stays private. */
export interface McpServerEvidence {
  server: string;
  catalog: string | null;
  image_digest: string | null;
  seed_sha256: string | null;
  export_sha256: string | null;
  calls: number;
  calls_ok: number;
  assertions: { passed: number; total: number } | null;
  error?: string;
}

export const MCP_STATE_WEIGHT = 50;
export const MAX_EXPORT_BYTES = 5 * 1024 * 1024;

type Seg = { key: string } | { index: number } | { all: true } | { filter: { key: string; value: string | number | boolean } } | { length: true };

export function parsePath(path: string): Seg[] {
  if (!path.startsWith('$')) throw new Error(`path must start with $: ${path}`);
  const segs: Seg[] = [];
  let i = 1;
  while (i < path.length) {
    if (path[i] === '.') {
      const m = /^\.([A-Za-z_][A-Za-z0-9_-]*)/.exec(path.slice(i));
      if (!m) throw new Error(`bad path at ${i}: ${path}`);
      segs.push(m[1] === 'length' && i + m[0].length === path.length ? { length: true } : { key: m[1]! });
      i += m[0].length;
    } else if (path[i] === '[') {
      const rest = path.slice(i);
      let m: RegExpExecArray | null;
      if ((m = /^\[(\d+)\]/.exec(rest))) segs.push({ index: Number(m[1]) });
      else if ((m = /^\[\*\]/.exec(rest))) segs.push({ all: true });
      else if ((m = /^\['([^']*)'\]/.exec(rest))) segs.push({ key: m[1]! });
      else if ((m = /^\[\?\(@\.([A-Za-z_][A-Za-z0-9_-]*)\s*==\s*(?:'([^']*)'|(-?\d+(?:\.\d+)?)|(true|false))\)\]/.exec(rest))) {
        const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? Number(m[3]) : m[4] === 'true';
        segs.push({ filter: { key: m[1]!, value } });
      } else throw new Error(`bad path at ${i}: ${path}`);
      i += m[0].length;
    } else throw new Error(`bad path at ${i}: ${path}`);
  }
  return segs;
}

/** Every node that the path selects. A filter or [*] on an array fans out. */
export function select(root: unknown, path: string): unknown[] {
  let nodes: unknown[] = [root];
  for (const seg of parsePath(path)) {
    const next: unknown[] = [];
    for (const n of nodes) {
      if ('key' in seg) {
        if (n && typeof n === 'object' && !Array.isArray(n) && seg.key in (n as object)) next.push((n as Record<string, unknown>)[seg.key]);
      } else if ('index' in seg) {
        if (Array.isArray(n) && seg.index < n.length) next.push(n[seg.index]);
      } else if ('all' in seg) {
        if (Array.isArray(n)) next.push(...n);
      } else if ('filter' in seg) {
        if (Array.isArray(n)) next.push(...n.filter((x) => x && typeof x === 'object' && (x as Record<string, unknown>)[seg.filter.key] === seg.filter.value));
      } else if ('length' in seg) {
        if (Array.isArray(n) || typeof n === 'string') next.push(n.length);
      }
    }
    nodes = next;
  }
  return nodes;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function holds(a: McpAssertion, state: unknown, calls: McpCall[]): boolean {
  if (a.calls !== undefined) {
    const n = calls.filter((c) => c.tool === a.calls && c.ok).length;
    if (a.equals !== undefined && n !== a.equals) return false;
    if (a.min !== undefined && n < a.min) return false;
    if (a.max !== undefined && n > a.max) return false;
    return a.equals !== undefined || a.min !== undefined || a.max !== undefined;
  }
  if (!a.path) return false;
  const nodes = select(state, a.path);
  if (a.count !== undefined) {
    const n = nodes.length === 1 && Array.isArray(nodes[0]) ? (nodes[0] as unknown[]).length : nodes.length;
    return n === a.count;
  }
  if (a.exists !== undefined) return a.exists ? nodes.length > 0 : nodes.length === 0;
  if ('equals' in a) return nodes.length > 0 && nodes.every((n) => same(n, a.equals));
  return false;
}

/** Validate the assertion file of a server. Returns error strings (empty = ok). */
export function assertionErrors(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return ['assert.json must be a non-empty array'];
  const errors: string[] = [];
  value.forEach((a, i) => {
    if (!a || typeof a !== 'object') return errors.push(`#${i}: not an object`);
    const x = a as McpAssertion;
    if (x.calls !== undefined) {
      if (typeof x.calls !== 'string') errors.push(`#${i}: calls must be a tool name`);
      if (x.equals === undefined && x.min === undefined && x.max === undefined) errors.push(`#${i}: calls needs equals, min or max`);
      return;
    }
    if (typeof x.path !== 'string') return errors.push(`#${i}: needs path or calls`);
    try {
      parsePath(x.path);
    } catch (err) {
      errors.push(`#${i}: ${(err as Error).message}`);
    }
    if (x.count === undefined && x.exists === undefined && !('equals' in x)) errors.push(`#${i}: needs equals, count or exists`);
  });
  return errors;
}

export function evaluateAssertions(state: unknown, calls: McpCall[], assertions: McpAssertion[]): McpAssertionResult {
  const failed: number[] = [];
  assertions.forEach((a, i) => {
    let ok = false;
    try {
      ok = holds(a, state, calls);
    } catch {
      ok = false;
    }
    if (!ok) failed.push(i);
  });
  return { passed: assertions.length - failed.length, total: assertions.length, failed };
}

/** Parse the call-log lines of a sidecar (`docker logs`). Lines that are not call events are ignored. */
export function parseCallLog(text: string): McpCall[] {
  const calls: McpCall[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const e = JSON.parse(t);
      if (e?.event === 'mcp_call' && typeof e.tool === 'string') calls.push({ tool: e.tool, ok: e.ok === true });
    } catch {
      /* not JSON */
    }
  }
  return calls;
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * The mcp_state Score over every scored server: value = round(weight × passed / total). Null
 * (UNSCORED, never zero) when a scored server has no export or no assertions.
 */
export function mcpStateScore(servers: McpServerEvidence[]): Score {
  const scored = servers.filter((s) => s.assertions !== null || s.error);
  const broken = scored.filter((s) => s.error || !s.assertions || s.assertions.total === 0);
  if (scored.length === 0 || broken.length > 0) {
    return {
      value: null,
      explanation: `unscored: the final MCP state of ${broken.map((s) => s.server).join(', ') || 'no server'} was not measured`,
      metadata: { weight: MCP_STATE_WEIGHT },
    };
  }
  const passed = scored.reduce((n, s) => n + s.assertions!.passed, 0);
  const total = scored.reduce((n, s) => n + s.assertions!.total, 0);
  return {
    value: Math.round((MCP_STATE_WEIGHT * passed) / total),
    answer: `${passed}/${total}`,
    explanation: `${passed} of ${total} final-state assertions hold on ${scored.map((s) => s.server).join(', ')}`,
    metadata: { weight: MCP_STATE_WEIGHT },
  };
}

// Per-run MCP sidecars (U29, ADR-11; docs/architecture/mcp-sandbox.md "Per-run lifecycle").
//
// For every server in the task's environment.tools.mcp[] the worker (trusted plane):
//   1. pins `catalog: name@version` to an image digest from the mcp_catalog table (status published);
//   2. creates the sidecar from that digest on the run's --internal network, alias mcp-<name>, with a
//      fresh 32-byte token, the allow-list, a fixed clock, resource limits, cap-drop ALL, read-only
//      rootfs, state in a tmpfs; copies the seed in with `docker cp`; starts it;
//   3. waits for readiness: `tools/list` through the token (docker exec /itera/call tools) must equal
//      the pinned tools snapshot filtered by allowed_tools — else the run stops before any model call;
//   4. writes the agent's opencode config: one remote MCP entry per server (url + Bearer header) and
//      the built-in tools the task does not allow switched off;
//   5. after the agent: exports the final state (docker exec /itera/export) and the call log
//      (docker logs), then removes the sidecar. The state never crosses a network port.
// Nothing here knows a server name: names, images and tools are data (task.json + mcp_catalog).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { opencodeAgentConfig, toolEnvironment } from '@itera/contracts';
import {
  assertionErrors,
  evaluateAssertions,
  MAX_EXPORT_BYTES,
  parseCallLog,
  sha256,
  type McpAssertion,
  type McpServerEvidence,
} from '../../evaluator/src/mcp-state.js';
import type { LoadedTask } from '../../evaluator/src/task.js';
import { exec } from './exec.js';

export const MCP_ROLE = 'mcp-sidecar';
export const MCP_PORT = 8080;
export const MCP_PATH = '/mcp';
export const MCP_UID = 10003;
export const DEFAULT_MCP_CLOCK = '2026-10-01T12:00:00Z';

/** One published catalog version (a row of mcp_catalog). */
export interface McpCatalogRef {
  name: string;
  version: number;
  image: string;
  imageDigest: string;
  manifest: { resources?: { cpus?: number; memory_mb?: number; pids?: number }; boot_timeout_sec?: number; call_timeout_sec?: number };
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  /** Tests only: a local image tag instead of image@digest (CI builds the image, nothing is published). */
  localImage?: string;
}

export type McpCatalogLookup = (name: string, version: number) => Promise<McpCatalogRef | null>;

export interface McpSidecarPlan {
  /** Task-local server name (alias mcp-<name>, opencode tools <name>_<tool>). */
  name: string;
  catalog: string;
  ref: McpCatalogRef;
  /** image@sha256:… — what `docker create` runs. */
  imageRef: string;
  allowedTools: string[];
  seed: Buffer;
  seedSha256: string;
  exposeState: boolean;
  /** tests/hidden/mcp/<name>/assert.json, parsed. Null when the state is not scored. */
  assertions: McpAssertion[] | null;
  bootTimeoutMs: number;
  limits: { cpus: number; memoryMb: number; pids: number };
}

export class McpPlanError extends Error {}

/** Worker caps on every sidecar (the manifest asks, the worker caps). */
export function sidecarCaps(env: NodeJS.ProcessEnv = process.env) {
  const num = (v: string | undefined, d: number) => (v && Number(v) > 0 ? Number(v) : d);
  return { cpus: num(env.ITERA_MCP_MAX_CPUS, 1), memoryMb: num(env.ITERA_MCP_MAX_MEMORY_MB, 512), pids: num(env.ITERA_MCP_MAX_PIDS, 128) };
}

/**
 * Resolve the task's MCP servers to runnable sidecar plans. Throws McpPlanError when a server is
 * not runnable: a custom image or command (needs a review first), a catalog version that is not
 * published, an allowed tool that the pinned snapshot does not have, or broken assertions.
 */
export async function planSidecars(task: LoadedTask, lookup: McpCatalogLookup | undefined, caps = sidecarCaps()): Promise<McpSidecarPlan[]> {
  const env = toolEnvironment(task.contract);
  const plans: McpSidecarPlan[] = [];
  for (const s of env.mcp) {
    if (!s.catalog) throw new McpPlanError(`MCP server ${s.name}: only Itera catalog servers run today (a custom image or command needs a review first)`);
    if (!lookup) throw new McpPlanError('this worker has no MCP catalog (mcp_catalog table)');
    const [cname, cver] = s.catalog.split('@');
    const ref = await lookup(cname!, Number(cver));
    if (!ref) throw new McpPlanError(`MCP server ${s.name}: catalog ${s.catalog} is not published`);
    const known = new Set(ref.tools.map((t) => t.name));
    const unknown = s.allowed_tools.filter((t: string) => !known.has(t));
    if (unknown.length > 0) throw new McpPlanError(`MCP server ${s.name}: ${s.catalog} has no tool ${unknown.join(', ')}`);
    const seed = s.seed ? await readFile(join(task.dir, s.seed)) : Buffer.from('{}');
    let assertions: McpAssertion[] | null = null;
    if (s.expose_state_to_scorer) {
      const file = join(task.paths.hiddenTests, 'mcp', s.name, 'assert.json');
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(file, 'utf-8'));
      } catch {
        throw new McpPlanError(`MCP server ${s.name}: expose_state_to_scorer needs ${task.contract.tests.hidden}/mcp/${s.name}/assert.json`);
      }
      const errors = assertionErrors(parsed);
      if (errors.length > 0) throw new McpPlanError(`MCP server ${s.name}: assert.json is invalid (${errors.length} problem(s))`);
      assertions = parsed as McpAssertion[];
    }
    const want = ref.manifest.resources ?? {};
    plans.push({
      name: s.name,
      catalog: s.catalog,
      ref,
      imageRef: ref.localImage ?? `${ref.image}@${ref.imageDigest}`,
      allowedTools: [...s.allowed_tools],
      seed,
      seedSha256: sha256(seed.toString('utf-8')),
      exposeState: s.expose_state_to_scorer === true,
      assertions,
      bootTimeoutMs: 1000 * Math.min(s.startup_timeout_sec ?? ref.manifest.boot_timeout_sec ?? 30, 120),
      limits: {
        cpus: Math.min(want.cpus ?? caps.cpus, caps.cpus),
        memoryMb: Math.min(want.memory_mb ?? caps.memoryMb, caps.memoryMb),
        pids: Math.min(want.pids ?? caps.pids, caps.pids),
      },
    });
  }
  return plans;
}

export const sidecarName = (runKey: string, server: string) => `itera-mcp-${runKey}-${server}`;
export const sidecarAlias = (server: string) => `mcp-${server}`;

/** `docker create` arguments of one sidecar. The token goes by NAME (-e ITERA_MCP_TOKEN): never in argv. */
export function buildSidecarArgs(opts: { name: string; network: string; plan: McpSidecarPlan; clock?: string }): string[] {
  const p = opts.plan;
  return [
    'create',
    '--name', opts.name,
    '--label', `itera.role=${MCP_ROLE}`,
    '--label', `itera.mcp.server=${p.name}`,
    '--network', opts.network,
    '--network-alias', sidecarAlias(p.name),
    '--read-only',
    '--tmpfs', `/state:rw,nosuid,nodev,size=64m,uid=${MCP_UID},gid=${MCP_UID},mode=0700`,
    '--mount', 'type=volume,dst=/seed',
    '--memory', `${p.limits.memoryMb}m`,
    '--memory-swap', `${p.limits.memoryMb}m`,
    '--cpus', String(p.limits.cpus),
    '--pids-limit', String(p.limits.pids),
    '--ulimit', 'nofile=1024:1024',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '-e', 'ITERA_MCP_TOKEN',
    '-e', `ITERA_MCP_ALLOWED_TOOLS=${p.allowedTools.join(',')}`,
    '-e', `ITERA_MCP_CLOCK=${opts.clock ?? DEFAULT_MCP_CLOCK}`,
    '-e', 'ITERA_MCP_ID_SEED=1000',
    p.imageRef,
  ];
}

/** A one-file ustar archive for `docker cp -` (the worker never writes the seed to a shared path). */
export function tarFile(name: string, body: Buffer, mode = 0o644): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 'utf-8');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512, 0), Buffer.alloc(1024, 0)]);
}

export type Docker = (args: string[], opts?: { env?: NodeJS.ProcessEnv; input?: Buffer | string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>;
export const docker: Docker = (args, opts = {}) => exec('docker', args, { env: opts.env, input: opts.input, timeoutMs: opts.timeoutMs ?? 60_000 });

export interface SidecarHandle {
  plan: McpSidecarPlan;
  container: string;
  token: string;
}

async function ensureImage(d: Docker, imageRef: string): Promise<void> {
  if ((await d(['image', 'inspect', '-f', '{{.Id}}', imageRef])).code === 0) return;
  const pulled = await d(['pull', '--quiet', imageRef], { timeoutMs: 300_000 });
  if (pulled.code !== 0) throw new Error(`MCP image ${imageRef} could not be pulled: ${pulled.stderr.slice(0, 200)}`);
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
const pick = (list: Array<{ name: string; description?: string; inputSchema?: unknown }>) =>
  JSON.stringify(canonical(list.map((t) => ({ name: t.name, description: t.description ?? null, inputSchema: t.inputSchema ?? null })).sort((a, b) => (a.name < b.name ? -1 : 1))));

/** Boot one sidecar and wait for readiness. Pushes its removal onto `cleanup` before it starts. */
export async function bootSidecar(opts: {
  d?: Docker;
  name: string;
  network: string;
  plan: McpSidecarPlan;
  cleanup: Array<() => Promise<unknown>>;
}): Promise<SidecarHandle> {
  const d = opts.d ?? docker;
  const token = randomBytes(32).toString('hex');
  await ensureImage(d, opts.plan.imageRef);
  await d(['rm', '-fv', opts.name]);
  const created = await d(buildSidecarArgs({ name: opts.name, network: opts.network, plan: opts.plan }), { env: { ...process.env, ITERA_MCP_TOKEN: token } });
  if (created.code !== 0) throw new Error(`MCP sidecar ${opts.plan.name} create failed: ${created.stderr.slice(0, 300)}`);
  opts.cleanup.unshift(() => d(['rm', '-fv', opts.name]));
  const cp = await d(['cp', '-', `${opts.name}:/seed`], { input: tarFile('seed.json', opts.plan.seed) });
  if (cp.code !== 0) throw new Error(`MCP seed copy failed: ${cp.stderr.slice(0, 300)}`);
  const started = await d(['start', opts.name]);
  if (started.code !== 0) throw new Error(`MCP sidecar ${opts.plan.name} start failed: ${started.stderr.slice(0, 300)}`);
  const deadline = Date.now() + opts.plan.bootTimeoutMs;
  for (;;) {
    const logs = await d(['logs', opts.name]);
    if (logs.stdout.includes('"event":"ready"')) break;
    const state = await d(['inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', opts.name]);
    const [running, code] = state.stdout.trim().split(' ');
    if (running !== 'true') {
      const fatal = logs.stdout.split('\n').find((l) => l.includes('"event":"fatal"')) ?? '';
      throw new Error(`MCP sidecar ${opts.plan.name} stopped at boot (exit ${code})${code === '3' ? ': the seed is invalid' : ''} ${fatal.slice(0, 300)}`);
    }
    if (Date.now() > deadline) throw new Error(`MCP sidecar ${opts.plan.name} not ready in ${opts.plan.bootTimeoutMs / 1000} s`);
    await new Promise((r) => setTimeout(r, 250));
  }
  // Readiness = the same tools/list the agent will see, against the pinned snapshot.
  const listed = await d(['exec', opts.name, '/itera/call', 'tools'], { timeoutMs: 20_000 });
  let tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
  try {
    tools = JSON.parse(listed.stdout);
  } catch {
    throw new Error(`MCP sidecar ${opts.plan.name}: tools/list failed (${listed.stderr.slice(0, 200)})`);
  }
  const expected = opts.plan.ref.tools.filter((t) => opts.plan.allowedTools.includes(t.name));
  if (pick(tools) !== pick(expected)) throw new Error(`MCP sidecar ${opts.plan.name}: tools/list differs from the pinned snapshot of ${opts.plan.catalog}`);
  return { plan: opts.plan, container: opts.name, token };
}

/**
 * The agent's opencode config for this run: the image's base config + one remote MCP entry per
 * sidecar + the built-in tools the task does not allow switched off. The deny list is a
 * convenience; the sidecar enforces allowed_tools itself.
 */
export function opencodeRunConfig(base: Record<string, unknown>, handles: SidecarHandle[], builtin: readonly string[]): Record<string, unknown> {
  // The same function builds the task editor preview (U31, packages/contracts): only the endpoint differs.
  const byName = new Map(handles.map((h) => [h.plan.name, h]));
  return {
    ...base,
    ...opencodeAgentConfig(
      handles.map((h) => ({ name: h.plan.name })),
      builtin,
      (name) => ({ url: `http://${sidecarAlias(name)}:${MCP_PORT}${MCP_PATH}`, token: byName.get(name)!.token }),
    ),
  };
}

export interface CollectedSidecar {
  server: string;
  exportJson: string | null;
  callLog: string;
  error?: string;
}

/** Final state (docker exec /itera/export, size-capped) + call log (docker logs). Never throws. */
export async function collectSidecar(h: SidecarHandle, d: Docker = docker): Promise<CollectedSidecar> {
  const logs = await d(['logs', h.container]).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  if (!h.plan.exposeState) return { server: h.plan.name, exportJson: null, callLog: logs.stdout };
  const out = await d(['exec', h.container, '/itera/export'], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, stdout: '', stderr: String(e) }));
  if (out.code !== 0) return { server: h.plan.name, exportJson: null, callLog: logs.stdout, error: `export failed (exit ${out.code})` };
  if (Buffer.byteLength(out.stdout) > MAX_EXPORT_BYTES) return { server: h.plan.name, exportJson: null, callLog: logs.stdout, error: 'export too large' };
  try {
    JSON.parse(out.stdout);
  } catch {
    return { server: h.plan.name, exportJson: null, callLog: logs.stdout, error: 'export is not JSON' };
  }
  return { server: h.plan.name, exportJson: out.stdout.trim(), callLog: logs.stdout };
}

/** Score the collected state of every server (trusted plane). Digests and counts only leave this function. */
export function mcpEvidence(plans: McpSidecarPlan[], collected: CollectedSidecar[]): McpServerEvidence[] {
  return plans.map((p) => {
    const c = collected.find((x) => x.server === p.name);
    const calls = parseCallLog(c?.callLog ?? '');
    const base = {
      server: p.name,
      catalog: p.catalog,
      image_digest: p.ref.imageDigest,
      seed_sha256: p.seedSha256,
      export_sha256: c?.exportJson ? sha256(c.exportJson) : null,
      calls: calls.length,
      calls_ok: calls.filter((x) => x.ok).length,
    };
    if (!p.exposeState || !p.assertions) return { ...base, assertions: null };
    if (!c || c.error || !c.exportJson) return { ...base, assertions: null, error: c?.error ?? 'no export' };
    const r = evaluateAssertions(JSON.parse(c.exportJson), calls, p.assertions);
    return { ...base, assertions: { passed: r.passed, total: r.total } };
  });
}

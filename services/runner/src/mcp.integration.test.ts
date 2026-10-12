// U29 against real Docker: the MCP sidecar lifecycle, the mcp_state score and the validation-gate
// `mcp` step on benchmarks/helpdesk-refunds, with the helpdesk image built from mcp/catalog.
//   ITERA_DOCKER_TESTS=1 ITERA_MCP_HELPDESK_IMAGE=itera-mcp-helpdesk:ci npx vitest run src/mcp.integration.test.ts
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTask, scenarioDir } from '../../evaluator/src/task.js';
import { mcpGate, readSolutionCalls } from './mcp-gate.js';
import { bootSidecar, collectSidecar, docker, mcpEvidence, planSidecars, sidecarName, type McpCatalogLookup } from './mcp-sidecar.js';

const enabled = process.env.ITERA_DOCKER_TESTS === '1' && !!process.env.ITERA_MCP_HELPDESK_IMAGE;
const repoRoot = join(import.meta.dirname, '..', '..', '..');
const catalogDir = join(repoRoot, 'mcp', 'catalog');

const lookup: McpCatalogLookup = async (name, version) => {
  const manifest = JSON.parse(await readFile(join(catalogDir, name, 'manifest.json'), 'utf-8'));
  if (manifest.version !== version) return null;
  const tools = JSON.parse(await readFile(join(catalogDir, name, 'tools.json'), 'utf-8'));
  return { name, version, image: `ghcr.io/devfellowship/itera-mcp-${name}`, imageDigest: `sha256:${'0'.repeat(64)}`, manifest, tools, localImage: process.env.ITERA_MCP_HELPDESK_IMAGE };
};

async function withNetwork<T>(fn: (net: string, key: string, cleanup: Array<() => Promise<unknown>>) => Promise<T>): Promise<T> {
  const key = randomUUID();
  const net = `itera-sbx-${key}`;
  const cleanup: Array<() => Promise<unknown>> = [];
  await docker(['network', 'create', '--internal', '--label', 'itera.role=sandbox-net', net]);
  cleanup.push(() => docker(['network', 'rm', net]));
  try {
    return await fn(net, key, cleanup);
  } finally {
    for (const step of cleanup) await step().catch(() => undefined);
  }
}

describe.runIf(enabled)('MCP sidecars against real Docker (U29)', () => {
  const taskDir = scenarioDir(repoRoot, 'helpdesk-refunds');

  it('the validation gate mcp step passes on the demo task', async () => {
    const task = await loadTask(taskDir);
    const check = await mcpGate({ lookup, runId: randomUUID() })(task, 3);
    expect(check, check.detail).toMatchObject({ ok: true, servers: 1, assertions: 14 });
  }, 240_000);

  it('the gate fails when the solution calls do not solve the task', async () => {
    const task = await loadTask(taskDir);
    const calls = (await readSolutionCalls(task)).filter((c) => c.tool !== 'issue_refund');
    const plans = await planSidecars(task, lookup);
    const evidence = await withNetwork(async (net, key, cleanup) => {
      const h = await bootSidecar({ name: sidecarName(key, 'helpdesk'), network: net, plan: plans[0]!, cleanup });
      await docker(['exec', '-i', h.container, '/itera/call', 'replay'], { input: calls.map((c) => JSON.stringify(c)).join('\n') + '\n' });
      return mcpEvidence(plans, [await collectSidecar(h)]);
    });
    expect(evidence[0]!.assertions!.passed).toBeLessThan(evidence[0]!.assertions!.total);
    expect(evidence[0]!.calls).toBe(calls.length);
  }, 120_000);

  it('the agent network reaches only the declared sidecar, with the token', async () => {
    const task = await loadTask(taskDir);
    const plans = await planSidecars(task, lookup);
    await withNetwork(async (net, key, cleanup) => {
      const h = await bootSidecar({ name: sidecarName(key, 'helpdesk'), network: net, plan: plans[0]!, cleanup });
      const probe = (network: string, host: string, auth: string) =>
        docker([
          'run', '--rm', '--network', network, '--entrypoint', 'node', process.env.ITERA_MCP_HELPDESK_IMAGE!, '-e',
          `fetch('http://${host}:8080/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'${auth}'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}),signal:AbortSignal.timeout(5000)}).then(r=>console.log(r.status),e=>console.log('unreachable'))`,
        ]);
      // Same run network: the declared server answers, and only with the token.
      expect((await probe(net, 'mcp-helpdesk', `Bearer ${h.token}`)).stdout.trim()).toBe('200');
      expect((await probe(net, 'mcp-helpdesk', 'Bearer wrong')).stdout.trim()).toBe('401');
      // A server the task did not declare does not exist on the run network.
      expect((await probe(net, 'mcp-memory', `Bearer ${h.token}`)).stdout.trim()).toBe('unreachable');
      // Another run's network cannot reach this run's sidecar.
      await withNetwork(async (other) => {
        expect((await probe(other, 'mcp-helpdesk', `Bearer ${h.token}`)).stdout.trim()).toBe('unreachable');
      });
    });
  }, 120_000);
});

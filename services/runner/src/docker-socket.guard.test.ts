// Guard (plan 20261026-tma-local-runner-and-self-declared-results, task L10, Q 37d5c296 = A):
// the Docker socket goes ONLY to the trusted runner process (the hosted worker container, or the local
// `tma-local` container that the participant starts on their own machine). It NEVER goes to a container
// that runs untrusted code: the agent sandbox, the model gateway, the grader and the MCP sidecars.
// This holds on the hosted worker AND on the local runner, because both use these same argv builders.
//
// The test fails when any of those builders gets a socket, a bind mount (a host path), or --privileged,
// and when any runner source file outside the allowlist below names the socket path.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraderArgs } from './grade.js';
import { buildSidecarArgs, type McpSidecarPlan } from './mcp-sidecar.js';
import { buildCreateArgs, buildGatewayArgs, defaultSandboxConfig } from './sandbox.js';

const FORBIDDEN = /docker\.sock|--privileged|(^| )-v( |$)|--volume|type=bind|--mount=type=bind|source=\/|src=\//;

function assertNoSocket(args: string[]) {
  const line = args.join(' ');
  expect(line).not.toMatch(FORBIDDEN);
  // `--mount` is allowed only for anonymous volumes (`type=volume,dst=...`, no source).
  args.forEach((a, i) => {
    if (a === '--mount') expect(args[i + 1]).toMatch(/^type=volume,dst=\/[a-z/]+$/);
  });
}

const config = defaultSandboxConfig({});

const plan: McpSidecarPlan = {
  name: 'helpdesk',
  catalog: 'helpdesk',
  ref: { name: 'helpdesk', version: '1.0.0' } as unknown as McpSidecarPlan['ref'],
  imageRef: `ghcr.io/devfellowship/testmyagent-mcp-helpdesk@sha256:${'a'.repeat(64)}`,
  allowedTools: ['list_tickets'],
  seed: Buffer.from('{}'),
  seedSha256: 'b'.repeat(64),
  exposeState: false,
  assertions: null,
  bootTimeoutMs: 10_000,
  limits: { cpus: 1, memoryMb: 256, pids: 64 },
} as McpSidecarPlan;

describe('no container that runs untrusted code gets the Docker socket (L10 guard)', () => {
  it('agent sandbox', () => assertNoSocket(buildCreateArgs({ name: 'itera-run-x', network: 'itera-sbx-x', model: 'x/y', prompt: 'p', config })));
  it('model gateway', () => assertNoSocket(buildGatewayArgs({ name: 'itera-gw-x', config })));
  it('grader', () => assertNoSocket(buildGraderArgs({ name: 'itera-grade-x-hidden', config, argv: ['npx', 'vitest', 'run'] })));
  it('MCP sidecar', () => assertNoSocket(buildSidecarArgs({ name: 'itera-mcp-x-helpdesk', network: 'itera-sbx-x', plan })));

  it('the guard itself catches a socket mount (mutation proof)', () => {
    const bad = [...buildCreateArgs({ name: 'n', network: 'net', model: 'x/y', prompt: 'p', config })];
    bad.splice(1, 0, '-v', '/var/run/docker.sock:/var/run/docker.sock');
    expect(() => assertNoSocket(bad)).toThrow();
    expect(() => assertNoSocket(['create', '--mount', 'type=bind,src=/var/run/docker.sock,dst=/s', 'img'])).toThrow();
  });
});

/** Runner source files that may name the socket path (comments and docs about the trusted side only). */
const SOCKET_TEXT_ALLOWED = new Set(['src/docker-socket.guard.test.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mts|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

describe('runner sources do not mount the socket into any container', () => {
  const root = join(import.meta.dirname, '..');
  it('no source file names docker.sock in code (outside the allowlist)', () => {
    const offenders = walk(join(root, 'src'))
      .map((p) => relative(root, p))
      .filter((p) => !SOCKET_TEXT_ALLOWED.has(p))
      .filter((p) =>
        readFileSync(join(root, p), 'utf-8')
          .split('\n')
          .some((line) => /docker\.sock/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)),
      );
    expect(offenders).toEqual([]);
  });
});

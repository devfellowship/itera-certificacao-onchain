// memory@1 — the MCP reference "memory" server (modelcontextprotocol/servers src/memory, npm
// @modelcontextprotocol/server-memory@2026.8.31, Apache-2.0 / MIT, see manifest.json `upstream`),
// wrapped as an Itera fixture. The upstream speaks stdio only: it runs as a child process INSIDE
// the sidecar, and the base fixture bridges it to streamable HTTP with the token, the allow-list
// and the call log. Its whole state is one JSONL file (MEMORY_FILE_PATH), so seed = write that
// file, export = read it.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { canonicalJson, serve, STATE_DIR } from '/itera/fixture.mjs';

export const MEMORY_FILE = 'memory.jsonl';
const require = createRequire('/itera/upstream/package.json');
const UPSTREAM_ENTRY = require.resolve('@modelcontextprotocol/server-memory/dist/index.js');

export function toJsonl(seed) {
  return [
    ...(seed.entities ?? []).map((e) => JSON.stringify({ type: 'entity', name: e.name, entityType: e.entityType, observations: e.observations })),
    ...(seed.relations ?? []).map((r) => JSON.stringify({ type: 'relation', from: r.from, to: r.to, relationType: r.relationType })),
  ].join('\n');
}

function upstreamAdapter() {
  let client;
  const start = async () => {
    if (client) return client;
    client = new Client({ name: 'itera-memory-bridge', version: '1.0.0' });
    // Only these variables reach the upstream process: no token, no allow-list.
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [UPSTREAM_ENTRY],
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', MEMORY_FILE_PATH: join(STATE_DIR, MEMORY_FILE) },
      stderr: 'ignore',
    }));
    return client;
  };
  return {
    async verifyTools(tools) {
      const { tools: up } = await (await start()).listTools();
      const pick = (list) => canonicalJson(list.map((t) => ({ name: t.name, inputSchema: t.inputSchema })).sort((a, b) => (a.name < b.name ? -1 : 1)));
      if (pick(up) !== pick(tools)) throw new Error('the upstream tools differ from tools.json');
    },
    async init({ seed, stateDir }) {
      writeFileSync(join(stateDir, MEMORY_FILE), toJsonl(seed));
    },
    async call(name, args) {
      const out = await (await start()).callTool({ name, arguments: args });
      return { content: out.content ?? [], ...(out.isError ? { isError: true } : {}) };
    },
  };
}

if (process.argv[1] === import.meta.filename) {
  await serve(upstreamAdapter());
}

// Trusted-plane commands of a fixture image. The worker runs them with `docker exec`, never the
// agent (the agent has no Docker API and no shell in the sidecar).
//
//   /itera/export          print the final state as canonical JSON (the adapter's export.mjs)
//   /itera/call tools      print the tools/list that a token holder sees (readiness check)
//   /itera/call replay     read JSONL {"tool","arguments"} on stdin, call each in order, print one
//                          JSONL result line per call {"seq","tool","ok","error"?} (validation gate)
//   /itera/call probe      print the HTTP status of a request WITHOUT the token (conformance: 401)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { canonicalJson, MCP_PATH, PORT, SERVER_DIR, STATE_DIR } from './fixture.mjs';

const MAX_REPLAY_LINES = 500;
const url = new URL(`http://127.0.0.1:${PORT}${MCP_PATH}`);

async function connect() {
  const token = process.env.ITERA_MCP_TOKEN ?? '';
  const client = new Client({ name: 'itera-trusted-cli', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

async function main() {
  const [command] = process.argv.slice(2);
  if (command === 'export') {
    const mod = await import(join(SERVER_DIR, 'export.mjs'));
    process.stdout.write(`${canonicalJson(await mod.exportState(STATE_DIR))}\n`);
    return;
  }
  if (command === 'probe') {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    process.stdout.write(`${res.status}\n`);
    return;
  }
  if (command === 'tools') {
    const client = await connect();
    const { tools } = await client.listTools();
    process.stdout.write(`${JSON.stringify(tools)}\n`);
    await client.close();
    return;
  }
  if (command === 'replay') {
    const lines = readStdin().split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > MAX_REPLAY_LINES) throw new Error(`at most ${MAX_REPLAY_LINES} calls`);
    const client = await connect();
    let seq = 0;
    for (const line of lines) {
      seq += 1;
      const { tool, arguments: args } = JSON.parse(line);
      try {
        const out = await client.callTool({ name: String(tool), arguments: args ?? {} });
        process.stdout.write(`${JSON.stringify({ seq, tool, ok: !out.isError })}\n`);
      } catch (err) {
        process.stdout.write(`${JSON.stringify({ seq, tool, ok: false, error: String(err?.message ?? err).slice(0, 200) })}\n`);
      }
    }
    await client.close();
    return;
  }
  process.stderr.write('usage: /itera/call tools | replay | probe   (and /itera/export)\n');
  process.exit(64);
}

main().catch((err) => {
  process.stderr.write(`${String(err?.message ?? err)}\n`);
  process.exit(1);
});

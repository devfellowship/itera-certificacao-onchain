#!/usr/bin/env node
// Conformance test of one catalog image against the fixture-server contract
// (docs/architecture/mcp-sandbox.md, registration step 2). Needs Docker. No npm dependency.
//
//   node mcp/conformance.mjs <name> <image>       e.g. node mcp/conformance.mjs helpdesk itera-mcp-helpdesk:ci
//   node mcp/conformance.mjs <name> <image> --write-expected   (re)write fixtures/expected-export.json
//
// Checks: boots with the fixture seed on an --internal network only (no route out); 401 without the
// token; tools/list equals tools.json minus the denied tool; a call to the denied tool is refused;
// the fixture calls give the expected export; a second fresh container gives the same export
// byte for byte; an invalid seed stops the server with exit code 3; no egress from the container.
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [name, image, flag] = process.argv.slice(2);
if (!name || !image || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) {
  console.error('usage: node mcp/conformance.mjs <name> <image> [--write-expected]');
  process.exit(2);
}
const dir = join(import.meta.dirname, 'catalog', name);
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
const tools = JSON.parse(readFileSync(join(dir, 'tools.json'), 'utf-8'));
const conf = JSON.parse(readFileSync(join(dir, 'fixtures', 'conformance.json'), 'utf-8'));
const calls = readFileSync(join(dir, 'fixtures', 'calls.jsonl'), 'utf-8').split('\n').filter((l) => l.trim());
const id = randomBytes(4).toString('hex');
const net = `itera-mcp-ct-${id}`;
const token = randomBytes(32).toString('hex');
const allowed = tools.map((t) => t.name).filter((n) => n !== conf.denied_tool);
const results = [];
let failed = 0;

const docker = (args, input) => {
  const r = spawnSync('docker', args, { input, encoding: 'utf-8', env: { ...process.env, ITERA_MCP_TOKEN: token }, timeout: 120_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const canonical = (v) =>
  Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Same flags as the runner (services/runner/src/mcp-sidecar.ts buildSidecarArgs). */
function boot(cname, seedText, allowList = allowed.join(',')) {
  const created = docker([
    'create', '--name', cname, '--network', net, '--network-alias', `mcp-${name}`,
    '--read-only', '--tmpfs', '/state:rw,nosuid,nodev,size=64m,uid=10003,gid=10003,mode=0700',
    '--mount', 'type=volume,dst=/seed',
    '--memory', `${manifest.resources.memory_mb}m`, '--memory-swap', `${manifest.resources.memory_mb}m`,
    '--cpus', String(manifest.resources.cpus), '--pids-limit', String(manifest.resources.pids),
    '--ulimit', 'nofile=1024:1024', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-e', 'ITERA_MCP_TOKEN', '-e', `ITERA_MCP_ALLOWED_TOOLS=${allowList}`,
    '-e', 'ITERA_MCP_CLOCK=2026-10-01T12:00:00Z', '-e', 'ITERA_MCP_ID_SEED=1000',
    image,
  ]);
  if (created.code !== 0) throw new Error(`create failed: ${created.stderr}`);
  const cp = spawnSync('docker', ['cp', '-', `${cname}:/seed`], { input: tarOf('seed.json', seedText) });
  if (cp.status !== 0) throw new Error(`seed copy failed: ${cp.stderr}`);
  docker(['start', cname]);
  const deadline = Date.now() + (manifest.boot_timeout_sec ?? 20) * 1000;
  while (Date.now() < deadline) {
    const logs = docker(['logs', cname]).stdout;
    if (logs.includes('"event":"ready"')) return true;
    const running = docker(['inspect', '-f', '{{.State.Running}}', cname]).stdout.trim();
    if (running !== 'true') return false;
    spawnSync('sleep', ['0.3']);
  }
  return false;
}

/** A one-file POSIX tar (ustar), so `docker cp -` can write into the volume of a created container. */
function tarOf(fileName, text) {
  const body = Buffer.from(text, 'utf-8');
  const header = Buffer.alloc(512, 0);
  header.write(fileName, 0, 'utf-8');
  header.write('0000644\0', 100);
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
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return Buffer.concat([header, body, pad, Buffer.alloc(1024, 0)]);
}

function exportOf(cname) {
  const out = docker(['exec', cname, '/itera/export']);
  if (out.code !== 0) throw new Error(`export failed: ${out.stderr}`);
  return out.stdout.trim();
}

const containers = [];
try {
  const n = docker(['network', 'create', '--internal', net]);
  if (n.code !== 0) throw new Error(`network create failed: ${n.stderr}`);
  const seedText = readFileSync(join(dir, 'fixtures', 'seed.json'), 'utf-8');

  const a = `itera-mcp-ct-${id}-a`;
  containers.push(a);
  check('boots with the fixture seed on an --internal network', boot(a, seedText), docker(['logs', a]).stdout.split('\n').find((l) => l.includes('fatal')) ?? '');

  const probe = docker(['exec', a, '/itera/call', 'probe']).stdout.trim();
  check('401 without the token', probe === '401', `got ${probe}`);

  const listed = JSON.parse(docker(['exec', '-e', 'ITERA_MCP_TOKEN', a, '/itera/call', 'tools']).stdout || '[]');
  const expected = tools.filter((t) => allowed.includes(t.name));
  const pick = (list) => JSON.stringify(canonical(list.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))));
  check('tools/list equals tools.json filtered by ITERA_MCP_ALLOWED_TOOLS', pick(listed) === pick(expected), `${listed.length} listed, ${expected.length} expected`);
  check('the denied tool is hidden from tools/list', !listed.some((t) => t.name === conf.denied_tool));

  const denied = docker(['exec', '-i', a, '/itera/call', 'replay'], `${JSON.stringify({ tool: conf.denied_tool, arguments: {} })}\n`);
  const deniedLine = JSON.parse(denied.stdout.trim().split('\n')[0] || '{}');
  check('a call to the denied tool is refused (JSON-RPC error)', deniedLine.ok === false && /not available/.test(deniedLine.error ?? ''), deniedLine.error ?? denied.stderr);

  const replay = (cname) => {
    const out = docker(['exec', '-i', cname, '/itera/call', 'replay'], calls.map((l) => JSON.stringify({ tool: JSON.parse(l).tool, arguments: JSON.parse(l).arguments })).join('\n') + '\n');
    return out.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  const got = replay(a);
  const wantOk = calls.map((l) => JSON.parse(l).expect_ok !== false);
  check('the fixture calls succeed or fail as expected', got.length === calls.length && got.every((r, i) => r.ok === wantOk[i]), JSON.stringify(got.map((r) => r.ok)));

  const exportA = exportOf(a);
  const expectedPath = join(dir, 'fixtures', 'expected-export.json');
  if (flag === '--write-expected') {
    writeFileSync(expectedPath, `${JSON.stringify(JSON.parse(exportA), null, 2)}\n`);
    console.log(`wrote ${expectedPath}`);
  }
  const expectedExport = JSON.stringify(canonical(JSON.parse(readFileSync(expectedPath, 'utf-8'))));
  check('the export equals fixtures/expected-export.json', exportA === expectedExport, `sha ${sha(exportA).slice(0, 12)} vs ${sha(expectedExport).slice(0, 12)}`);

  const logs = docker(['logs', a]).stdout.split('\n').filter((l) => l.includes('"event":"mcp_call"')).map((l) => JSON.parse(l));
  check('one call-log line per tool call (stdout)', logs.length === calls.length + 1 && logs.every((l) => typeof l.args_sha256 === 'string' && typeof l.ok === 'boolean'), `${logs.length} lines`);

  const egress = docker(['exec', a, 'node', '-e', "fetch('http://1.1.1.1',{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(0),()=>process.exit(7))"]);
  check('no egress from the run network', egress.code === 7, `exit ${egress.code}`);

  const b = `itera-mcp-ct-${id}-b`;
  containers.push(b);
  boot(b, seedText);
  // The same call sequence as container a, including the refused call (the fixed clock counts calls).
  docker(['exec', '-i', b, '/itera/call', 'replay'], `${JSON.stringify({ tool: conf.denied_tool, arguments: {} })}\n`);
  replay(b);
  const exportB = exportOf(b);
  check('same seed + same calls = same export, byte for byte', exportA === exportB);

  const c = `itera-mcp-ct-${id}-c`;
  containers.push(c);
  boot(c, '{"not":"a valid seed"}');
  spawnSync('sleep', ['1']);
  const exit = docker(['inspect', '-f', '{{.State.ExitCode}}', c]).stdout.trim();
  check('an invalid seed stops the server with exit code 3', exit === '3', `exit ${exit}`);

  const d = `itera-mcp-ct-${id}-d`;
  containers.push(d);
  boot(d, seedText, '');
  spawnSync('sleep', ['1']);
  const exitD = docker(['inspect', '-f', '{{.State.ExitCode}}', d]).stdout.trim();
  check('no allow-list stops the server (exit code 2)', exitD === '2', `exit ${exitD}`);
} catch (err) {
  check('conformance run', false, err.message);
} finally {
  for (const c of containers) docker(['rm', '-fv', c]);
  docker(['network', 'rm', net]);
}
console.log(`${name}: ${results.length - failed}/${results.length} conformance checks pass`);
process.exit(failed === 0 ? 0 : 1);

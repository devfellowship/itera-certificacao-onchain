// Shared code of every Itera MCP fixture server (docs/architecture/mcp-sandbox.md, "The
// fixture-server contract"). A catalog server is an ADAPTER module plus manifest.json and
// tools.json; this file gives it the fixed contract:
//
//   - streamable HTTP on :8080, path /mcp, stateless (a new MCP server object per request);
//   - Authorization: Bearer <ITERA_MCP_TOKEN> on every request, else 401;
//   - ITERA_MCP_ALLOWED_TOOLS: every other tool is hidden from tools/list and a call to it gets a
//     JSON-RPC error (the server is the enforcement point, never the harness config);
//   - the seed in /seed/seed.json, validated against manifest.seed_schema (invalid → exit 3);
//   - one JSON line per tool call on stdout (the call log, read with `docker logs`);
//   - the state lives in /state; `/itera/export` (a separate process, run with `docker exec`)
//     prints it. There is no network endpoint for the state.
//   - calls run one at a time, in arrival order, so the same seed plus the same calls gives the
//     same export byte for byte (fixed clock ITERA_MCP_CLOCK, fixed ids ITERA_MCP_ID_SEED).
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';

export const PORT = 8080;
export const MCP_PATH = '/mcp';
export const SEED_FILE = '/seed/seed.json';
export const STATE_DIR = process.env.ITERA_MCP_STATE_DIR ?? '/state';
export const SERVER_DIR = process.env.ITERA_MCP_SERVER_DIR ?? '/itera/server';
const MAX_BODY_BYTES = 1024 * 1024;
const MIN_TOKEN_LENGTH = 32;

/** Exit codes the worker reads (docker inspect State.ExitCode). */
export const EXIT = { config: 2, seed: 3, tools: 4 };

/** JSON with object keys sorted at every level: the export is compared by sha256. */
export function canonicalJson(value) {
  const canon = (v) =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
  return JSON.stringify(canon(value));
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function loadDefinition(dir = SERVER_DIR) {
  const manifest = readJson(join(dir, 'manifest.json'));
  const tools = readJson(join(dir, 'tools.json'));
  return { manifest, tools };
}

/** The allow-list from the environment. `*` = every tool of tools.json (conformance test only). */
export function allowedTools(raw, tools) {
  const all = tools.map((t) => t.name);
  if (raw === undefined || raw.trim() === '') return null;
  if (raw.trim() === '*') return new Set(all);
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !all.includes(n));
  if (unknown.length > 0) throw new Error(`ITERA_MCP_ALLOWED_TOOLS names unknown tools: ${unknown.join(', ')}`);
  return new Set(names);
}

/** Fixed clock: ITERA_MCP_CLOCK (ISO) + one second per call, so timestamps never depend on wall time. */
export function fixedClock(raw) {
  const base = Date.parse(raw ?? '2026-01-01T00:00:00Z');
  if (!Number.isFinite(base)) throw new Error('ITERA_MCP_CLOCK is not an ISO timestamp');
  return (step) => new Date(base + step * 1000).toISOString();
}

const log = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);
const fatal = (code, message) => {
  log({ event: 'fatal', code, error: message });
  process.exit(code);
};

function tokenOk(header, token) {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Start a fixture server.
 * adapter: {
 *   init({ seed, stateDir, clock, idSeed }): Promise<void>   load the seed, write the first state
 *   call(name, args, ctx): Promise<{ content, isError? }>     run one tool; persist the state before returning
 *   verifyTools?(tools): Promise<void>                        e.g. compare with an upstream server
 * }
 */
export async function serve(adapter, opts = {}) {
  const { manifest, tools } = loadDefinition(opts.serverDir);
  const token = process.env.ITERA_MCP_TOKEN ?? '';
  if (token.length < MIN_TOKEN_LENGTH) fatal(EXIT.config, `ITERA_MCP_TOKEN must have at least ${MIN_TOKEN_LENGTH} characters`);
  let allowed;
  try {
    allowed = allowedTools(process.env.ITERA_MCP_ALLOWED_TOOLS, tools);
  } catch (err) {
    fatal(EXIT.config, err.message);
  }
  if (!allowed) fatal(EXIT.config, 'ITERA_MCP_ALLOWED_TOOLS is required (comma list, or * for every tool)');

  const ajv = new Ajv({ allErrors: true, strict: false });
  let seed;
  try {
    seed = readJson(opts.seedFile ?? SEED_FILE);
  } catch (err) {
    fatal(EXIT.seed, `seed ${SEED_FILE} could not be read: ${err.message}`);
  }
  const validSeed = ajv.compile(manifest.seed_schema ?? {});
  if (!validSeed(seed)) {
    fatal(EXIT.seed, `seed does not match seed_schema: ${ajv.errorsText(validSeed.errors, { separator: '; ' }).slice(0, 800)}`);
  }
  const validators = new Map(tools.map((t) => [t.name, ajv.compile(t.inputSchema ?? { type: 'object' })]));
  const clock = fixedClock(process.env.ITERA_MCP_CLOCK);
  const idSeed = Number(process.env.ITERA_MCP_ID_SEED ?? 1000);
  try {
    if (adapter.verifyTools) await adapter.verifyTools(tools);
  } catch (err) {
    fatal(EXIT.tools, `tools do not match tools.json: ${err.message}`);
  }
  try {
    await adapter.init({ seed, stateDir: STATE_DIR, clock, idSeed: Number.isFinite(idSeed) ? idSeed : 1000 });
  } catch (err) {
    fatal(EXIT.seed, `seed could not be loaded: ${err.message}`);
  }

  const visible = tools.filter((t) => allowed.has(t.name));
  let seq = 0;
  let queue = Promise.resolve();
  const runCall = (name, args) => {
    const result = queue.then(async () => {
      seq += 1;
      const entry = { event: 'mcp_call', seq, tool: name, args_sha256: sha256(canonicalJson(args ?? {})), at: new Date().toISOString() };
      if (!allowed.has(name)) {
        log({ ...entry, ok: false, refused: 'not_allowed' });
        throw new McpError(ErrorCode.InvalidParams, `tool ${name} is not available in this run`);
      }
      const validate = validators.get(name);
      if (!validate(args ?? {})) {
        log({ ...entry, ok: false, refused: 'invalid_arguments' });
        return { isError: true, content: [{ type: 'text', text: `invalid arguments: ${ajv.errorsText(validate.errors, { separator: '; ' })}` }] };
      }
      try {
        const out = await adapter.call(name, args ?? {}, { step: seq, clock: () => clock(seq) });
        log({ ...entry, ok: !out.isError });
        return out;
      } catch (err) {
        log({ ...entry, ok: false, error: String(err?.message ?? err).slice(0, 200) });
        return { isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] };
      }
    });
    queue = result.catch(() => undefined);
    return result;
  };

  const mcpServer = () => {
    const server = new Server({ name: `itera-${manifest.name}`, version: String(manifest.version) }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visible }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => runCall(req.params.name, req.params.arguments));
    return server;
  };

  const http = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (!tokenOk(req.headers.authorization, token)) {
      log({ event: 'auth_denied', method: req.method });
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: ErrorCode.ParseError, message: 'parse error' }, id: null }));
      return;
    }
    const server = mcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: ErrorCode.InternalError, message: 'internal error' }, id: null }));
      log({ event: 'http_error', error: String(err?.message ?? err).slice(0, 200) });
    }
  });
  http.listen(PORT, '0.0.0.0', () => log({ event: 'ready', name: manifest.name, version: manifest.version, tools: visible.map((t) => t.name) }));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => http.close(() => process.exit(0)));
}

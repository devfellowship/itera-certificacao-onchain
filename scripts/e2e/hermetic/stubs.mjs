// Hermetic web3 e2e guard (T14): ONE local HTTP server that stands in for every paid or keyed
// third party of the hackathon flow, so the guard needs no model key, no Pinata JWT and no price API.
//
//   node scripts/e2e/hermetic/stubs.mjs --port 18080 --patch benchmarks/tsk_webhook_dup/solution/solution.patch
//
// Routes:
//   POST /api/v1/chat/completions      OpenRouter-compatible model (the run gateway's upstream,
//                                      ITERA_MODEL_UPSTREAM). Deterministic: the first agent turn
//                                      calls the `bash` tool with `git apply` of --patch; every
//                                      later turn answers text and stops. Streams (SSE) or not, as
//                                      the request asks. Every answer carries `usage.cost`.
//   GET  /v2/updates/price/latest      Pyth Hermes (ITERA_PYTH_HERMES_URL): SOL/USD, publish_time = now.
//   GET  /api/v3/simple/price          CoinGecko (ITERA_COINGECKO_URL), the last price fallback.
//   POST /pinning/pinFileToIPFS        Pinata (ITERA_PINATA_API_URL): keeps the bytes in memory and
//                                      answers a CIDv1 (raw, sha2-256) of exactly those bytes.
//   GET  /ipfs/<cid>                   IPFS gateway for the verifier: the pinned bytes, unchanged.
//   GET  /health                       200, and counters of what was served.
//
// Test infrastructure only. It listens on 0.0.0.0 because the run's model gateway container
// reaches it through the Docker bridge (172.17.0.1). Run it only on a throwaway CI runner.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values: argv } = parseArgs({
  options: {
    port: { type: 'string', default: '18080' },
    host: { type: 'string', default: '0.0.0.0' },
    patch: { type: 'string' },
    'sol-usd': { type: 'string', default: '150' },
  },
});
if (!argv.patch) {
  console.error('usage: stubs.mjs --patch <unified diff the stub agent applies> [--port 18080]');
  process.exit(2);
}
const PATCH = readFileSync(argv.patch, 'utf8');
const SOL_USD = Number(argv['sol-usd']);
const pins = new Map();
const counters = { model: 0, modelToolCalls: 0, hermes: 0, coingecko: 0, pins: 0, ipfsGets: 0 };
const log = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

// ------------------------------------------------------------------------------------------------
// CIDv1, raw codec (0x55), sha2-256 multihash, base32 lower (multibase prefix "b").
function cidV1Raw(bytes) {
  const digest = createHash('sha256').update(bytes).digest();
  const raw = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = 'b';
  for (const byte of raw) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

// ------------------------------------------------------------------------------------------------
// The model. The command is one bash call; opencode runs it in the agent's workspace (its cwd).
const APPLY_COMMAND = `git apply --whitespace=nowarn <<'ITERA_E2E_PATCH_EOF'\n${PATCH.endsWith('\n') ? PATCH : `${PATCH}\n`}ITERA_E2E_PATCH_EOF`;
const USAGE = { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, cost: 0.0004 };

function modelReply(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolName = tools.map((t) => t?.function?.name).find((n) => typeof n === 'string' && /(^|_)bash$/.test(n));
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const alreadyCalled = messages.some((m) => m?.role === 'tool' || (Array.isArray(m?.tool_calls) && m.tool_calls.length > 0));
  if (toolName && !alreadyCalled) {
    counters.modelToolCalls += 1;
    return {
      kind: 'tool',
      toolCall: {
        id: `call_e2e_${counters.modelToolCalls}`,
        type: 'function',
        function: { name: toolName, arguments: JSON.stringify({ command: APPLY_COMMAND, description: 'Apply the fix to src/', timeout: 60000 }) },
      },
    };
  }
  return { kind: 'text', text: 'Applied the fix. Done.' };
}

function sendModel(req, res, body) {
  counters.model += 1;
  const reply = modelReply(body);
  const id = `gen-e2e-${counters.model}`;
  const created = Math.floor(Date.now() / 1000);
  const model = typeof body.model === 'string' ? body.model : 'e2e/stub';
  const base = { id, created, model, provider: 'E2E-stub' };
  log({ route: 'model', stream: body.stream === true, reply: reply.kind, tools: Array.isArray(body.tools) ? body.tools.length : 0, messages: Array.isArray(body.messages) ? body.messages.length : 0 });
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (doc) => res.write(`data: ${JSON.stringify(doc)}\n\n`);
    if (reply.kind === 'tool') {
      send({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, ...reply.toolCall }] }, finish_reason: null }] });
      send({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }] });
      send({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    send({ ...base, object: 'chat.completion.chunk', choices: [], usage: USAGE });
    res.end('data: [DONE]\n\n');
    return;
  }
  const message = reply.kind === 'tool' ? { role: 'assistant', content: null, tool_calls: [reply.toolCall] } : { role: 'assistant', content: reply.text };
  json(res, 200, { ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: reply.kind === 'tool' ? 'tool_calls' : 'stop' }], usage: USAGE });
}

// ------------------------------------------------------------------------------------------------
// Multipart (Pinata pinFileToIPFS): the bytes of the part named "file".
function multipartFile(contentType, body) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!boundary) return null;
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let at = body.indexOf(delimiter);
  while (at >= 0) {
    const next = body.indexOf(delimiter, at + delimiter.length);
    if (next < 0) break;
    const part = body.subarray(at + delimiter.length + 2, next - 2); // skip CRLF after the delimiter and before the next
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd >= 0 && /name="file"/.test(part.subarray(0, headerEnd).toString('utf8'))) return part.subarray(headerEnd + 4);
    at = next;
  }
  return null;
}

function json(res, status, doc) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(doc));
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const body = Buffer.concat(chunks);
    try {
      if (req.method === 'POST' && url.pathname === '/api/v1/chat/completions') {
        return sendModel(req, res, JSON.parse(body.toString('utf8') || '{}'));
      }
      if (req.method === 'GET' && url.pathname === '/v2/updates/price/latest') {
        counters.hermes += 1;
        const feed = (url.searchParams.get('ids[]') ?? '').replace(/^0x/, '');
        return json(res, 200, { parsed: [{ id: feed, price: { price: String(Math.round(SOL_USD * 1e8)), conf: '1000', expo: -8, publish_time: Math.floor(Date.now() / 1000) } }] });
      }
      if (req.method === 'GET' && url.pathname === '/api/v3/simple/price') {
        counters.coingecko += 1;
        return json(res, 200, { solana: { usd: SOL_USD } });
      }
      if (req.method === 'POST' && url.pathname === '/pinning/pinFileToIPFS') {
        const file = multipartFile(req.headers['content-type'], body);
        if (!file) return json(res, 400, { error: 'no file part' });
        if (!/^Bearer \S+/.test(req.headers.authorization ?? '')) return json(res, 401, { error: 'no bearer token' });
        const cid = cidV1Raw(file);
        pins.set(cid, Buffer.from(file));
        counters.pins += 1;
        log({ route: 'pin', cid, bytes: file.length });
        return json(res, 200, { IpfsHash: cid, PinSize: file.length, Timestamp: new Date().toISOString() });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/ipfs/')) {
        counters.ipfsGets += 1;
        const bytes = pins.get(url.pathname.slice('/ipfs/'.length));
        if (!bytes) return json(res, 404, { error: 'not pinned here' });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) });
        return res.end(bytes);
      }
      if (url.pathname === '/health') return json(res, 200, { ok: true, counters });
      log({ route: 'unknown', method: req.method, path: url.pathname });
      json(res, 404, { error: `stub has no route ${req.method} ${url.pathname}` });
    } catch (e) {
      log({ route: 'error', error: e instanceof Error ? e.message : String(e) });
      json(res, 500, { error: 'stub error' });
    }
  });
});

server.listen(Number(argv.port), argv.host, () => log({ event: 'listening', port: Number(argv.port), patchBytes: PATCH.length }));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));

// Model gateway for the ITERA agent sandbox. It is the ONLY host that a sandbox can reach:
// the sandbox network is `internal` (no route out), and this container sits on it.
//
// - It forwards plain-HTTP requests under ITERA_GATEWAY_PATH_PREFIX (default /api/v1/) to
//   ITERA_UPSTREAM (default https://openrouter.ai) and ADDS the Authorization header itself.
//   The sandbox holds no model key, so an agent cannot read, print or exfiltrate it.
// - It refuses everything else: other paths (403), HTTP CONNECT tunnels (403), any other host.
//
// - It METERS the run: it reads the `usage` (tokens + cost in USD) of every upstream response and
//   logs the running total as a `{"event":"usage",...}` line. The worker reads the last such line
//   from `docker logs` when the run ends (src/sandbox.ts) and stores it on the run.
// - It enforces a HARD COST CAP per run (ITERA_RUN_MAX_COST_USD, default 0.50): once the run has
//   spent the cap, every further model call gets `402` and the run ends with `cap_reached`.
//   One call that is already in flight can still finish, so the real total can pass the cap by the
//   cost of that last call.
//
// - ROUTES (K10): the worker starts it either for OpenRouter (upstream https://openrouter.ai, prefix
//   /api/v1/) or for opencode go (upstream https://opencode.ai, prefix /zen/go/v1/). opencode go
//   answers no USD cost: the worker passes the model's price (ITERA_PRICE_JSON) and the meter derives
//   the cost from the tokens. opencode go also refuses a request without `x-opencode-session`:
//   with ITERA_GATEWAY_SESSION set, the gateway adds that header when the client did not send one.
//
// - RATE LIMITS (K11): an upstream 429 is retried here, with backoff (Retry-After, else 2 s, 4 s,
//   8 s, 16 s; ITERA_GATEWAY_429_RETRIES, default 4). The request body is buffered for the replay.
//   A 429 that survives the retries goes back to the agent and is counted as `rate_limited_final`:
//   the worker then ends the run `infra_error`, never a model `fail`.
// - PROVENANCE (K11): the meter records the model and provider that ANSWERED (response `model`,
//   OpenRouter `provider`, opencode go `x-opencode-upstream-model-id` / `x-opencode-endpoint-id`),
//   the requested models, and the sampling params of the first model call.
//
// Env: ITERA_UPSTREAM_KEY (required), ITERA_UPSTREAM, ITERA_GATEWAY_PATH_PREFIX, ITERA_GATEWAY_PORT,
//      ITERA_RUN_MAX_COST_USD, ITERA_PRICE_JSON, ITERA_GATEWAY_SESSION, ITERA_ROUTE (logged only).
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { backoffMs, parsePrice, requestParams, ResponseUsage, RunMeter } from './gateway-meter.mjs';

const upstream = new URL(process.env.ITERA_UPSTREAM ?? 'https://openrouter.ai');
// Plain http only for a local test upstream (src/gateway.integration.test.mjs); the worker always passes https.
const request = upstream.protocol === 'http:' ? httpRequest : httpsRequest;
const key = process.env.ITERA_UPSTREAM_KEY ?? '';
const prefix = process.env.ITERA_GATEWAY_PATH_PREFIX ?? '/api/v1/';
const port = Number(process.env.ITERA_GATEWAY_PORT ?? 3128);
const price = parsePrice(process.env.ITERA_PRICE_JSON ?? '');
const session = (process.env.ITERA_GATEWAY_SESSION ?? '').slice(0, 120);
const route = process.env.ITERA_ROUTE ?? 'openrouter';
const meter = new RunMeter(Number(process.env.ITERA_RUN_MAX_COST_USD ?? 0.5), price);
const maxRetries = Math.max(0, Math.min(8, Number(process.env.ITERA_GATEWAY_429_RETRIES ?? 4)));
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const log = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

if (!key) {
  log({ fatal: 'ITERA_UPSTREAM_KEY is not set' });
  process.exit(1);
}

// Only these request headers go upstream. Anything that the agent sets for auth is dropped.
// accept-encoding is dropped too: the meter must read the upstream body uncompressed.
const FORWARD_HEADERS = ['content-type', 'accept', 'user-agent', 'http-referer', 'x-title'];
// opencode's own routing headers (x-opencode-session, x-opencode-request, ...) carry no secret.
const FORWARD_PREFIX = 'x-opencode-';

const server = createServer((req, res) => {
  const path = req.url ?? '/';
  if (!path.startsWith(prefix) || path.includes('..')) {
    log({ verdict: 'deny', method: req.method, path: path.slice(0, 120) });
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('denied: the sandbox may only call the model API\n');
    return;
  }
  if (req.method !== 'GET' && meter.exhausted()) {
    meter.refused += 1;
    log({ verdict: 'cap_reached', method: req.method, path: path.split('?')[0], ...meter.snapshot() });
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        code: 402,
        message: `ITERA run cost cap reached: US$${meter.snapshot().cost_usd} of US$${meter.maxCostUsd} (ITERA_RUN_MAX_COST_USD). No more model calls in this run.`,
      },
    }));
    return;
  }
  const headers = { host: upstream.host, authorization: `Bearer ${key}`, 'accept-encoding': 'identity' };
  for (const name of FORWARD_HEADERS) if (req.headers[name]) headers[name] = req.headers[name];
  for (const [name, value] of Object.entries(req.headers)) if (name.startsWith(FORWARD_PREFIX) && typeof value === 'string') headers[name] = value.slice(0, 200);
  if (session && !headers['x-opencode-session']) headers['x-opencode-session'] = session;

  // Buffer the request body: a 429 retry must replay it.
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) tooLarge = true;
    else chunks.push(c);
  });
  req.on('error', () => res.destroy());
  req.on('end', () => {
    if (tooLarge) {
      res.writeHead(413, { 'content-type': 'text/plain' });
      res.end('request body too large\n');
      return;
    }
    const bodyBuf = Buffer.concat(chunks);
    if (req.method !== 'GET' && bodyBuf.length > 0) meter.request(requestParams(bodyBuf.toString('utf-8')));
    headers['content-length'] = String(bodyBuf.length);
    delete headers['transfer-encoding'];
    attempt(0);

    function attempt(n) {
      const started = Date.now();
      const out = request(
        { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || (upstream.protocol === 'http:' ? 80 : 443), method: req.method, path, headers },
        (up) => {
          const status = up.statusCode ?? 502;
          log({ verdict: 'allow', method: req.method, path: path.split('?')[0], status, ms: Date.now() - started, attempt: n });
          if (status === 429) {
            meter.rateLimited += 1;
            if (n < maxRetries && !res.destroyed) {
              const wait = backoffMs(n, up.headers['retry-after']);
              log({ verdict: 'retry_429', attempt: n + 1, wait_ms: wait });
              up.resume();
              setTimeout(() => attempt(n + 1), wait);
              return;
            }
            meter.rateLimitedFinal += 1;
            log({ verdict: 'rate_limited_final', attempts: n + 1, ...meter.snapshot() });
          }
          res.writeHead(status, up.headers);
          const usage = new ResponseUsage(String(up.headers['content-type'] ?? ''), undefined, up.headers);
          up.on('data', (chunk) => usage.push(chunk));
          up.on('end', () => {
            if (req.method === 'GET') return;
            meter.add(usage.end(), usage.answer());
            log(meter.snapshot());
          });
          up.pipe(res);
        },
      );
      out.on('error', (err) => {
        log({ verdict: 'upstream_error', path: path.split('?')[0], error: err.code ?? err.message });
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('upstream error\n');
      });
      res.on('close', () => out.destroy());
      out.end(bodyBuf);
    }
  });
});

// No tunnels: an agent cannot reach any other host through this gateway.
server.on('connect', (req, socket) => {
  log({ verdict: 'deny', method: 'CONNECT', target: String(req.url).slice(0, 120) });
  socket.on('error', () => socket.destroy());
  socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
});
server.on('clientError', (_err, socket) => socket.destroy());

server.listen(port, '0.0.0.0', () => {
  log({ listening: port, route, upstream: upstream.origin, prefix, maxCostUsd: meter.maxCostUsd, priced: Boolean(price) });
  log(meter.snapshot());
});

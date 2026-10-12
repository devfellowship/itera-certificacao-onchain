// Model gateway for the ITERA agent sandbox. It is the ONLY host that a sandbox can reach:
// the sandbox network is `internal` (no route out), and this container sits on it.
//
// - It forwards plain-HTTP requests under ITERA_GATEWAY_PATH_PREFIX (default /api/v1/) to
//   ITERA_UPSTREAM (default https://openrouter.ai) and ADDS the Authorization header itself.
//   The sandbox holds no model key, so an agent cannot read, print or exfiltrate it.
// - It refuses everything else: other paths (403), HTTP CONNECT tunnels (403), any other host.
//
// Env: ITERA_UPSTREAM_KEY (required), ITERA_UPSTREAM, ITERA_GATEWAY_PATH_PREFIX, ITERA_GATEWAY_PORT.
import { createServer } from 'node:http';
import { request } from 'node:https';

const upstream = new URL(process.env.ITERA_UPSTREAM ?? 'https://openrouter.ai');
const key = process.env.ITERA_UPSTREAM_KEY ?? '';
const prefix = process.env.ITERA_GATEWAY_PATH_PREFIX ?? '/api/v1/';
const port = Number(process.env.ITERA_GATEWAY_PORT ?? 3128);
const log = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

if (!key) {
  log({ fatal: 'ITERA_UPSTREAM_KEY is not set' });
  process.exit(1);
}

// Only these request headers go upstream. Anything that the agent sets for auth is dropped.
const FORWARD_HEADERS = ['content-type', 'accept', 'accept-encoding', 'user-agent', 'http-referer', 'x-title'];

const server = createServer((req, res) => {
  const path = req.url ?? '/';
  if (!path.startsWith(prefix) || path.includes('..')) {
    log({ verdict: 'deny', method: req.method, path: path.slice(0, 120) });
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('denied: the sandbox may only call the model API\n');
    return;
  }
  const headers = { host: upstream.host, authorization: `Bearer ${key}` };
  for (const name of FORWARD_HEADERS) if (req.headers[name]) headers[name] = req.headers[name];
  if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
  if (req.headers['transfer-encoding']) headers['transfer-encoding'] = req.headers['transfer-encoding'];

  const started = Date.now();
  const out = request(
    { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || 443, method: req.method, path, headers },
    (up) => {
      log({ verdict: 'allow', method: req.method, path: path.split('?')[0], status: up.statusCode, ms: Date.now() - started });
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  out.on('error', (err) => {
    log({ verdict: 'upstream_error', path: path.split('?')[0], error: err.code ?? err.message });
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('upstream error\n');
  });
  req.pipe(out);
  req.on('error', () => out.destroy());
  res.on('close', () => out.destroy());
});

// No tunnels: an agent cannot reach any other host through this gateway.
server.on('connect', (req, socket) => {
  log({ verdict: 'deny', method: 'CONNECT', target: String(req.url).slice(0, 120) });
  socket.on('error', () => socket.destroy());
  socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
});
server.on('clientError', (_err, socket) => socket.destroy());

server.listen(port, '0.0.0.0', () => log({ listening: port, upstream: upstream.origin, prefix }));

// browser@1 — the official Playwright MCP (@playwright/mcp, Microsoft, Apache-2.0, see manifest.json
// `upstream`) driving a headless Chromium, wrapped as an Itera fixture. Everything runs INSIDE the
// sidecar:
//
//   - a static site from the seed, served by a small in-process HTTP server on 127.0.0.1:8081.
//     The server is ALSO Chromium's forward proxy (every request goes to it, loopback included), and
//     it answers only the seeded hosts (`app.local`, `design.local`, ...). Any other host gets 403
//     and is counted in the export. CONNECT (https) is refused. So the site answers as http://app.local
//     with no DNS and no port 80, and the browser cannot reach anything else even before the
//     --internal Docker network stops it.
//   - the upstream Playwright MCP, a stdio child process. The base fixture bridges it to streamable
//     HTTP with the token, the allow-list and the call log (same pattern as memory@1 and repos@1).
//
// The state this fixture adds is a VISIT LOG (/state/browser.json): which URL was open at which
// viewport, for which tool, and the sha256 of every screenshot image the agent received. The export
// gives it to the mcp_state scorer, so a task can assert "every screen was seen at both sizes".
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { canonicalJson, EXIT, serve, STATE_DIR } from '/itera/fixture.mjs';

export const STATE_FILE = 'browser.json';
export const SITE_PORT = 8081;
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const CHROMIUM = process.env.ITERA_CHROMIUM ?? '/itera/chromium';
// The package `exports` map does not expose cli.js (require.resolve refuses it): use the file path.
const UPSTREAM_ENTRY = () => process.env.ITERA_PLAYWRIGHT_MCP ?? '/itera/upstream/node_modules/@playwright/mcp/cli.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8',
};

/** Write the seeded sites: /state/sites/<host>/<path>. A file is a UTF-8 string or { base64 }. */
export function writeSites(seed, stateDir) {
  for (const [host, site] of Object.entries(seed.hosts)) {
    for (const [path, body] of Object.entries(site.files)) {
      const full = join(stateDir, 'sites', host, normalize(path));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, typeof body === 'string' ? body : Buffer.from(body.base64, 'base64'));
    }
  }
}

/** The file for a request path: `/` and `/x/` → index.html; `/x` → x, x.html or x/index.html. */
export function resolveFile(root, pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const rel = normalize(p).replace(/^\/+/, '');
  if (rel.startsWith('..')) return null;
  const candidates = rel === '' || rel.endsWith('/') ? [`${rel}index.html`] : [rel, `${rel}.html`, `${rel}/index.html`];
  for (const c of candidates) {
    const full = join(root, c);
    if (!full.startsWith(`${root}/`)) continue;
    try {
      if (statSync(full).isFile()) return full;
    } catch {
      // next candidate
    }
  }
  return null;
}

/** Normalize a page URL for the visit log: origin + path + query, no fragment. */
export function pageKey(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

export function emptyState(viewport = DEFAULT_VIEWPORT) {
  return { url: null, viewport: { ...viewport }, visits: {}, screenshots: [], navigations: [], requests: {}, blocked: {}, calls: 0, calls_outside: 0 };
}

const pageUrlOf = (content) => {
  for (const c of content ?? []) {
    if (c?.type !== 'text') continue;
    const m = /(?:^|\n)-?\s*Page URL:\s*(\S+)/.exec(c.text ?? '');
    if (m) return m[1];
  }
  return null;
};

/** Add one successful call to the visit log. Pure apart from the hash: (state, call) → state. */
export function recordCall(state, hosts, name, args, content, step) {
  state.calls += 1;
  if (name === 'browser_resize') state.viewport = { width: Number(args.width), height: Number(args.height) };
  const reported = pageUrlOf(content);
  if (reported) state.url = pageKey(reported);
  else if (name === 'browser_navigate') state.url = pageKey(args.url);
  if (name === 'browser_navigate' && state.url) state.navigations.push({ seq: step, url: state.url });
  let host = null;
  try {
    host = state.url ? new URL(state.url).hostname : null;
  } catch {
    host = null;
  }
  if (!host || !hosts.has(host)) {
    state.calls_outside += 1;
    return state;
  }
  const { width, height } = state.viewport;
  const id = `${state.url}@${width}x${height}`;
  // `view` = URL @ width only: the mcp_state filter takes one key, and a task asks for a width
  // ("the 390 px layout"), not for the exact window height the agent chose.
  const v = state.visits[id] ?? { id, view: `${state.url}@${width}`, url: state.url, host, path: new URL(state.url).pathname, width, height, first_seq: step, calls: 0, screenshots: 0, snapshots: 0 };
  v.calls += 1;
  if (name === 'browser_snapshot') v.snapshots += 1;
  if (name === 'browser_take_screenshot') {
    for (const c of content ?? []) {
      if (c?.type !== 'image' || typeof c.data !== 'string') continue;
      const bytes = Buffer.from(c.data, 'base64');
      v.screenshots += 1;
      state.screenshots.push({ seq: step, url: state.url, width, height, mime: c.mimeType ?? null, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  state.visits[id] = v;
  return state;
}

/** The seeded site server, also Chromium's only proxy. Records every request by host and path. */
function startSiteServer(seed, stateDir, onRequest) {
  const hosts = new Set(Object.keys(seed.hosts));
  const server = createServer((req, res) => {
    let url;
    try {
      // A proxy request carries the absolute URL; a direct one only the path (then use Host).
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'invalid.invalid'}`);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const host = url.hostname;
    if (url.protocol !== 'http:' || !hosts.has(host) || (url.port !== '' && url.port !== '80')) {
      onRequest({ blocked: true, host: `${url.protocol}//${url.host}` });
      res.writeHead(403, { 'content-type': 'text/plain' }).end('blocked: this sandbox serves only the seeded hosts');
      return;
    }
    const file = resolveFile(join(stateDir, 'sites', host), url.pathname);
    const status = file ? 200 : 404;
    if (url.pathname !== '/favicon.ico') onRequest({ blocked: false, host, path: url.pathname, status });
    if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(file ? 405 : 404, { 'content-type': 'text/plain' }).end(file ? 'method not allowed' : 'not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
  });
  // https (and anything else tunnelled): refused.
  server.on('connect', (req, socket) => {
    onRequest({ blocked: true, host: `connect://${String(req.url ?? '').slice(0, 100)}` });
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(SITE_PORT, '127.0.0.1', () => resolve(server));
  });
}

/** The upstream configuration: Chromium headless shell, every request through the site server. */
export function upstreamConfig(seed, stateDir) {
  const viewport = seed.viewport ?? DEFAULT_VIEWPORT;
  return {
    browser: {
      browserName: 'chromium',
      isolated: true,
      launchOptions: {
        headless: true,
        executablePath: CHROMIUM,
        // The sidecar drops every capability and sets no-new-privileges: the Chromium sandbox
        // cannot start. The container is the sandbox.
        chromiumSandbox: false,
        proxy: { server: `http://127.0.0.1:${SITE_PORT}`, bypass: '' },
        // <-loopback> removes Chromium's implicit proxy bypass for localhost, so 127.0.0.1:8080
        // (this MCP endpoint) also goes to the site server, which refuses it.
        args: ['--proxy-bypass-list=<-loopback>', '--disable-dev-shm-usage', '--no-first-run', '--disable-background-networking', '--disable-component-update'],
      },
      contextOptions: { viewport, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' },
    },
    network: { allowedOrigins: Object.keys(seed.hosts).map((h) => `http://${h}`) },
    outputDir: join(stateDir, 'out'),
    outputMaxSize: 8 * 1024 * 1024,
    imageResponses: 'allow',
    webmcp: false,
    codegen: 'none',
    snapshot: { boxes: seed.snapshot_boxes === true },
    timeouts: { action: 5000, navigation: 15000, settle: 300 },
  };
}

function upstreamAdapter() {
  let client;
  let expected = [];
  let state = emptyState();
  let hosts = new Set();
  const statePath = join(STATE_DIR, STATE_FILE);
  const save = () => writeFileSync(statePath, JSON.stringify(state));
  return {
    async verifyTools(tools) {
      // The base runs this BEFORE init; the upstream needs the config that init writes.
      expected = tools;
    },
    async init({ seed, stateDir }) {
      for (const d of ['home', 'tmp', 'out', 'sites']) mkdirSync(join(stateDir, d), { recursive: true });
      writeSites(seed, stateDir);
      hosts = new Set(Object.keys(seed.hosts));
      state = emptyState(seed.viewport ?? DEFAULT_VIEWPORT);
      save();
      await startSiteServer(seed, stateDir, (r) => {
        if (r.blocked) state.blocked[r.host] = (state.blocked[r.host] ?? 0) + 1;
        else {
          const id = `${r.host}${r.path}`;
          const e = state.requests[id] ?? { id, host: r.host, path: r.path, status: r.status, count: 0 };
          e.count += 1;
          e.status = r.status;
          state.requests[id] = e;
        }
        save();
      });
      const configPath = join(stateDir, 'playwright-mcp.json');
      writeFileSync(configPath, JSON.stringify(upstreamConfig(seed, stateDir), null, 2));
      const c = new Client({ name: 'itera-browser-bridge', version: '1.0.0' });
      // Only these variables reach the upstream process: no token, no allow-list.
      const env = {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: join(stateDir, 'home'),
        TMPDIR: join(stateDir, 'tmp'),
        XDG_CONFIG_HOME: join(stateDir, 'home', '.config'),
        XDG_CACHE_HOME: join(stateDir, 'home', '.cache'),
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/ms-playwright',
      };
      await c.connect(new StdioClientTransport({ command: process.execPath, args: [UPSTREAM_ENTRY(), '--config', configPath], env, cwd: join(stateDir, 'out'), stderr: 'ignore' }));
      client = c;
      // A drifted upstream (a renamed tool, a changed schema) stops the boot with exit 4.
      // tools.json drops the upstream `$schema` (draft 2020-12): the base validates arguments with
      // Ajv draft-07, which refuses to compile a schema that names 2020-12. Nothing else differs.
      const pick = (t) => {
        const { $schema, ...inputSchema } = t.inputSchema ?? {};
        return canonicalJson({ name: t.name, description: t.description, inputSchema });
      };
      const up = (await client.listTools()).tools;
      for (const t of expected) {
        const u = up.find((x) => x.name === t.name);
        if (!u || pick(u) !== pick(t)) {
          process.stdout.write(`${JSON.stringify({ event: 'fatal', code: EXIT.tools, error: `upstream tool ${t.name} differs from tools.json` })}\n`);
          process.exit(EXIT.tools);
        }
      }
      // Launch Chromium now, so `ready` means the browser works and the first agent call is fast.
      const warm = await client.callTool({ name: 'browser_navigate', arguments: { url: 'about:blank' } });
      if (warm.isError) throw new Error(`Chromium did not start: ${JSON.stringify(warm.content ?? []).slice(0, 300)}`);
    },
    async call(name, args, ctx) {
      const out = await client.callTool({ name, arguments: args });
      if (!out.isError) {
        state = recordCall(state, hosts, name, args, out.content, ctx.step);
        save();
      }
      return { content: out.content ?? [], ...(out.isError ? { isError: true } : {}) };
    },
  };
}

if (process.argv[1] === import.meta.filename) {
  await serve(upstreamAdapter());
}

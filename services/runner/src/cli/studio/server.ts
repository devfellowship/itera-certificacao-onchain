// The HTTP surface of `tma studio serve` (plan 20261112-tma-c5-studio-area-web2, ADR-4, task C5-T11).
//
// Read-only by construction: GET only (OPTIONS answers a CORS preflight), every other method is 405
// before any other check. The one exception is `POST /grade/dry-run` (task C5-T10, Q-C5-2b = A): a no-store
// dry-run grading (dry-run.ts); it writes nothing outside a temp dir that it removes. Every content route checks the login on every call (auth.ts). The service
// binds 127.0.0.1 only; how a browser reaches it is a separate decision (Q-C5-2). It handles one request
// at a time: a request waits for the one before it.
//
// Routes:
//   GET /v1/health                      no login; `{ok: true}` and nothing else
//   GET /v1/traces?limit&offset&l2_class&why&mode     S2: candidate traces with pin status and task summary
//   GET /v1/traces/:session_id[?agent_id=...]          S3: session summary, runs with steps, first failure
//   POST /grade/dry-run                                S10a/S11a: one grader grades one output; nothing stored.
//        Same login as the GET routes; JSON body <= 256 KB (413); one dry run at a time (429); 504 after the timeout;
//        a code grader runs in a network namespace (unshare -rn), 503 network_sandbox_unavailable when there is none.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { checkLogin, type AuthDeps } from './auth.js';
import { getTrace, listTraces, NotFound, type StudioSources } from './content.js';
import { DRY_RUN_MAX_BODY, DRY_RUN_PATH, DRY_RUN_TIMEOUT_MS, DryRunRefused, parseDryRunBody, probeNetworkSandbox, runDryRun, type DryRunOptions } from './dry-run.js';

/** The only address the service binds. A wider bind needs a code change and a review, not a flag. */
export const BIND_HOST = '127.0.0.1';

export interface StudioServerOptions {
  sources: StudioSources;
  auth: AuthDeps;
  /** Browser origins that may call the service (CORS), e.g. https://testmyagent.com. */
  allowOrigins: ReadonlySet<string>;
  /** One line per request: method, path, status, ms. Never a header, a token or a body. */
  log?: (line: string) => void;
  /** POST /grade/dry-run (C5-T10): the grader library root, the judge path, the timeout. */
  dryRun?: DryRunOptions;
}

export interface Answer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): Answer => ({ status, body, ...(headers ? { headers } : {}) });

function intParam(raw: string | null, dflt: number, min: number, max: number): number | null {
  if (raw === null) return dflt;
  if (!/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n < min || n > max ? null : n;
}

function textParam(raw: string | null): string | undefined | null {
  if (raw === null) return undefined;
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(raw) ? raw : null;
}

/** The answer to one request. `authorization` is the raw header. Pure apart from the reads. */
export async function route(method: string, rawUrl: string, authorization: string | string[] | undefined, opts: StudioServerOptions): Promise<Answer> {
  const url = new URL(rawUrl, 'http://studio.invalid');
  // POST /grade/dry-run is served by dryRunRoute (the handler sends it there); any other method on it is 405.
  if (url.pathname === DRY_RUN_PATH) return json(405, { error: 'method_not_allowed', message: 'this path answers POST only' }, { allow: 'POST, OPTIONS' });
  if (method !== 'GET') return json(405, { error: 'method_not_allowed', message: 'this service is read-only' }, { allow: 'GET, OPTIONS' });
  if (url.pathname === '/v1/health') return json(200, { ok: true });

  const traceMatch = /^\/v1\/traces(?:\/([^/]+))?\/?$/.exec(url.pathname);
  if (!traceMatch) return json(404, { error: 'not_found' });

  const login = await checkLogin(authorization, opts.auth);
  if (!login.ok) return json(login.status, { error: login.reason });

  try {
    if (traceMatch[1] === undefined) {
      const limit = intParam(url.searchParams.get('limit'), 50, 1, 200);
      const offset = intParam(url.searchParams.get('offset'), 0, 0, 1_000_000);
      const l2_class = textParam(url.searchParams.get('l2_class'));
      const why = textParam(url.searchParams.get('why'));
      const mode = textParam(url.searchParams.get('mode'));
      if (limit === null || offset === null || l2_class === null || why === null || mode === null) return json(400, { error: 'bad_query' });
      return json(200, listTraces(opts.sources, { limit, offset, ...(l2_class ? { l2_class } : {}), ...(why ? { why } : {}), ...(mode ? { mode } : {}) }));
    }
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(traceMatch[1]);
    } catch {
      return json(400, { error: 'bad_session_id' });
    }
    const agentId = url.searchParams.get('agent_id') ?? undefined;
    return json(200, getTrace(opts.sources, sessionId, agentId));
  } catch (e) {
    if (e instanceof NotFound) return json(e.code.startsWith('bad_') ? 400 : 404, { error: e.code });
    return json(500, { error: 'read_failed' });
  }
}

/** Read the body up to `max` bytes. Above it: drain the rest (up to 16x) and answer `too_large`. */
function readBody(req: IncomingMessage, max: number): Promise<{ ok: true; text: string } | { ok: false }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        if (size > max * 16) req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(over ? { ok: false } : { ok: true, text: Buffer.concat(chunks).toString('utf-8') }));
    req.on('error', () => resolve({ ok: false }));
    req.on('close', () => resolve(over ? { ok: false } : { ok: true, text: Buffer.concat(chunks).toString('utf-8') }));
  });
}

/** State of the dry-run route: at most one dry run at a time. */
export interface DryRunGate {
  busy: boolean;
}

/**
 * POST /grade/dry-run: login (401/403), size (413), content type (415), busy (429), body (400), then the dry
 * run with a timeout (504). A refused judge model is 422 before any execution. The busy flag stays set until
 * the grading really ends, also after a 504, so a second dry run never runs beside a late one.
 */
export async function dryRunRoute(req: IncomingMessage, opts: StudioServerOptions, gate: DryRunGate): Promise<Answer> {
  const login = await checkLogin(req.headers.authorization, opts.auth);
  if (!login.ok) {
    req.resume();
    return json(login.status, { error: login.reason });
  }
  const declared = Number(req.headers['content-length'] ?? '0');
  const body = Number.isFinite(declared) && declared > DRY_RUN_MAX_BODY ? ({ ok: false } as const) : await readBody(req, DRY_RUN_MAX_BODY);
  if (!body.ok) {
    req.resume();
    return json(413, { error: 'body_too_large', max_bytes: DRY_RUN_MAX_BODY });
  }
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return json(415, { error: 'unsupported_media_type', message: 'send application/json' });
  if (gate.busy) return json(429, { error: 'busy', message: 'one dry run at a time: try again when it ends' }, { 'retry-after': '5' });
  gate.busy = true;
  let release = true;
  try {
    const parsed = parseDryRunBody(body.text);
    const timeoutMs = opts.dryRun?.timeoutMs ?? DRY_RUN_TIMEOUT_MS;
    const work = runDryRun(parsed, { ...(opts.dryRun ?? {}), timeoutMs });
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), timeoutMs + 1_000);
    });
    const first = await Promise.race([work, timedOut]).finally(() => clearTimeout(timer));
    if (first === 'timeout') {
      // Keep the gate closed until the late dry run ends (its own temp dir is removed in its finally).
      release = false;
      work.catch(() => undefined).finally(() => (gate.busy = false));
      return json(504, { error: 'dry_run_timeout', stored: false });
    }
    return json(200, first);
  } catch (e) {
    if (e instanceof DryRunRefused) return json(e.status, { error: e.code, message: e.message, stored: false });
    return json(500, { error: 'dry_run_failed', stored: false });
  } finally {
    if (release) gate.busy = false;
  }
}

function corsHeaders(origin: string | undefined, opts: StudioServerOptions): Record<string, string> {
  if (!origin || !opts.allowOrigins.has(origin)) return {};
  return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

function send(res: ServerResponse, a: Answer, extra: Record<string, string>): void {
  const body = JSON.stringify(a.body);
  res.writeHead(a.status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extra,
    ...(a.headers ?? {}),
  });
  res.end(body);
}

/** The request handler, with the one-at-a-time queue. */
export function handler(opts: StudioServerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  let queue: Promise<void> = Promise.resolve();
  const gate: DryRunGate = { busy: false };
  const log = opts.log ?? (() => undefined);
  return (req, res) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const cors = corsHeaders(origin, opts);
    const started = Date.now();
    const path = (req.url ?? '/').split('?')[0]!.slice(0, 200);
    if (req.method === 'OPTIONS') {
      // A CORS preflight. Only an allowed origin gets the allow headers.
      if (!cors['access-control-allow-origin']) {
        send(res, json(403, { error: 'origin_not_allowed' }), {});
      } else {
        const dry = path === DRY_RUN_PATH;
        res.writeHead(204, {
          ...cors,
          'access-control-allow-methods': dry ? 'POST' : 'GET',
          'access-control-allow-headers': dry ? 'authorization, content-type' : 'authorization',
          'access-control-max-age': '600',
        });
        res.end();
      }
      log(`OPTIONS ${path} ${res.statusCode} ${Date.now() - started}ms`);
      return;
    }
    if (req.method === 'POST' && path === DRY_RUN_PATH) {
      // Not in the GET queue: a dry run may take up to the timeout; its own gate answers 429 when busy.
      void dryRunRoute(req, opts, gate)
        .catch(() => json(500, { error: 'internal' }))
        .then((a) => {
          send(res, a, cors);
          log(`POST ${path} ${a.status} ${Date.now() - started}ms`);
        });
      return;
    }
    queue = queue.then(async () => {
      const a = await route(req.method ?? 'GET', req.url ?? '/', req.headers.authorization, opts).catch(() => json(500, { error: 'internal' }));
      send(res, a, cors);
      log(`${req.method} ${path} ${a.status} ${Date.now() - started}ms`);
    });
  };
}

/** Start the service on 127.0.0.1:<port>. Resolves when it listens. Port 0 picks a free port (tests). */
export function startStudioServer(port: number, opts: StudioServerOptions): Promise<Server> {
  // Probe the network namespace of POST /grade/dry-run at start (cached); a dry run reads the cached answer.
  if (opts.dryRun?.graderRoot && !opts.dryRun.networkSandbox?.probe) void probeNetworkSandbox();
  const server = createServer(handler(opts));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND_HOST, () => resolve(server));
  });
}

// `tma studio serve`: a read-only content API for the studio screens S2 and S3 (plan
// 20261112-tma-c5-studio-area-web2, ADR-4, task C5-T11). It is a workaround with an end: task C5-T12
// removes it when the final content path (C10) ships. Code: ../studio/.
import { flag, flagList, numberFlag, parseArgs } from '../args.js';
import type { Command } from '../command.js';
import { apiUrl, CliError } from '../env.js';
import { apiIntrospect } from '../studio/auth.js';
import { BIND_HOST, startStudioServer } from '../studio/server.js';

export const STUDIO_DEFAULTS = {
  port: 8787,
  index: '/mnt/HC_Volume_105256938/trace-index/trace-index.sqlite',
  selectDir: '/mnt/HC_Volume_105256938/tma-private-tasks/trace-select',
  trajectoryRoot: '/mnt/HC_Volume_105256938/session-trajectories',
} as const;

const USAGE = `usage: tma studio serve --allow-principal <id> [--allow-principal <id> ...] [--allow-origin <url> ...]
                        [--port ${STUDIO_DEFAULTS.port}] [--index <file>] [--select-dir <dir>] [--trajectory-root <dir>]
  A read-only HTTP service for the studio trace screens (S2 picker, S3 trace view). It binds ${BIND_HOST} only.
  It reads the trace-select output, the trace index (SQLite, opened read-only) and the layer-1 trajectory
  files. It never writes. GET only; any other method answers 405.
  Every content request needs a TMA web login (Authorization: Bearer <token>). The TMA API checks the token
  (GET /auth/me at TMA_API_URL); the service never holds the session signing key. Only the principal ids of
  --allow-principal (for example dfl:<uuid>) may read. A CLI session (tma login) is refused.
  --allow-origin    a browser origin that may call it (CORS), for example https://testmyagent.com
  --index           default ${STUDIO_DEFAULTS.index}
  --select-dir      default ${STUDIO_DEFAULTS.selectDir}
  --trajectory-root default ${STUDIO_DEFAULTS.trajectoryRoot}
  Routes: GET /v1/health, GET /v1/traces, GET /v1/traces/<session_id>[?agent_id=<id>]`;

export const studioCommand: Command = {
  name: 'studio',
  summary: 'studio serve: the read-only trace content API of the studio (127.0.0.1 only)',
  usage: USAGE,
  async main(argv, io) {
    const [sub, ...rest] = argv;
    if (sub !== 'serve') throw new CliError(`unknown subcommand: ${sub ?? '(none)'}\n${USAGE}`);
    const a = parseArgs(rest, {
      port: {},
      index: {},
      'select-dir': {},
      'trajectory-root': {},
      'allow-principal': { repeat: true },
      'allow-origin': { repeat: true },
    });
    if (a.positionals.length > 0) throw new CliError(`unexpected argument: ${a.positionals[0]}\n${USAGE}`);
    const principals = flagList(a, 'allow-principal').map((p) => p.trim()).filter(Boolean);
    if (principals.length === 0) throw new CliError(`--allow-principal is required: name who may read (for example dfl:<uuid>)\n${USAGE}`);
    for (const p of principals) if (!/^[A-Za-z0-9:_-]{3,100}$/.test(p)) throw new CliError(`--allow-principal: not a principal id: ${p.slice(0, 40)}`);
    const origins = flagList(a, 'allow-origin').map((o) => o.trim());
    for (const o of origins) {
      let u: URL;
      try {
        u = new URL(o);
      } catch {
        throw new CliError(`--allow-origin: not a URL: ${o.slice(0, 80)}`);
      }
      if (u.origin !== o) throw new CliError(`--allow-origin must be an origin (scheme://host[:port], no path): ${o.slice(0, 80)}`);
    }
    const port = numberFlag(a, 'port', { min: 1, max: 65535, integer: true }) ?? STUDIO_DEFAULTS.port;
    const api = apiUrl();
    const server = await startStudioServer(port, {
      sources: {
        indexPath: flag(a, 'index') ?? STUDIO_DEFAULTS.index,
        selectDir: flag(a, 'select-dir') ?? STUDIO_DEFAULTS.selectDir,
        trajectoryRoot: flag(a, 'trajectory-root') ?? STUDIO_DEFAULTS.trajectoryRoot,
      },
      auth: { introspect: apiIntrospect(api), allowPrincipals: new Set(principals) },
      allowOrigins: new Set(origins),
      log: (line) => io.err(`[studio] ${new Date().toISOString()} ${line}`),
    });
    const addr = server.address();
    const shown = addr && typeof addr === 'object' ? `${addr.address}:${addr.port}` : `${BIND_HOST}:${port}`;
    io.out(`tma studio serve: listening on http://${shown} (read-only; login checked at ${api}/auth/me; ${principals.length} principal(s), ${origins.length} origin(s))`);
    // Serve until a signal: the CLI's signal handler ends the process.
    await new Promise<void>((resolve) => server.once('close', () => resolve()));
    return 0;
  },
};

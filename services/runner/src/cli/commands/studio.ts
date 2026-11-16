// `tma studio serve`: a read-only content API for the studio screens S2 and S3 (plan
// 20261112-tma-c5-studio-area-web2, ADR-4, task C5-T11). It is a workaround with an end: task C5-T12
// removes it when the final content path (C10) ships. Code: ../studio/.
import { flag, flagList, numberFlag, parseArgs } from '../args.js';
import type { Command } from '../command.js';
import { apiUrl, CliError } from '../env.js';
import { apiIntrospect } from '../studio/auth.js';
import type { StudioSources } from '../studio/content.js';
import { buildFixture, FIXTURE_VARIANT, fixtureSourcesAt } from '../studio/fixture.js';
import { BIND_HOST, startStudioServer } from '../studio/server.js';

export const STUDIO_DEFAULTS = {
  port: 8787,
  index: '/mnt/HC_Volume_105256938/trace-index/trace-index.sqlite',
  selectDir: '/mnt/HC_Volume_105256938/tma-private-tasks/trace-select',
  trajectoryRoot: '/mnt/HC_Volume_105256938/session-trajectories',
} as const;

const USAGE = `usage: tma studio serve --allow-principal <id> [--allow-principal <id> ...] [--allow-origin <url> ...]
                        [--port ${STUDIO_DEFAULTS.port}] [--index <file>] [--select-dir <dir>] [--trajectory-root <dir>]
                        [--grader-root <dir>] [--fixture-principal <id> ... --fixture-root <dir>]
       tma studio fixture --out <dir>
  A read-only HTTP service for the studio trace screens (S2 picker, S3 trace view). It binds ${BIND_HOST} only.
  It reads the trace-select output, the trace index (SQLite, opened read-only) and the layer-1 trajectory
  files. It never writes. GET only; any other method answers 405, except POST /grade/dry-run.
  Every content request needs a TMA web login (Authorization: Bearer <token>). The TMA API checks the token
  (GET /auth/me at TMA_API_URL); the service never holds the session signing key. Only the principal ids of
  --allow-principal (for example dfl:<uuid>) may read. A CLI session (tma login) is refused.
  --allow-origin    a browser origin that may call it (CORS), for example https://testmyagent.com
  --fixture-principal  a principal id that reads ONLY the synthetic fixture tree of --fixture-root, never a real
                    source (for example the smoke login of the prod checks). Repeatable. A principal on both
                    --allow-principal and --fixture-principal refuses the start. A fixture principal gets no dry run.
  --fixture-root    a tree written by \`tma studio fixture\`: it must hold the fixture marker, no symbolic link, and
                    must not overlap a real source, or the start is refused.
  --index           default ${STUDIO_DEFAULTS.index}
  --select-dir      default ${STUDIO_DEFAULTS.selectDir}
  --trajectory-root default ${STUDIO_DEFAULTS.trajectoryRoot}
  --grader-root     the grader library (<dir>/<graderId>/<semver>/grader.json) of POST /grade/dry-run. No default:
                    without it the dry run answers 503.
  POST /grade/dry-run {"grader":"<graderId>@<semver>","output":"<text>","expected"?:"<text>"} (JSON, max 256 KB):
    one grader grades one output with the code path of tma eval grade --dry-run and the answer comes back.
    Nothing is stored (a temp dir, removed after). One at a time (429), 60 s (504). A judge grader runs only
    with a model of A11 Q1 = B (fleet Claude, or a local ollama/ or local/ model); any other model is 422.
  Routes: GET /v1/health, GET /v1/traces, GET /v1/traces/<session_id>[?agent_id=<id>], POST /grade/dry-run
  tma studio fixture --out <dir>: write the synthetic fixture tree (no real text) into <dir>, which must not exist
    or be empty. Serve it with --fixture-root <dir>.`;

const PRINCIPAL_ID = /^[A-Za-z0-9:_-]{3,100}$/;

function principalList(values: string[], name: string): string[] {
  const out = values.map((p) => p.trim()).filter(Boolean);
  for (const p of out) if (!PRINCIPAL_ID.test(p)) throw new CliError(`--${name}: not a principal id: ${p.slice(0, 40)}`);
  return out;
}

export const studioCommand: Command = {
  name: 'studio',
  summary: 'studio serve: the read-only trace content API of the studio and a no-store grader dry run (127.0.0.1 only)',
  usage: USAGE,
  async main(argv, io) {
    const [sub, ...rest] = argv;
    if (sub === 'fixture') {
      const f = parseArgs(rest, { out: {} });
      if (f.positionals.length > 0) throw new CliError(`unexpected argument: ${f.positionals[0]}\n${USAGE}`);
      const out = flag(f, 'out');
      if (!out) throw new CliError(`--out is required\n${USAGE}`);
      let built: { root: string };
      try {
        built = buildFixture(out);
      } catch (e) {
        throw new CliError(`tma studio fixture: ${(e as Error).message}`);
      }
      io.out(`tma studio fixture: wrote the synthetic fixture tree to ${built.root} (sessions ${FIXTURE_VARIANT.sidA}, ${FIXTURE_VARIANT.sidB}; task ${FIXTURE_VARIANT.identifier})`);
      return 0;
    }
    if (sub !== 'serve') throw new CliError(`unknown subcommand: ${sub ?? '(none)'}\n${USAGE}`);
    const a = parseArgs(rest, {
      port: {},
      index: {},
      'select-dir': {},
      'trajectory-root': {},
      'grader-root': {},
      'allow-principal': { repeat: true },
      'allow-origin': { repeat: true },
      'fixture-principal': { repeat: true },
      'fixture-root': {},
    });
    if (a.positionals.length > 0) throw new CliError(`unexpected argument: ${a.positionals[0]}\n${USAGE}`);
    const principals = principalList(flagList(a, 'allow-principal'), 'allow-principal');
    if (principals.length === 0) throw new CliError(`--allow-principal is required: name who may read (for example dfl:<uuid>)\n${USAGE}`);
    const fixturePrincipals = principalList(flagList(a, 'fixture-principal'), 'fixture-principal');
    const both = fixturePrincipals.filter((p) => principals.includes(p));
    if (both.length > 0) throw new CliError(`a principal is on both --allow-principal and --fixture-principal: ${both[0]!.slice(0, 40)}`);
    const fixtureRoot = flag(a, 'fixture-root');
    if (fixturePrincipals.length > 0 && !fixtureRoot) throw new CliError(`--fixture-principal needs --fixture-root <dir> (build it with: tma studio fixture --out <dir>)\n${USAGE}`);
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
    const sources = {
      indexPath: flag(a, 'index') ?? STUDIO_DEFAULTS.index,
      selectDir: flag(a, 'select-dir') ?? STUDIO_DEFAULTS.selectDir,
      trajectoryRoot: flag(a, 'trajectory-root') ?? STUDIO_DEFAULTS.trajectoryRoot,
    };
    let fixtureSources: StudioSources | undefined;
    if (fixtureRoot) {
      try {
        fixtureSources = fixtureSourcesAt(fixtureRoot, sources);
      } catch (e) {
        throw new CliError(`--fixture-root: ${(e as Error).message}`);
      }
    }
    const server = await startStudioServer(port, {
      sources,
      ...(fixtureSources ? { fixtureSources } : {}),
      auth: { introspect: apiIntrospect(api), allowPrincipals: new Set(principals), fixturePrincipals: new Set(fixturePrincipals) },
      allowOrigins: new Set(origins),
      dryRun: { graderRoot: flag(a, 'grader-root') },
      log: (line) => io.err(`[studio] ${new Date().toISOString()} ${line}`),
    });
    const addr = server.address();
    const shown = addr && typeof addr === 'object' ? `${addr.address}:${addr.port}` : `${BIND_HOST}:${port}`;
    io.out(`tma studio serve: listening on http://${shown} (read-only; login checked at ${api}/auth/me; ${principals.length} principal(s), ${fixturePrincipals.length} fixture principal(s), ${origins.length} origin(s))`);
    // Serve until a signal: the CLI's signal handler ends the process.
    await new Promise<void>((resolve) => server.once('close', () => resolve()));
    return 0;
  },
};

import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import { BUILTIN_TOOLS } from '@itera/contracts';
import { bootSidecar, collectSidecar, opencodeRunConfig, sidecarName, tarFile, type CollectedSidecar, type McpSidecarPlan, type SidecarHandle } from './mcp-sidecar.js';
import { exec, pipe } from './exec.js';
import { parseGatewayUsage, type ModelUsage } from './model-usage.js';
import { routeOfModel, type ModelRoute, type RouteId } from './model-route.js';
import { loadRunProfile, renderRunCmd, type RunProfile } from './run-profile.js';
import { WORKSPACE_IN_SANDBOX } from './trace.js';

export const SANDBOX_UID = 10001;
export const DEFAULT_WALL_MS = 300_000;
/** Network alias of the model gateway; sandbox/opencode.json points the openrouter provider here. */
export const GATEWAY_ALIAS = 'itera-gateway';
export const GATEWAY_PORT = 3128;

export interface SandboxConfig {
  /** Image built from services/runner/sandbox/Dockerfile. */
  image: string;
  /** OpenRouter upstream of the gateway (route `openrouter`, ITERA_MODEL_UPSTREAM). */
  upstream: string;
  /** opencode go upstream of the gateway (route `opencode-go`, ITERA_OPENCODE_GO_UPSTREAM). */
  opencodeGoUpstream: string;
  wallMs: number;
  /** K11: the agent wall cap follows the task's agent.timeout_sec, up to this maximum (ITERA_RUN_MAX_WALL_MS). */
  maxWallMs: number;
  /** K11: upstream 429 retries in the run gateway (ITERA_GATEWAY_429_RETRIES, default 4). */
  rateLimitRetries: number;
  memory: string;
  cpus: string;
  pidsLimit: number;
  /** Hard model-cost cap of ONE run, in USD (ITERA_RUN_MAX_COST_USD). The gateway refuses calls above it. */
  maxCostUsd: number;
  /** How the agent is installed, run and collected (Valkyrie-shaped run profile, profiles/<name>.json). */
  profile: RunProfile;
}

export const DEFAULT_MAX_COST_USD = 0.5;

/** Limits come from the run profile (ITERA_RUN_PROFILE, default opencode); the ITERA_* env vars still override. */
export function defaultSandboxConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const profile = loadRunProfile(env.ITERA_RUN_PROFILE || undefined);
  const memMb = profile.resources.memory_mb;
  return {
    image: env.ITERA_SANDBOX_IMAGE ?? 'itera-runner-sandbox:latest',
    upstream: env.ITERA_MODEL_UPSTREAM ?? 'https://openrouter.ai',
    opencodeGoUpstream: env.ITERA_OPENCODE_GO_UPSTREAM ?? 'https://opencode.ai',
    wallMs: Number(env.ITERA_RUN_WALL_MS ?? profile.timeouts.run_sec * 1000),
    maxWallMs: positiveNumber(env.ITERA_RUN_MAX_WALL_MS, 900_000),
    rateLimitRetries: Math.min(8, Math.max(0, Math.round(Number(env.ITERA_GATEWAY_429_RETRIES ?? 4)) || 0)),
    memory: env.ITERA_SANDBOX_MEMORY ?? (memMb % 1024 === 0 ? `${memMb / 1024}g` : `${memMb}m`),
    cpus: env.ITERA_SANDBOX_CPUS ?? String(profile.resources.cpus),
    pidsLimit: Number(env.ITERA_SANDBOX_PIDS ?? profile.resources.pids),
    maxCostUsd: positiveNumber(env.ITERA_RUN_MAX_COST_USD, DEFAULT_MAX_COST_USD),
    profile,
  };
}

/** The sandbox image's ENTRYPOINT. A run_cmd that starts with another program gets --entrypoint. */
export const SANDBOX_ENTRYPOINT = 'opencode';

function positiveNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The run's model route (K10): `opencode-go/<model>` → opencode go, anything else → OpenRouter. */
export function modelRoute(model: string, config: Pick<SandboxConfig, 'upstream' | 'opencodeGoUpstream'>): ModelRoute {
  return routeOfModel(model, { openrouterUpstream: config.upstream, opencodeGoUpstream: config.opencodeGoUpstream });
}

/** The opencode `-m` argument: `openrouter/<model>`, or `opencode-go/<model>` unchanged. */
export function normalizeModel(model: string): string {
  return routeOfModel(model, { openrouterUpstream: '', opencodeGoUpstream: '' }).opencodeModel;
}

/**
 * `docker create` arguments for one agent run. The sandbox gets NO secret: the model key lives
 * only in the run's gateway container, which adds it to each upstream request.
 */
export function buildCreateArgs(opts: {
  name: string;
  network: string;
  model: string;
  prompt: string;
  config: SandboxConfig;
}): string[] {
  const argv = renderRunCmd(opts.config.profile, { workspace: WORKSPACE_IN_SANDBOX, model: normalizeModel(opts.model), instruction: opts.prompt });
  return [
    'create',
    '--name', opts.name,
    '--label', 'itera.role=agent-sandbox',
    '--network', opts.network,
    '--memory', opts.config.memory,
    '--memory-swap', opts.config.memory,
    '--cpus', opts.config.cpus,
    '--pids-limit', String(opts.config.pidsLimit),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', `${SANDBOX_UID}:${SANDBOX_UID}`,
    ...(argv[0] === SANDBOX_ENTRYPOINT ? [] : ['--entrypoint', argv[0]!]),
    opts.config.image,
    ...argv.slice(1),
  ];
}

async function docker(args: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number) {
  return exec('docker', args, { env, timeoutMs });
}

/**
 * `docker run` arguments for the run's model gateway (same image, runs model-gateway.mjs).
 * One gateway per run: each run carries its own BYOK key. The key goes by NAME (`-e ITERA_UPSTREAM_KEY`):
 * docker reads the value from the environment of the docker CLI process, so it never appears in argv.
 */
export function buildGatewayArgs(opts: { name: string; config: SandboxConfig; route?: ModelRoute; sessionId?: string }): string[] {
  const route = opts.route ?? modelRoute('openrouter/x', opts.config);
  const routeEnv = [
    '-e', `ITERA_ROUTE=${route.route}`,
    '-e', `ITERA_GATEWAY_PATH_PREFIX=${route.pathPrefix}`,
    ...(route.price ? ['-e', `ITERA_PRICE_JSON=${JSON.stringify({ input: route.price.input, output: route.price.output, cacheRead: route.price.cacheRead })}`] : []),
    ...(route.needsSessionHeader && opts.sessionId ? ['-e', `ITERA_GATEWAY_SESSION=${opts.sessionId}`] : []),
  ];
  return [
    'run', '-d', '--name', opts.name,
    '--label', 'itera.role=model-gateway',
    '--network', 'bridge',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m', '--pids-limit', '128',
    '-e', 'ITERA_UPSTREAM_KEY',
    '-e', `ITERA_UPSTREAM=${route.upstream}`,
    ...routeEnv,
    '-e', `ITERA_GATEWAY_PORT=${GATEWAY_PORT}`,
    '-e', `ITERA_RUN_MAX_COST_USD=${opts.config.maxCostUsd}`,
    '-e', `ITERA_GATEWAY_429_RETRIES=${opts.config.rateLimitRetries}`,
    '--entrypoint', 'node', opts.config.image, '/opt/itera/model-gateway.mjs',
  ];
}

/** Remove sandbox containers and run networks that a crashed worker left behind. */
export async function removeOrphans(): Promise<number> {
  const ids: string[] = [];
  for (const role of ['agent-sandbox', 'model-gateway', 'mcp-sidecar']) {
    const ps = await docker(['ps', '-aq', '--filter', `label=itera.role=${role}`]);
    ids.push(...ps.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  }
  if (ids.length > 0) await docker(['rm', '-fv', ...ids]);
  const nets = await docker(['network', 'ls', '-q', '--filter', 'label=itera.role=sandbox-net']);
  for (const id of nets.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const inspect = await docker(['network', 'inspect', '-f', '{{range $k, $v := .Containers}}{{$v.Name}} {{end}}', id]);
    for (const name of inspect.stdout.split(' ').map((s) => s.trim()).filter(Boolean)) {
      await docker(['network', 'disconnect', '-f', id, name]);
    }
    await docker(['network', 'rm', id]);
  }
  return ids.length;
}

/**
 * Make sure the sandbox image for `contextDir` exists. The tag is a hash of the directory's
 * files, so a changed sandbox/ builds a new image and the old one is never reused by mistake.
 */
export async function ensureSandboxImage(contextDir: string, repo = 'itera-runner-sandbox'): Promise<string> {
  const { readdir, readFile } = await import('node:fs/promises');
  const hash = createHash('sha256');
  for (const name of (await readdir(contextDir)).sort()) {
    hash.update(name);
    hash.update(await readFile(`${contextDir}/${name}`));
  }
  const tag = `${repo}:${hash.digest('hex').slice(0, 12)}`;
  const inspect = await docker(['image', 'inspect', '-f', '{{.Id}}', tag]);
  if (inspect.code === 0) return tag;
  const build = await docker(['build', '-q', '-t', tag, contextDir], undefined, 900_000);
  if (build.code !== 0) throw new Error(`sandbox image build failed: ${build.stderr.slice(-500)}`);
  return tag;
}

/**
 * Remove the `repo:*` sandbox image tags other than `current` (K11, plan risk R10: each sandbox/
 * change builds a new ~1 GB tag and the VPS disk is small). `docker rmi` refuses an image that a
 * container still uses, so a tag in use is kept. Returns the removed tags.
 */
export async function pruneSandboxImages(current: string, repo = 'itera-runner-sandbox', d: typeof docker = docker): Promise<string[]> {
  const ls = await d(['image', 'ls', repo, '--format', '{{.Repository}}:{{.Tag}}']);
  if (ls.code !== 0) return [];
  const removed: string[] = [];
  for (const tag of staleSandboxTags(ls.stdout, current, repo)) {
    const rm = await d(['rmi', tag]);
    if (rm.code === 0) removed.push(tag);
  }
  return removed;
}

/** The tags of `repo` in a `docker image ls` listing, minus `current` and `<none>`. */
export function staleSandboxTags(listing: string, current: string, repo = 'itera-runner-sandbox'): string[] {
  return listing
    .split('\n')
    .map((l) => l.trim())
    .filter((t) => t.startsWith(`${repo}:`) && t !== current && !t.endsWith(':<none>'));
}

export interface SandboxResult {
  /** opencode stdout: one JSON event per line. */
  events: string;
  stderrTail: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  /** Model usage measured by the run's gateway (OpenRouter `usage`), or null when the gateway log has none. */
  modelUsage: ModelUsage | null;
  /** K10: which upstream the run's gateway used. */
  route: RouteId;
  /** ADR-11: final state + call log of each MCP sidecar (trusted plane only; never stored raw). */
  mcp: CollectedSidecar[];
}

/** Where the sandbox image keeps opencode's global config (services/runner/sandbox/Dockerfile). */
export const OPENCODE_CONFIG_DIR = '/home/agent/.config/opencode';
const BASE_OPENCODE_CONFIG = joinPath(import.meta.dirname, '..', 'sandbox', 'opencode.json');

/**
 * Run the agent in a fresh container, on a fresh `--internal` network shared only with the
 * model gateway. The workspace goes in and comes back with `docker cp` (tar streams): no bind
 * mount, so this works the same when the worker itself runs in a container.
 */
export async function runInSandbox(opts: {
  runId: string;
  workspaceDir: string;
  /** Where the agent's tree is extracted after the run (without .git and node_modules). */
  outDir: string;
  model: string;
  prompt: string;
  /** The upstream key of the run's route (OpenRouter or opencode go). It goes only to the gateway. */
  modelKey: string;
  config: SandboxConfig;
  /** ADR-11: the task's MCP servers (mcp-sidecar.ts planSidecars). Each joins this run's network only. */
  mcp?: McpSidecarPlan[];
  /** ADR-11: the task's built-in tool allow-list (neutral names). Default: every built-in tool. */
  builtinTools?: readonly string[];
}): Promise<SandboxResult> {
  const id = opts.runId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  const name = `itera-run-${id}`;
  const gateway = `itera-gw-${id}`;
  const network = `itera-sbx-${id}`;
  const cleanup: Array<() => Promise<unknown>> = [];
  const route = modelRoute(opts.model, opts.config);
  try {
    const net = await docker(['network', 'create', '--internal', '--label', 'itera.role=sandbox-net', network]);
    if (net.code !== 0) throw new Error(`network create failed: ${net.stderr.slice(0, 300)}`);
    cleanup.push(() => docker(['network', 'rm', network]));
    const gw = await docker(buildGatewayArgs({ name: gateway, config: opts.config, route, sessionId: `itera-${id}` }), { ...process.env, ITERA_UPSTREAM_KEY: opts.modelKey });
    if (gw.code !== 0) throw new Error(`model gateway did not start: ${gw.stderr.slice(0, 300)}`);
    cleanup.unshift(() => docker(['rm', '-f', gateway]));
    const join = await docker(['network', 'connect', '--alias', GATEWAY_ALIAS, network, gateway]);
    if (join.code !== 0) throw new Error(`gateway network connect failed: ${join.stderr.slice(0, 300)}`);

    // MCP sidecars: one per declared server, on THIS run's internal network only, ready before the agent starts.
    const handles: SidecarHandle[] = [];
    for (const plan of opts.mcp ?? []) {
      handles.push(await bootSidecar({ name: sidecarName(id, plan.name), network, plan, cleanup }));
    }

    const created = await docker(buildCreateArgs({ name, network, model: opts.model, prompt: opts.prompt, config: opts.config }));
    if (created.code !== 0) throw new Error(`sandbox create failed: ${created.stderr.slice(0, 300)}`);
    cleanup.unshift(() => docker(['rm', '-f', name]));

    const builtin = opts.builtinTools ?? BUILTIN_TOOLS;
    if (handles.length > 0 || BUILTIN_TOOLS.some((t) => !builtin.includes(t))) {
      const base = JSON.parse(await readFile(BASE_OPENCODE_CONFIG, 'utf-8')) as Record<string, unknown>;
      const cfg = Buffer.from(JSON.stringify(opencodeRunConfig(base, handles, builtin), null, 2));
      const wrote = await exec('docker', ['cp', '-', `${name}:${OPENCODE_CONFIG_DIR}`], { input: tarFile('opencode.json', cfg) });
      if (wrote.code !== 0) throw new Error(`opencode config copy failed: ${wrote.stderr.slice(0, 300)}`);
    }

    // `docker cp` writes the files as root (its `-a` mode fails on a stopped container with a
    // non-root USER: "getent unable to find entry"). Mode a+rwX lets the sandbox user edit them.
    const copyIn = await pipe(
      { cmd: 'tar', args: ['--mode=a+rwX', '-C', opts.workspaceDir, '-cf', '-', '.'] },
      { cmd: 'docker', args: ['cp', '-', `${name}:${WORKSPACE_IN_SANDBOX}`] },
    );
    if (copyIn.fromCode !== 0 || copyIn.toCode !== 0) throw new Error(`copy-in failed: ${copyIn.stderr.slice(0, 300)}`);

    const startedAt = Date.now();
    const run = await docker(['start', '-a', name], undefined, opts.config.wallMs);
    const durationMs = Date.now() - startedAt;
    if (run.timedOut) await docker(['kill', name]);

    await mkdir(opts.outDir, { recursive: true });
    const copyOut = await pipe(
      { cmd: 'docker', args: ['cp', `${name}:${WORKSPACE_IN_SANDBOX}/.`, '-'] },
      {
        cmd: 'tar',
        args: ['-x', '--no-same-owner', '--no-same-permissions', '--exclude=./.git', '--exclude=./node_modules', '-C', opts.outDir, '-f', '-'],
      },
    );
    if (copyOut.fromCode !== 0 || copyOut.toCode !== 0) throw new Error(`copy-out failed: ${copyOut.stderr.slice(0, 300)}`);

    const inspect = await docker(['inspect', '-f', '{{.State.ExitCode}}', name]);
    // The gateway logs its running total after each model call; the last line is the run's usage.
    const gwLogs = await docker(['logs', gateway]);
    // The final MCP state, read before the sidecars are removed (docker exec, not a network port).
    const mcp: CollectedSidecar[] = [];
    for (const h of handles) mcp.push(await collectSidecar(h));
    return {
      mcp,
      route: route.route,
      modelUsage: parseGatewayUsage(gwLogs.stdout),
      events: run.stdout,
      stderrTail: run.stderr.slice(-2000),
      exitCode: run.timedOut ? 124 : Number(inspect.stdout.trim() || run.code),
      timedOut: run.timedOut,
      durationMs,
    };
  } finally {
    for (const step of cleanup) await step().catch(() => undefined);
  }
}

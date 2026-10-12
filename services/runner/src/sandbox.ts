import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { exec, pipe } from './exec.js';
import { WORKSPACE_IN_SANDBOX } from './trace.js';

export const SANDBOX_UID = 10001;
export const DEFAULT_WALL_MS = 300_000;
/** Network alias of the model gateway; sandbox/opencode.json points the openrouter provider here. */
export const GATEWAY_ALIAS = 'itera-gateway';
export const GATEWAY_PORT = 3128;

export interface SandboxConfig {
  /** Image built from services/runner/sandbox/Dockerfile. */
  image: string;
  /** Name of the long-lived model gateway container (same image, runs model-gateway.mjs). */
  gatewayContainer: string;
  /** The only upstream the gateway forwards to. */
  upstream: string;
  wallMs: number;
  memory: string;
  cpus: string;
  pidsLimit: number;
}

export function defaultSandboxConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  return {
    image: env.ITERA_SANDBOX_IMAGE ?? 'itera-runner-sandbox:latest',
    gatewayContainer: env.ITERA_GATEWAY_CONTAINER ?? 'itera-runner-gateway',
    upstream: env.ITERA_MODEL_UPSTREAM ?? 'https://openrouter.ai',
    wallMs: Number(env.ITERA_RUN_WALL_MS ?? DEFAULT_WALL_MS),
    memory: env.ITERA_SANDBOX_MEMORY ?? '2g',
    cpus: env.ITERA_SANDBOX_CPUS ?? '2',
    pidsLimit: Number(env.ITERA_SANDBOX_PIDS ?? 512),
  };
}

export function normalizeModel(model: string): string {
  if (!/^[A-Za-z0-9._:/~-]+$/.test(model)) throw new Error(`invalid model id: ${model}`);
  return model.startsWith('openrouter/') ? model : `openrouter/${model}`;
}

/**
 * `docker create` arguments for one agent run. The sandbox gets NO secret: the model key lives
 * only in the gateway container, which adds it to each upstream request.
 */
export function buildCreateArgs(opts: {
  name: string;
  network: string;
  model: string;
  prompt: string;
  config: SandboxConfig;
}): string[] {
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
    opts.config.image,
    'run', '--pure', '--format', 'json',
    '--dir', WORKSPACE_IN_SANDBOX,
    '-m', normalizeModel(opts.model),
    opts.prompt,
  ];
}

async function docker(args: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number) {
  return exec('docker', args, { env, timeoutMs });
}

/** A short fingerprint of the key, stored as a label, so a rotated key recreates the gateway. */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

async function ensureGateway(config: SandboxConfig, key: string): Promise<void> {
  const fp = keyFingerprint(key);
  const inspect = await docker(['inspect', '-f', '{{.State.Running}} {{index .Config.Labels "itera.key-fp"}}', config.gatewayContainer]);
  if (inspect.code === 0 && inspect.stdout.trim() === `true ${fp}`) return;
  if (inspect.code === 0) await docker(['rm', '-f', config.gatewayContainer]);
  const started = await docker(
    [
      'run', '-d', '--name', config.gatewayContainer, '--restart', 'unless-stopped',
      '--label', 'itera.role=model-gateway', '--label', `itera.key-fp=${fp}`,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m',
      // The key goes by NAME: docker reads the value from this process's environment, not argv.
      '-e', 'ITERA_UPSTREAM_KEY',
      '-e', `ITERA_UPSTREAM=${config.upstream}`,
      '-e', `ITERA_GATEWAY_PORT=${GATEWAY_PORT}`,
      '--entrypoint', 'node', config.image, '/opt/itera/model-gateway.mjs',
    ],
    { ...process.env, ITERA_UPSTREAM_KEY: key },
  );
  if (started.code !== 0) throw new Error(`model gateway did not start: ${started.stderr.slice(0, 300)}`);
}

export interface SandboxResult {
  /** opencode stdout: one JSON event per line. */
  events: string;
  stderrTail: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

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
  openrouterKey: string;
  config: SandboxConfig;
}): Promise<SandboxResult> {
  const id = opts.runId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  const name = `itera-run-${id}`;
  const network = `itera-sbx-${id}`;
  const cleanup: Array<() => Promise<unknown>> = [];
  try {
    await ensureGateway(opts.config, opts.openrouterKey);
    const net = await docker(['network', 'create', '--internal', '--label', 'itera.role=sandbox-net', network]);
    if (net.code !== 0) throw new Error(`network create failed: ${net.stderr.slice(0, 300)}`);
    cleanup.push(() => docker(['network', 'rm', network]));
    const join = await docker(['network', 'connect', '--alias', GATEWAY_ALIAS, network, opts.config.gatewayContainer]);
    if (join.code !== 0) throw new Error(`gateway network connect failed: ${join.stderr.slice(0, 300)}`);
    cleanup.unshift(() => docker(['network', 'disconnect', '-f', network, opts.config.gatewayContainer]));

    const created = await docker(buildCreateArgs({ name, network, model: opts.model, prompt: opts.prompt, config: opts.config }));
    if (created.code !== 0) throw new Error(`sandbox create failed: ${created.stderr.slice(0, 300)}`);
    cleanup.unshift(() => docker(['rm', '-f', name]));

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
    return {
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

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
//
// `tma` launcher: runs the TestMyAgent local runner image on YOUR machine (plan
// 20261026-tma-local-runner-and-self-declared-results, task L10, Q3 = A, Q 37d5c296 = A).
//
// What it does, and nothing more:
// 1. picks the image: ghcr.io/devfellowship/tma-local@sha256:<digest>, pinned in image.json at publish time;
// 2. verifies its cosign signature when `cosign` is installed (TMA_REQUIRE_SIGNATURE=1 makes it mandatory);
// 3. runs it with `docker run --rm --init`, as YOUR uid, with your current folder and ~/.config/tma;
// 4. mounts the host Docker socket ONLY for `tma run` and `tma grade` (they start the sandbox containers),
//    and says so before it starts: socket access is root-equivalent on this machine;
// 5. passes your model key by NAME (docker reads the value from this process), only to `tma run`.
// No dependency. No network call of its own (docker pulls the image; cosign fetches the signature).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LAUNCHER_VERSION = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf-8')).version;

/** The commands of the image that start containers through the Docker socket. */
export const SOCKET_COMMANDS = new Set(['run', 'grade']);
/** The commands that send the user's model key to the run's gateway. */
export const KEY_COMMANDS = new Set(['run']);
export const KEY_ENV = ['OPENROUTER_API_KEY', 'OPENCODE_GO_API_KEY'];
/** Variables passed by name to every command (no secret). */
export const PLAIN_ENV = ['TMA_API_URL', 'ITERA_SANDBOX_IMAGE'];

export const SIGNER_IDENTITY = '^https://github\\.com/devfellowship/itera-certificacao-onchain/\\.github/workflows/tma-local\\.yml@refs/heads/main$';
export const SIGNER_ISSUER = 'https://token.actions.githubusercontent.com';

export class LauncherError extends Error {}

export function readPin(dir = PKG_DIR) {
  return JSON.parse(readFileSync(join(dir, 'image.json'), 'utf-8'));
}

/** The image reference to run. A published launcher is pinned by digest; TMA_LAUNCHER_IMAGE overrides it (development). */
export function resolveImage(pin, env = process.env) {
  const override = env.TMA_LAUNCHER_IMAGE?.trim();
  if (override) return { ref: override, pinned: /@sha256:[0-9a-f]{64}$/.test(override), override: true };
  if (pin.digest && /^sha256:[0-9a-f]{64}$/.test(pin.digest)) return { ref: `${pin.image}@${pin.digest}`, pinned: true, override: false };
  throw new LauncherError(
    'this copy of the launcher has no pinned image digest (a development copy from git). ' +
      `Use the published launcher (npx @devfellowship/tma@${pin.version}), or set TMA_LAUNCHER_IMAGE=${pin.image}@sha256:<digest>.`,
  );
}

/** The host path of the Docker socket. Only a unix socket can be mounted. */
export function hostSocket(env = process.env, platform = process.platform) {
  // Docker Desktop (macOS, Windows) maps the source /var/run/docker.sock to its VM's socket.
  if (platform !== 'linux') return '/var/run/docker.sock';
  const host = env.DOCKER_HOST?.trim();
  if (!host) return '/var/run/docker.sock';
  if (host.startsWith('unix://')) return host.slice('unix://'.length);
  throw new LauncherError(`DOCKER_HOST=${host} is not a unix socket. The launcher mounts a local socket only; unset DOCKER_HOST or point it to unix:///path/docker.sock.`);
}

/** Refuse an absolute path argument outside the current folder: the container sees the current folder only. */
export function checkPaths(args, cwd) {
  for (const a of args) {
    const value = a.startsWith('--') && a.includes('=') ? a.slice(a.indexOf('=') + 1) : a;
    if (!isAbsolute(value)) continue;
    const rel = relative(cwd, resolve(value));
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new LauncherError(`${value} is outside the current folder ${cwd}. The tma container sees only the current folder: cd to a folder that contains it, or use a relative path.`);
    }
  }
}

/**
 * The full `docker run` argument list. Pure: every input is a parameter (tested in test/launcher.test.mjs).
 * ctx: { args, cwd, configDir, image, platform, uid, gid, socketGid, socketPath, env, tty, name }
 */
export function dockerArgs(ctx) {
  const command = ctx.args[0] ?? '';
  const socket = SOCKET_COMMANDS.has(command);
  const linux = ctx.platform === 'linux';
  const asRoot = linux ? ctx.uid === 0 : socket; // Docker Desktop: the socket in the VM is root-owned.
  const out = ['run', '--rm', '--init', '-i'];
  if (ctx.tty) out.push('-t');
  out.push('--name', ctx.name, '--platform', 'linux/amd64');
  out.push('--security-opt', 'no-new-privileges', '--pids-limit', '2048', '--memory', '4g');
  if (!asRoot) out.push('--cap-drop', 'ALL');
  if (linux) out.push('--user', `${ctx.uid}:${ctx.gid}`);
  else if (asRoot) out.push('--user', '0:0');
  if (socket) {
    if (linux && ctx.socketGid !== undefined && ctx.uid !== 0) out.push('--group-add', String(ctx.socketGid));
    out.push('-v', `${ctx.socketPath}:/var/run/docker.sock`);
  }
  out.push('-v', `${ctx.cwd}:${ctx.cwd}`, '-w', ctx.cwd);
  out.push('-v', `${ctx.configDir}:/tma-config`, '-e', 'TMA_CONFIG_DIR=/tma-config', '-e', 'HOME=/tmp');
  for (const name of PLAIN_ENV) if (ctx.env[name]) out.push('-e', name);
  if (KEY_COMMANDS.has(command)) for (const name of KEY_ENV) if (ctx.env[name]) out.push('-e', name);
  out.push(ctx.image, ...ctx.args);
  return out;
}

export function socketNotice(image, socketPath, signature) {
  return [
    `[tma] This command mounts your Docker socket (${socketPath}) into the tma-local container.`,
    '[tma] WARNING: access to the Docker socket is ROOT-EQUIVALENT on this machine. The container can start any',
    '[tma]   container, with any host folder. It uses the socket only to start the sandbox, model gateway and grader',
    '[tma]   containers of your run; those containers never get the socket. Run it only on a machine that you own.',
    '[tma] The hosted TestMyAgent service never gets your socket: a hosted run uses TestMyAgent machines, not this one.',
    `[tma] Image: ${image} (signature: ${signature})`,
  ].join('\n');
}

const which = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf-8' }).status === 0;

/** Verify the cosign keyless signature of the image. Returns 'verified' | 'not checked (...)'; throws on a bad signature. */
export function verifySignature(img, env = process.env, run = spawnSync, has = which) {
  if (img.override) return 'not checked (TMA_LAUNCHER_IMAGE override)';
  const required = env.TMA_REQUIRE_SIGNATURE === '1';
  if (!has('cosign')) {
    if (required) throw new LauncherError('TMA_REQUIRE_SIGNATURE=1 but cosign is not installed (https://docs.sigstore.dev/cosign/system_config/installation/).');
    return 'not checked (cosign not installed; the image is pinned by digest)';
  }
  const r = run('cosign', ['verify', '--certificate-identity-regexp', SIGNER_IDENTITY, '--certificate-oidc-issuer', SIGNER_ISSUER, img.ref], { encoding: 'utf-8' });
  if (r.status !== 0) throw new LauncherError(`the signature of ${img.ref} does not verify. Do not run it. cosign said: ${(r.stderr || '').slice(-400)}`);
  return 'verified (cosign, GitHub Actions of devfellowship/itera-certificacao-onchain)';
}

function launcherHelp(pin) {
  return [
    `tma launcher ${LAUNCHER_VERSION} — runs ${pin.image}${pin.digest ? `@${pin.digest}` : ' (no pinned digest: development copy)'}`,
    '',
    'tma <command> [flags]     every command of the image (tma --help inside: login, agent, run, workspace, grade, upload, ...)',
    'tma launcher-info         the image, its signature check, and what the launcher mounts',
    'tma launcher-help         this text',
    '',
    'Mounts: the current folder, ~/.config/tma; the Docker socket ONLY for `run` and `grade` (root-equivalent, see launcher-info).',
    'Paths: give paths inside the current folder (the container sees only that folder).',
    'Env passed by name: OPENROUTER_API_KEY, OPENCODE_GO_API_KEY (to `run` only), TMA_API_URL, ITERA_SANDBOX_IMAGE.',
    'Launcher env: TMA_REQUIRE_SIGNATURE=1 (cosign mandatory), TMA_LAUNCHER_DRY_RUN=1 (print the docker command), TMA_LAUNCHER_IMAGE (override, development).',
  ].join('\n');
}

export async function main(args, env = process.env, io = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) }) {
  try {
    const pin = readPin();
    if (args[0] === 'launcher-help') {
      io.out(launcherHelp(pin));
      return 0;
    }
    // The bare help shows what the launcher mounts first, then the image's own help.
    if (args.length === 0 || ['help', '--help', '-h'].includes(args[0])) io.err(`${launcherHelp(pin)}\n`);
    const img = resolveImage(pin, env);
    const command = args[0] ?? '';
    const socket = SOCKET_COMMANDS.has(command);
    const cwd = process.cwd();
    checkPaths(args.slice(1), cwd);
    const configDir = env.TMA_CONFIG_DIR?.trim() || join(homedir(), '.config', 'tma');
    const dry = env.TMA_LAUNCHER_DRY_RUN === '1';
    if (!dry) mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const socketPath = hostSocket(env);
    if (socket && !dry && process.platform === 'linux' && !existsSync(socketPath)) {
      throw new LauncherError(`no Docker socket at ${socketPath}. Start Docker (docker version must show a server).`);
    }
    if (!dry && !which('docker')) throw new LauncherError('docker is not installed. Install Docker Engine 24+ or Docker Desktop.');
    const signature = dry ? 'not checked (dry run)' : verifySignature(img, env);
    if (command === 'launcher-info') {
      io.out(`image: ${img.ref}\npinned by digest: ${img.pinned}\nsignature: ${signature}`);
      io.out(`verify yourself: cosign verify --certificate-identity-regexp '${SIGNER_IDENTITY}' --certificate-oidc-issuer ${SIGNER_ISSUER} ${img.ref}`);
      io.out(socketNotice(img.ref, socketPath, signature));
      return 0;
    }
    if (socket) io.err(socketNotice(img.ref, socketPath, signature));
    else if (!img.pinned || img.override) io.err(`[tma] image: ${img.ref} (not pinned by the launcher: development override)`);
    const argv = dockerArgs({
      args,
      cwd,
      configDir,
      image: img.ref,
      platform: process.platform,
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      socketGid: socket && process.platform === 'linux' && existsSync(socketPath) ? statSync(socketPath).gid : undefined,
      socketPath,
      env,
      tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      name: `tma-${randomBytes(4).toString('hex')}`,
    });
    if (dry) {
      io.out(['docker', ...argv].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' '));
      return 0;
    }
    return await new Promise((resolveCode) => {
      const child = spawn('docker', argv, { stdio: 'inherit', env });
      // Ctrl-C reaches docker from the terminal; docker forwards it to the container, whose CLI then
      // removes its run containers. The launcher waits for that, and forwards a SIGTERM sent to it alone.
      process.on('SIGINT', () => undefined);
      process.on('SIGTERM', () => child.kill('SIGTERM'));
      child.on('exit', (code, sig) => resolveCode(code ?? (sig ? 128 + 15 : 1)));
      child.on('error', (e) => {
        io.err(`tma: cannot start docker: ${e.message}`);
        resolveCode(1);
      });
    });
  } catch (e) {
    if (e instanceof LauncherError) {
      io.err(`tma: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

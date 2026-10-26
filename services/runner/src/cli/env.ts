// The ONLY place where the local runner CLI reads the environment (plan
// 20261026-tma-local-runner-and-self-declared-results, ADR-6, Verification row 6).
//
// The keys come from the USER's own environment, never from TMA, DFL or a fleet path. The CLI does
// not read the worker variables (the platform OpenRouter key, DATABASE_URL, the run-key secret): a
// test scans src/cli/ and fails on any other environment read, and on any name outside this list.
import type { RouteId } from '../model-route.js';

/** Every environment variable that the CLI reads. Add a name here only with a reason in the PR. */
export const USER_ENV_ALLOWLIST = [
  /** The user's OpenRouter key, for the `openrouter` route of `tma run`. */
  'OPENROUTER_API_KEY',
  /** The user's opencode go key, for the `opencode-go` route of `tma run`. */
  'OPENCODE_GO_API_KEY',
  /** The TMA API base URL (default: the production API). */
  'TMA_API_URL',
  /** Where the CLI keeps its files (the login session of `tma login`, L7). Default ~/.config/tma. */
  'TMA_CONFIG_DIR',
  /** A sandbox image that the user built or pulled. Default: built from the bundled sandbox context. */
  'ITERA_SANDBOX_IMAGE',
  /** The Docker daemon of the user (read by the docker CLI child process; named here for the record). */
  'DOCKER_HOST',
] as const;

export type UserEnvName = (typeof USER_ENV_ALLOWLIST)[number];

/**
 * System variables that a child process (npm, git) needs to start. Not configuration and not a
 * secret: only these two are passed on, and nothing else of the user's shell reaches npm.
 */
export const SYSTEM_ENV = ['PATH', 'HOME'] as const;

/** The scrubbed environment of a trusted-side child process (npm ci of the workspace), as on the worker. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { PATH: env.PATH, HOME: env.HOME ?? '/tmp', LANG: 'C.UTF-8' };
}

export class CliError extends Error {}

/** Read one allowed variable. An empty or whitespace-only value is `undefined`. */
export function userEnv(name: UserEnvName, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!(USER_ENV_ALLOWLIST as readonly string[]).includes(name)) throw new CliError(`the CLI does not read ${name}`);
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

/** The key variable of each sandbox route. */
export const ROUTE_KEY_ENV: Readonly<Record<RouteId, UserEnvName>> = {
  openrouter: 'OPENROUTER_API_KEY',
  'opencode-go': 'OPENCODE_GO_API_KEY',
};

/**
 * The user's model key for a route. Refuses, with the variable to set, when it is missing or empty.
 * The key goes only to the run's gateway container; it never enters a result file or an upload.
 */
export function userModelKey(route: RouteId, env: NodeJS.ProcessEnv = process.env): string {
  const name = ROUTE_KEY_ENV[route];
  const key = userEnv(name, env);
  if (!key) {
    throw new CliError(
      `no model key: set ${name} to YOUR own ${route === 'opencode-go' ? 'opencode go' : 'OpenRouter'} key (export ${name}=...). ` +
        'The local runner uses only your key from the environment. It never reads a TestMyAgent or fleet key.',
    );
  }
  return key;
}

/** The TMA API base URL, without a trailing slash. */
export const DEFAULT_TMA_API_URL = 'https://itera-agent-credentials-api.devfellowship.com';
export function apiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (userEnv('TMA_API_URL', env) ?? DEFAULT_TMA_API_URL).replace(/\/+$/, '');
}

/**
 * The environment that the CLI gives to `defaultSandboxConfig`: the run profile and the user's
 * sandbox image only. No worker override (wall, cost cap, upstreams) reaches a local run.
 */
export function sandboxEnv(profile: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const image = userEnv('ITERA_SANDBOX_IMAGE', env);
  return { ITERA_RUN_PROFILE: profile, ...(image ? { ITERA_SANDBOX_IMAGE: image } : {}) };
}

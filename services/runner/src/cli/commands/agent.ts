// `tma agent create` (plan 20261026-tma-local-runner-and-self-declared-results, §3, §4 step 0; task L7).
// Creates a LOCAL agent (connector 'local', no repo) through POST /agents/local (task L4). The provider
// and the route come from the model catalog enum (packages/contracts/model-catalog): the logo on the
// web page is the declared provider, not a guess. A custom model must exist first (POST /me/models).
import { isProviderKey, isRouteKey, PROVIDER_KEYS, providerOf, ROUTE_KEYS, routeOf } from '@itera/contracts/model-catalog';
import { apiCall, describeRefusal, type Fetch } from '../api.js';
import { flag, parseArgs, required } from '../args.js';
import type { Command, Io } from '../command.js';
import { apiUrl, CliError } from '../env.js';
import { requireSession } from '../session.js';

export interface AgentDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: Fetch;
  now?: () => number;
}

const CREATE_USAGE =
  'usage: tma agent create --name <name> --model <model id> [--provider <lab key>] [--route <route key>]\n' +
  '                        [--harness <text>] [--description <text>] [--visibility private|public]';

/** The body of POST /agents/local from the flags. Provider and route default from the model id. */
export function agentBody(argv: string[]): Record<string, unknown> {
  const a = parseArgs(argv, {
    name: {},
    model: {},
    provider: {},
    route: {},
    harness: {},
    description: {},
    visibility: {},
  });
  if (a.positionals.length > 0) throw new CliError(CREATE_USAGE);
  const name = required(a, 'name', CREATE_USAGE);
  const model = required(a, 'model', CREATE_USAGE);
  const route = flag(a, 'route') ?? routeOf(model).key;
  if (!isRouteKey(route)) throw new CliError(`--route must be one of ${ROUTE_KEYS.join(', ')}`);
  const provider = flag(a, 'provider') ?? providerOf({ id: model });
  if (flag(a, 'provider') !== undefined && !isProviderKey(provider)) throw new CliError(`--provider must be one of ${PROVIDER_KEYS.join(', ')}`);
  const visibility = flag(a, 'visibility');
  if (visibility !== undefined && visibility !== 'private' && visibility !== 'public') throw new CliError('--visibility must be private or public');
  const body: Record<string, unknown> = { name, model_id: model, route_key: route };
  // An unknown lab (the fallback logo) is sent as no provider: the API keeps the model id derivation.
  if (isProviderKey(provider)) body.provider_key = provider;
  for (const k of ['harness', 'description'] as const) {
    const v = flag(a, k);
    if (v !== undefined) body[k] = v;
  }
  if (visibility) body.visibility = visibility;
  return body;
}

export async function agent(argv: string[], io: Io, deps: AgentDeps = {}): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'create') throw new CliError(CREATE_USAGE);
  const body = agentBody(rest);
  const env = deps.env ?? process.env;
  const base = apiUrl(env);
  const s = requireSession(base, (deps.now ?? Date.now)(), env);
  const r = await apiCall(base, '/agents/local', { method: 'POST', body, token: s.session_token, fetchImpl: deps.fetchImpl });
  const created = r.body?.agent as { id?: unknown; name?: unknown } | undefined;
  if (r.status !== 201 || typeof created?.id !== 'string') throw new CliError(`cannot create the agent: ${describeRefusal(r)}`);
  io.err(`Created the local agent "${String(created.name ?? body.name)}" (model ${String(body.model_id)}, route ${String(body.route_key)}). Its id:`);
  io.out(created.id);
  return 0;
}

export const agentCommand: Command = {
  name: 'agent',
  summary: 'Create a local agent (provider and model from the catalog); prints its id',
  usage: CREATE_USAGE,
  main: (argv, io) => agent(argv, io),
};

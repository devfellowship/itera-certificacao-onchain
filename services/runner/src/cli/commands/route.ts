// `tma route pr|rollback|mark` (plan 20261112-tma-c8-routing-from-evals, T4, ADR-1, ADR-2): the apply path
// of an approved model route. The studio never runs this; claude-main or a person does.
//
//   pr        an approved route row -> a PR to the infra repo that edits ONE flag line (or one model cell
//             of the CLAUDE.md table) and keeps the old value as the rollback line;
//   rollback  a live route -> a PR that writes the old value back;
//   mark      PATCH /routes/:id/state after the merge (live or rolled_back, with the PR URL).
//
// A refusal prints one line and exits 2. --dry-run prints the exact diff and the PR text and runs nothing.
// git and gh run through an injectable exec, so the tests never touch a real repository or GitHub.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateRoute, type Route } from '@itera/contracts';
import { exec as realExec, type ExecResult } from '../../exec.js';
import { apiCall, describeRefusal, type Fetch } from '../api.js';
import { flag, has, parseArgs, required } from '../args.js';
import type { Command, Io } from '../command.js';
import { apiUrl, CliError } from '../env.js';
import { requireSession } from '../session.js';
import {
  branchName,
  checkRoute,
  parseTargets,
  planEdit,
  prBody,
  prTitle,
  RouteRefusal,
  unifiedDiff,
  type RouteAction,
} from '../route/apply.js';

export type RouteExec = (cmd: string, args: string[], opts: { cwd: string }) => Promise<ExecResult>;

export interface RouteDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: Fetch;
  now?: () => number;
  /** Runs git and gh. Default: spawn without a shell, with the user's environment (gh needs its login). */
  exec?: RouteExec;
}

const PR_USAGE = `usage: tma route pr (--route-file <route.json> | --route <id>) --targets <targets.json> --repo-dir <infra checkout> [--dry-run] [--base master]
  Applies an APPROVED route (tma-route/1) to ONE file of the infra checkout and opens the PR:
  env:<FLAG>      replaces the FLAG=<old> line and writes a "# route ..." + "# rollback: FLAG=<old>" block above it;
  claude-md:<row> replaces the model cell (**\`value\`**) of the one row that starts with row_prefix.
  Refuses (exit 2): state is not approved; n < 5; the verdict does not pass under the picked rule (absolute:
  same|close, relative: better|same); the use case has no target, or another target, in the map; the value
  is not allowed; the file value is not rollback_value (re-approve); nothing to change.
  --targets   a dfl-route-targets/1 file (dfl-evals routes/targets.json)
  --repo-dir  a clean checkout of the infra repo, on an up-to-date <base>; map paths are relative to it
  --route     read GET <api>/routes/<id> with your tma login (task T2)
  --dry-run   print the exact unified diff and the PR title and body; write nothing, run no git and no gh
  Without --dry-run: git checkout -b route/<use case>/<id8>, commit, git push -u origin, gh pr create.`;

const ROLLBACK_USAGE = `usage: tma route rollback (--route-file <route.json> | --route <id>) --targets <targets.json> --repo-dir <infra checkout> [--dry-run] [--base master]
  Writes rollback_value back for a LIVE (or needs_check) route and opens the PR. The route comment block
  becomes one line "# route <id> rolled back: <new> -> <old>". Refuses when rollback_value is null.`;

const MARK_USAGE = `usage: tma route mark --route <id> --state live|rolled_back --pr <PR URL>
  After the merge: PATCH <api>/routes/<id>/state with {state, pr_url} (task T2; 404 until T2 ships).`;

const USAGE = ['usage: tma route <pr|rollback|mark> ...   (apply an approved model route by a PR: plan C8)', '', PR_USAGE, '', ROLLBACK_USAGE, '', MARK_USAGE].join('\n');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PR_RE = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}\/pull\/[0-9]{1,9}$/;

function checkRouteRow(value: unknown, label: string): Route {
  const r = validateRoute(value);
  if (!r.ok) throw new RouteRefusal(`${label} is not a valid tma-route/1 row: ${r.errors.slice(0, 3).join('; ')}`);
  return r.value;
}

async function readText(path: string): Promise<string> {
  const t = await readFile(path, 'utf-8').catch(() => null);
  if (t === null) throw new CliError(`cannot read ${path}`);
  return t;
}

function session(deps: RouteDeps) {
  const env = deps.env ?? process.env;
  const base = apiUrl(env);
  return { base, token: requireSession(base, (deps.now ?? Date.now)(), env).session_token };
}

async function loadRoute(a: ReturnType<typeof parseArgs>, usage: string, deps: RouteDeps): Promise<Route> {
  const file = flag(a, 'route-file');
  const id = flag(a, 'route');
  if ((file ? 1 : 0) + (id ? 1 : 0) !== 1) throw new CliError(`give one of --route-file or --route\n${usage}`);
  if (file) {
    const text = await readText(resolve(file));
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new RouteRefusal(`${file} is not JSON`);
    }
    return checkRouteRow(v, file);
  }
  if (!UUID_RE.test(id!)) throw new CliError(`not a route id: ${id!.slice(0, 60)}`);
  const { base, token } = session(deps);
  const r = await apiCall(base, `/routes/${id}`, { token, fetchImpl: deps.fetchImpl });
  if (r.status === 404) throw new CliError(`route ${id} not found (GET /routes/:id ships with task T2; use --route-file until then)`);
  if (r.status !== 200) throw new CliError(`cannot read the route: ${describeRefusal(r)}`);
  const row = r.body && typeof r.body.route === 'object' && r.body.route !== null ? r.body.route : r.body;
  return checkRouteRow(row, `GET /routes/${id}`);
}

async function run(exec: RouteExec, cwd: string, cmd: string, args: string[]): Promise<string> {
  let r: ExecResult;
  try {
    r = await exec(cmd, args, { cwd });
  } catch (e) {
    throw new CliError(`cannot run ${cmd} (${e instanceof Error ? e.message.slice(0, 120) : 'error'})`);
  }
  if (r.code !== 0) throw new CliError(`${cmd} ${args.slice(0, 2).join(' ')} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return r.stdout;
}

async function applyMain(action: RouteAction, argv: string[], io: Io, deps: RouteDeps): Promise<number> {
  const usage = action === 'pr' ? PR_USAGE : ROLLBACK_USAGE;
  const a = parseArgs(argv, { 'route-file': {}, route: {}, targets: {}, 'repo-dir': {}, 'dry-run': { boolean: true }, base: {} });
  const targetsFile = required(a, 'targets', usage);
  const repoDir = resolve(required(a, 'repo-dir', usage));
  const base = flag(a, 'base') ?? 'master';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(base)) throw new CliError(`--base is not a branch name: ${base.slice(0, 60)}`);
  const targets = parseTargets(await readText(resolve(targetsFile)), targetsFile);
  const route = await loadRoute(a, usage, deps);
  const target = checkRoute(action, route, targets);
  const filePath = join(repoDir, target.file);
  const edit = planEdit(action, route, target, await readText(filePath));
  const title = prTitle(edit);
  const body = prBody(edit);
  const diff = unifiedDiff(target.file, edit.before, edit.after);

  if (has(a, 'dry-run')) {
    io.err(`dry run: tma route ${action} writes nothing and runs no git and no gh`);
    io.out(diff);
    io.out('');
    io.out(`branch: ${branchName(edit)}`);
    io.out(`PR title: ${title}`);
    io.out('PR body:');
    io.out(body);
    return 0;
  }

  const exec = deps.exec ?? ((cmd, args, opts) => realExec(cmd, args, { cwd: opts.cwd }));
  const branch = branchName(edit);
  const status = await run(exec, repoDir, 'git', ['status', '--porcelain']);
  if (status.trim() !== '') throw new RouteRefusal(`${repoDir} has uncommitted changes: the apply path needs a clean checkout`);
  await run(exec, repoDir, 'git', ['checkout', '-b', branch]);
  await writeFile(filePath, edit.after, 'utf-8');
  io.err(`[tma route] wrote ${target.file} on branch ${branch}`);
  await run(exec, repoDir, 'git', ['add', '--', target.file]);
  await run(exec, repoDir, 'git', ['commit', '-m', title, '-m', `Route: ${route.id}\nUse case: ${route.use_case_key}\nVerdict: ${route.verdict} under the ${route.picked_rule} rule, n=${route.n}, policy ${route.policy_version}`]);
  await run(exec, repoDir, 'git', ['push', '-u', 'origin', branch]);
  const out = await run(exec, repoDir, 'gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body]);
  const url = out.trim().split('\n').reverse().find((l) => /^https:\/\//.test(l.trim()))?.trim() ?? out.trim();
  io.out(url);
  io.err(`next (after the merge and the apply): tma route mark --route ${route.id} --state ${action === 'pr' ? 'live' : 'rolled_back'} --pr ${url}`);
  return 0;
}

async function markMain(argv: string[], io: Io, deps: RouteDeps): Promise<number> {
  const a = parseArgs(argv, { route: {}, state: {}, pr: {} });
  const id = required(a, 'route', MARK_USAGE);
  const state = required(a, 'state', MARK_USAGE);
  const pr = required(a, 'pr', MARK_USAGE);
  if (!UUID_RE.test(id)) throw new CliError(`not a route id: ${id.slice(0, 60)}`);
  if (state !== 'live' && state !== 'rolled_back') throw new CliError(`--state must be live or rolled_back\n${MARK_USAGE}`);
  if (!PR_RE.test(pr)) throw new CliError(`--pr must be a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<n>)`);
  const { base, token } = session(deps);
  const r = await apiCall(base, `/routes/${id}/state`, { method: 'PATCH', body: { state, pr_url: pr }, token, fetchImpl: deps.fetchImpl });
  if (r.status === 404) {
    io.err(`tma route mark: 404 from PATCH /routes/${id}/state: the route is not found, or the API does not have this endpoint yet (task T2 of plan 20261112-tma-c8-routing-from-evals). Nothing was changed.`);
    return 1;
  }
  if (r.status < 200 || r.status >= 300) throw new CliError(`cannot set the route state: ${describeRefusal(r)}`);
  io.out(`route ${id} -> ${state} (${pr})`);
  return 0;
}

export function makeRouteCommand(deps: RouteDeps = {}): Command {
  return {
    name: 'route',
    summary: 'Apply an approved model route by a PR (pr), roll it back by a PR (rollback), record the state (mark)',
    usage: USAGE,
    async main(argv, io) {
      const [sub, ...rest] = argv;
      try {
        switch (sub) {
          case 'pr':
            return await applyMain('pr', rest, io, deps);
          case 'rollback':
            return await applyMain('rollback', rest, io, deps);
          case 'mark':
            return await markMain(rest, io, deps);
          default:
            throw new CliError(`${sub ? `unknown route command: ${sub}` : 'give a route command'}\n${USAGE}`);
        }
      } catch (e) {
        if (e instanceof RouteRefusal) {
          io.err(`tma route ${sub}: refused: ${e.message}`);
          return 2;
        }
        throw e;
      }
    },
  };
}

export const routeCommand: Command = makeRouteCommand();

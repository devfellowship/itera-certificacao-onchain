// `tma route pr|rollback|mark|list` (plan 20261112-tma-c8-routing-from-evals, T4, ADR-1, ADR-2): the apply path
// of an approved model route. The studio never runs this; claude-main or a person does.
//
//   pr        an approved route row -> a PR to the infra repo that edits ONE flag line (or one model cell
//             of the CLAUDE.md table) and keeps the old value as the rollback line. With --route (API mode), when
//             another route is already applied (live or needs_check) on the same target, the PR is a DRAFT and the
//             command registers a pending swap (PATCH live -> 202 swap_pending, Q d881e5df = C): a person approves or
//             rejects the swap on S12 before the PR is made ready and merged;
//   rollback  a live route -> a PR that writes the old value back;
//   mark      PATCH /routes/:id/state after the merge (live or rolled_back, with the PR URL), or the T5 mark
//             needs_check (no PR: ADR-7, a trigger marks a route, it never changes it);
//   list      GET /routes (filters state, use case), each row checked with validateRoute (the T5 trigger job reads it);
//   nightly   T6: run the golden set of each live route's use case with the routed agent, upload the runs, and mark
//             the route needs_check on a drop under its picked rule. A paid-run cap (budget.ts) refuses a run that
//             would pass it. It never changes a route value or a route file (ADR-7).
//   recheck   T5: compare today's observation (tma-route-observation/1) with the stored baselines and with each live
//             route's agent, and mark a route needs_check per trigger. It never runs git, never opens a route file,
//             never calls pr or rollback (ADR-7).
//
// A refusal prints one line and exits 2. --dry-run prints the exact diff and the PR text and runs nothing.
// git and gh run through an injectable exec, so the tests never touch a real repository or GitHub.
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ROUTE_STATES, parseRouteObservationText, validateRoute, type Route } from '@itera/contracts';
import { exec as realExec, type ExecResult } from '../../exec.js';
import { apiCall, describeRefusal, type ApiAnswer, type Fetch } from '../api.js';
import { flag, has, numberFlag, parseArgs, required } from '../args.js';
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
import { capsFromEnv, checkBudget, countPaidRuns, fetchRunRows, isPaidModel, parseTiers, type Tiers } from '../route/budget.js';
import {
  emptyNightlyState,
  heldOutNote,
  LOCAL_MODEL_RE,
  NIGHTLY_DEFAULT_REPEAT,
  NIGHTLY_MAX_REPEAT,
  nightVerdict,
  readBars,
  readGoldenSet,
  scoresByCase,
  validateNightlyState,
  type EvidenceCase,
  type NightlyState,
} from '../route/nightly.js';
import { defaultRunGolden, type RunGolden } from '../route/nightly-run.js';
import { checkAgentId } from '../result.js';
import { emptyRecheckState, recheck, triggersText, validateRecheckState, type Mark, type RecheckState } from '../route/recheck.js';

export type RouteExec = (cmd: string, args: string[], opts: { cwd: string }) => Promise<ExecResult>;

export interface RouteDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: Fetch;
  now?: () => number;
  /** Runs git and gh. Default: spawn without a shell, with the user's environment (gh needs its login). */
  exec?: RouteExec;
  /** The run path of `tma route nightly` (case folder, sandbox, upload). The tests pass a fake: no model call. */
  runGolden?: RunGolden;
}

const PR_USAGE = `usage: tma route pr (--route-file <route.json> | --route <id>) --targets <targets.json> --repo-dir <infra checkout> [--dry-run] [--base master]
  Applies an APPROVED route (tma-route/1 file or tma-route/2 API row) to ONE file of the infra checkout and opens the PR:
  env:<FLAG>      replaces the FLAG=<old> line and writes a "# route ..." + "# rollback: FLAG=<old>" block above it;
  claude-md:<row> replaces the model cell (**\`value\`**) of the one row that starts with row_prefix.
  Refuses (exit 2): state is not approved; n < 5; the verdict does not pass under the picked rule (absolute:
  same|close, relative: better|same); the use case has no target, or another target, in the map; the value
  is not allowed; the file value is not rollback_value (re-approve); nothing to change.
  --targets   a dfl-route-targets/1 file (dfl-evals routes/targets.json)
  --repo-dir  a clean checkout of the infra repo, on an up-to-date <base>; map paths are relative to it
  --route     read GET <api>/routes/<id> with your tma login (task T2). Before any git, it also reads
              GET <api>/routes?state=live and ?state=needs_check: when another route is applied on the same target,
              swap mode: gh pr create --draft, a "Swap pending" section in the PR body, then the same PATCH as
              tma route mark --state live (the API answers 202 swap_pending); a person approves or rejects the swap
              on S12, and only then is the PR made ready and merged.
  --route-file  offline: no API read, so no swap check (check the target yourself with tma route list)
  --dry-run   print the exact unified diff and the PR title and body; write nothing, run no git and no gh
              (in swap mode it also prints "swap mode: would open a DRAFT PR and register a pending swap ...")
  Without --dry-run: git checkout -b route/<use case>/<id8>, commit, git push -u origin, gh pr create.`;

const ROLLBACK_USAGE = `usage: tma route rollback (--route-file <route.json> | --route <id>) --targets <targets.json> --repo-dir <infra checkout> [--dry-run] [--base master]
  Writes rollback_value back for a LIVE (or needs_check) route and opens the PR. The route comment block
  becomes one line "# route <id> rolled back: <new> -> <old>". Refuses when rollback_value is null.`;

const MARK_USAGE = `usage: tma route mark --route <id> --state live|rolled_back --pr <PR URL>
       tma route mark --route <id> --state needs_check
  After the merge: PATCH <api>/routes/<id>/state with {state, pr_url} (task T2; 404 until T2 ships).
  live on a target that another route still holds: the API answers 202 swap_pending; the route waits until a
  person approves or rejects the swap on S12 (exit 0). Nothing changes live until then.
  needs_check (task T5): a trigger marks a live route for a check; the body is {state} only, so --pr is refused.
  The route keeps its value in the file; roll it back with tma route rollback, then mark rolled_back.`;

const LIST_USAGE = `usage: tma route list [--state <state>] [--use-case <type/subtype>] [--json]
  GET <api>/routes (newest first, at most 200) with your tma login. Every row is checked as a route row
  (tma-route/1 or tma-route/2); a row that fails stops the command (exit 1).
  Prints one line per route: id, use case, target, state, model (tab-separated); --json prints the JSON array.
  --state     one of ${ROUTE_STATES.join(', ')}`;

const RECHECK_USAGE = `usage: tma route recheck --observed <observation.json> --state <state.json> [--dry-run] [--json]
  Task T5 (daily): compares today's observation (tma-route-observation/1, written by a host collector) with the
  baseline stored per live route in --state, and with the agent each live route row names. Triggers: model_or_price
  (new model list or price digest), task_mix (the pair's 14-day share moved more than 10 points), grader_version
  (a grader of the pair's profile changed, came or went), agent_change (harness commit, rules or skills digest).
  The first sight of a route records its baseline (only agent_change runs). Each triggered route gets
  PATCH <api>/routes/<id>/state {state: needs_check} and one line; a route value or file is never changed.
  --state     the baseline file (tma-route-recheck-state/1); absent = empty; written atomically, also in --dry-run
  --dry-run   send no PATCH; print "would mark (dry run)"
  --json      print {marks, refused} instead of lines
  Exit: 0 ok, 2 usage or invalid input (the state file stays as it was), 3 the API refused at least one mark, 1 other.`;

const BUDGET_USAGE = `usage: tma route budget --tiers <tiers.json> [--plan <n>] [--json]
  Task T6 (ADR-7): counts the PAID runs in GET <api>/eval-runs with your tma login. A run is paid unless its model is a
  local route (ollama/, local/), a fleet Claude model, or listed with tier local in the tiers file (tma-model-tiers/1);
  a model that the file does not list counts as paid and is reported as unlisted.
  Caps: total 200 (hard; TMA_BUDGET_TOTAL can only lower it), night 10 (last 24 h, TMA_BUDGET_NIGHT), month 60 (UTC
  calendar month, TMA_BUDGET_MONTH). --plan n = paid runs about to start: exit 2 and "refused: ..." when the budget
  would be passed (exactly at a cap is allowed). Without --plan: exit 0.
  The API caps the list at 500 rows: a truncated answer is refused (exit 1), because the count would be too low.`;

const NIGHTLY_USAGE = `usage: tma route nightly --golden-dir <dfl-evals checkout> --tiers <tiers.json> --agent-dir <dir> --work-dir <dir> --state <state.json>
                         [--agent <tma agent id>] [--task-dir <dir>] [--repeat 1-10] [--dry-run] [--skip-local] [--json]
  Task T6 (nightly, ADR-2, ADR-7): for each LIVE route, run the golden set of its use case with the routed model
  (sets/golden/<type>/<subtype>.jsonl, tma-golden-row/1 rows; cases/<type>/<subtype>/<case_key>/case.json, split golden)
  --repeat times (default ${NIGHTLY_DEFAULT_REPEAT}), upload the runs (TMA run rows) and compare with the cited verdict. A drop
  (absolute: the label is not SAME or CLOSE; relative: worse against the baseline of the first night) gets
  PATCH <api>/routes/<id>/state {state: needs_check}. A route value or file is never changed.
  A route is skipped (one line, exit 0) when: no_golden_set; golden_draft (a draft row refuses the set);
  golden_case_invalid; golden_not_held_out (a golden case shares a case_key, a pin or a task with an evidence case of
  the route); held_out_unprovable (an evidence run or case is not readable); local_model_host_down (--skip-local and
  an ollama/ or local/ model); budget_refused (the paid runs of GET /eval-runs + unuploaded_paid_runs of the state +
  the routes planned before it tonight + this route would pass a cap; see tma route budget; exit 2 at the end).
  --agent     the TMA agent id of the upload (tma eval upload --agent); required unless --dry-run
  --task-dir  the task bundle of the golden cases (tma eval case --task-dir)
  --state     tma-route-nightly-state/1; absent = empty; written atomically, also in --dry-run and after a refusal
  --dry-run   run nothing, upload nothing, send no PATCH; print the decision per route
  Output: one line per route, then: nightly status=ok|refused|error routes=<live> ran=<n> dropped=<n> marked=<n>
  skipped=<n> paid_planned=<n> paid_total=<n>/<cap>.
  Exit: 0 ok, 2 usage, invalid input or a route refused by the budget, 3 the API refused a mark or an upload, 1 other.`;

const USAGE = [
  'usage: tma route <pr|rollback|mark|list|recheck|budget|nightly> ...   (apply an approved model route by a PR: plan C8)', '', PR_USAGE, '', ROLLBACK_USAGE, '', MARK_USAGE, '', LIST_USAGE, '', RECHECK_USAGE, '', BUDGET_USAGE, '', NIGHTLY_USAGE,
].join('\n');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USE_CASE_RE = /^[a-z0-9][a-z0-9_-]{0,31}\/[a-z0-9][a-z0-9_-]{0,31}$/;
const PR_RE = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}\/pull\/[0-9]{1,9}$/;

function checkRouteRow(value: unknown, label: string): Route {
  const r = validateRoute(value);
  if (!r.ok) throw new RouteRefusal(`${label} is not a valid route row (tma-route/1 or tma-route/2): ${r.errors.slice(0, 3).join('; ')}`);
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

/** The applied route (live or needs_check) on the route's target, other than the route itself; null when free. */
async function appliedOnTarget(deps: RouteDeps, io: Io, route: Route): Promise<Route | null | 'failed'> {
  for (const state of ['live', 'needs_check'] as const) {
    const rows = await fetchRoutes(deps, io, 'pr', { state });
    if (rows === null) return 'failed';
    const hit = rows.find((r) => r.id !== route.id && r.route_target === route.route_target);
    if (hit) return hit;
  }
  return null;
}

function swapSection(old: Route): string {
  return `\n\n## Swap pending\n\nSwap pending: route ${old.id} is applied on this target. Do not merge until a person approves the swap on S12.`;
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
  let body = prBody(edit);
  const diff = unifiedDiff(target.file, edit.before, edit.after);
  // Swap mode (Q d881e5df = C): API mode only, before any git. --route-file stays offline.
  let swapWith: Route | null = null;
  if (action === 'pr' && flag(a, 'route') !== undefined) {
    const applied = await appliedOnTarget(deps, io, route);
    if (applied === 'failed') return 1;
    swapWith = applied;
    if (swapWith) body += swapSection(swapWith);
  }

  if (has(a, 'dry-run')) {
    io.err(`dry run: tma route ${action} writes nothing and runs no git and no gh`);
    io.out(diff);
    io.out('');
    io.out(`branch: ${branchName(edit)}`);
    io.out(`PR title: ${title}`);
    io.out('PR body:');
    io.out(body);
    if (swapWith) io.out(`swap mode: would open a DRAFT PR and register a pending swap with route ${swapWith.id}`);
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
  const ghArgs = ['pr', 'create', ...(swapWith ? ['--draft'] : []), '--base', base, '--head', branch, '--title', title, '--body', body];
  const out = await run(exec, repoDir, 'gh', ghArgs);
  const url = out.trim().split('\n').reverse().find((l) => /^https:\/\//.test(l.trim()))?.trim() ?? out.trim();
  io.out(url);
  if (swapWith) {
    if (!PR_RE.test(url)) throw new CliError(`gh pr create did not print a pull request URL; register the swap with tma route mark --route ${route.id} --state live --pr <URL>`);
    const code = await markRoute(deps, io, route.id, 'live', url);
    io.err(`next: a person approves or rejects the swap on S12; after an approve, mark the draft PR ready, merge it and install`);
    return code;
  }
  io.err(`next (after the merge and the apply): tma route mark --route ${route.id} --state ${action === 'pr' ? 'live' : 'rolled_back'} --pr ${url}`);
  return 0;
}

async function markMain(argv: string[], io: Io, deps: RouteDeps): Promise<number> {
  const a = parseArgs(argv, { route: {}, state: {}, pr: {} });
  const id = required(a, 'route', MARK_USAGE);
  const state = required(a, 'state', MARK_USAGE);
  if (!UUID_RE.test(id)) throw new CliError(`not a route id: ${id.slice(0, 60)}`);
  if (state !== 'live' && state !== 'rolled_back' && state !== 'needs_check') {
    throw new CliError(`--state must be live, rolled_back or needs_check\n${MARK_USAGE}`);
  }
  let pr: string | null = null;
  if (state === 'needs_check') {
    // ADR-7: a trigger marks the route; the mark carries no PR (the API refuses a pr_url key).
    if (has(a, 'pr')) throw new CliError(`--state needs_check takes no --pr (the route is marked, not changed)\n${MARK_USAGE}`);
  } else {
    pr = required(a, 'pr', MARK_USAGE);
    if (!PR_RE.test(pr)) throw new CliError(`--pr must be a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<n>)`);
  }
  return markRoute(deps, io, id, state, pr);
}

/** PATCH /routes/:id/state and print the outcome: the one mark of `tma route mark` and of `tma route pr` in swap mode. */
async function markRoute(deps: RouteDeps, io: Io, id: string, state: string, pr: string | null): Promise<number> {
  const body = pr === null ? { state } : { state, pr_url: pr };
  const r = await patchRouteState(deps, id, body);
  if (r.status === 404) {
    io.err(`tma route mark: 404 from PATCH /routes/${id}/state: the route is not found, or the API does not have this endpoint yet (task T2 of plan 20261112-tma-c8-routing-from-evals). Nothing was changed.`);
    return 1;
  }
  if (r.status === 202 && r.body?.status === 'swap_pending') {
    const word = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : '?');
    const old = word(r.body.live_route_id, UUID_RE);
    const oldState = word(r.body.live_route_state, /^[a-z_]{1,20}$/);
    const target = word((r.body.route as { route_target?: unknown } | null | undefined)?.route_target, /^[A-Za-z0-9:_-]{1,80}$/);
    io.out(`route ${id}: swap pending — route ${old} (${oldState}) stays applied on ${target}; a person approves or rejects the swap on S12`);
    return 0;
  }
  if (r.status < 200 || r.status >= 300) throw new CliError(`cannot set the route state: ${describeRefusal(r)}`);
  io.out(pr === null ? `route ${id} -> ${state}` : `route ${id} -> ${state} (${pr})`);
  return 0;
}

/** PATCH /routes/:id/state: the one call of `tma route mark` and of `tma route recheck`. */
async function patchRouteState(deps: RouteDeps, id: string, body: { state: string; pr_url?: string }): Promise<ApiAnswer> {
  const { base, token } = session(deps);
  return apiCall(base, `/routes/${id}/state`, { method: 'PATCH', body, token, fetchImpl: deps.fetchImpl });
}

/**
 * GET /routes with the filters, every row through validateRoute: the one read of `tma route list` and of
 * `tma route recheck`. Returns null after it printed why (exit 1).
 */
async function fetchRoutes(deps: RouteDeps, io: Io, cmd: string, filters: { state?: string; useCase?: string }): Promise<Route[] | null> {
  const query = new URLSearchParams();
  if (filters.useCase !== undefined) query.set('use_case', filters.useCase);
  if (filters.state !== undefined) query.set('state', filters.state);
  const qs = query.toString();
  const { base, token } = session(deps);
  const r = await apiCall(base, `/routes${qs ? `?${qs}` : ''}`, { token, fetchImpl: deps.fetchImpl });
  if (r.status !== 200) throw new CliError(`cannot list the routes: ${describeRefusal(r)}`);
  const rows = r.body?.routes;
  if (!Array.isArray(rows)) {
    io.err(`tma route ${cmd}: the API answer has no routes array`);
    return null;
  }
  const routes: Route[] = [];
  for (const [i, row] of rows.entries()) {
    const v = validateRoute(row);
    if (!v.ok) {
      const id = row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string' ? (row as { id: string }).id.slice(0, 60) : `#${i}`;
      io.err(`tma route ${cmd}: route ${id} is not a valid route row (tma-route/1 or tma-route/2): ${v.errors.slice(0, 3).join('; ')}`);
      return null;
    }
    routes.push(v.value);
  }
  return routes;
}

async function listMain(argv: string[], io: Io, deps: RouteDeps): Promise<number> {
  const a = parseArgs(argv, { state: {}, 'use-case': {}, json: { boolean: true } });
  if (a.positionals.length) throw new CliError(`unexpected argument: ${a.positionals[0]!.slice(0, 60)}\n${LIST_USAGE}`);
  const state = flag(a, 'state');
  const useCase = flag(a, 'use-case');
  if (state !== undefined && !(ROUTE_STATES as readonly string[]).includes(state)) {
    throw new CliError(`--state must be one of ${ROUTE_STATES.join(', ')}\n${LIST_USAGE}`);
  }
  if (useCase !== undefined && !USE_CASE_RE.test(useCase)) throw new CliError(`--use-case must be one L1 pair type/subtype\n${LIST_USAGE}`);
  const routes = await fetchRoutes(deps, io, 'list', { state, useCase });
  if (routes === null) return 1;
  if (has(a, 'json')) {
    io.out(JSON.stringify(routes, null, 2));
    return 0;
  }
  for (const x of routes) io.out([x.id, x.use_case_key, x.route_target, x.state, x.model_id].join('\t'));
  return 0;
}

/** Write a file atomically: a temp file in the same directory, then rename over the target. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, text, { encoding: 'utf-8', mode: 0o644 });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new CliError(`cannot write ${path} (${e instanceof Error ? e.message.slice(0, 120) : 'error'})`);
  }
}

async function readState(path: string): Promise<RecheckState> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyRecheckState();
    throw new RouteRefusal(`cannot read the state file ${path}`);
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new RouteRefusal(`the state file ${path} is not JSON (it is left as it is)`);
  }
  const r = validateRecheckState(v);
  if (!r.ok) throw new RouteRefusal(`the state file ${path} is not a tma-route-recheck-state/1 file: ${r.error} (it is left as it is)`);
  return r.value;
}

interface Refused {
  route_id: string;
  use_case_key: string;
  status: number;
  error: string;
}

async function recheckMain(argv: string[], io: Io, deps: RouteDeps): Promise<number> {
  let a: ReturnType<typeof parseArgs>;
  try {
    a = parseArgs(argv, { observed: {}, state: {}, 'dry-run': { boolean: true }, json: { boolean: true } });
  } catch (e) {
    throw new RouteRefusal(`${e instanceof Error ? e.message : 'bad arguments'}\n${RECHECK_USAGE}`);
  }
  if (a.positionals.length) throw new RouteRefusal(`unexpected argument: ${a.positionals[0]!.slice(0, 60)}\n${RECHECK_USAGE}`);
  const observedFile = flag(a, 'observed');
  const stateFile = flag(a, 'state');
  if (!observedFile || !stateFile) throw new RouteRefusal(`--observed and --state are required\n${RECHECK_USAGE}`);
  const dryRun = has(a, 'dry-run');
  const json = has(a, 'json');

  const obsText = await readFile(resolve(observedFile), 'utf-8').catch(() => null);
  if (obsText === null) throw new RouteRefusal(`cannot read ${observedFile}`);
  const parsed = parseRouteObservationText(obsText);
  if (!parsed.ok) throw new RouteRefusal(`${observedFile} is not a valid tma-route-observation/1 file: ${parsed.errors.slice(0, 3).join('; ')}`);
  const statePath = resolve(stateFile);
  const state = await readState(statePath);

  const live = await fetchRoutes(deps, io, 'recheck', { state: 'live' });
  if (live === null) return 1;
  const result = recheck(live, parsed.value, state);

  const marked: Mark[] = [];
  const refused: Refused[] = [];
  const lines: string[] = [];
  try {
    for (const check of result.checks) {
      const notes = check.notes.length ? ` [${check.notes.join('; ')}]` : '';
      const head = `route ${check.route_id} ${check.use_case_key}:`;
      if (check.triggers.length === 0) {
        lines.push(`${head} ok${notes}`);
        continue;
      }
      const what = `${head} needs_check (${triggersText(check.triggers)})`;
      const mark: Mark = { route_id: check.route_id, use_case_key: check.use_case_key, triggers: check.triggers };
      if (dryRun) {
        marked.push(mark);
        lines.push(`${what} would mark (dry run)${notes}`);
        continue;
      }
      const r = await patchRouteState(deps, check.route_id, { state: 'needs_check' });
      if (r.status >= 200 && r.status < 300) {
        marked.push(mark);
        lines.push(`${what} marked${notes}`);
      } else {
        const code = typeof r.body?.error === 'string' && /^[a-z0-9_]{1,64}$/.test(r.body.error) ? r.body.error : 'error';
        refused.push({ route_id: check.route_id, use_case_key: check.use_case_key, status: r.status, error: code });
        lines.push(`${what} NOT marked: ${r.status} ${code}${notes}`);
      }
    }
  } finally {
    // The baselines are facts about the observation, not about the API: write them also in a dry run and after a refusal.
    await writeAtomic(statePath, `${JSON.stringify(result.nextState, null, 2)}\n`);
  }

  if (json) io.out(JSON.stringify({ dry_run: dryRun, marks: marked, refused }, null, 2));
  else for (const l of lines) io.out(l);
  if (dryRun) io.err('dry run: tma route recheck sent no PATCH; the state file is written');
  return refused.length ? 3 : 0;
}

async function readNightlyState(path: string): Promise<NightlyState> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyNightlyState();
    throw new RouteRefusal(`cannot read the state file ${path}`);
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new RouteRefusal(`the state file ${path} is not JSON (it is left as it is)`);
  }
  const r = validateNightlyState(v);
  if (!r.ok) throw new RouteRefusal(`the state file ${path} is not a tma-route-nightly-state/1 file: ${r.error} (it is left as it is)`);
  return r.value;
}

/** GET /eval-cases once: the cases of the evidence runs. null = not readable (the held-out proof fails closed). */
async function fetchEvidenceCases(deps: RouteDeps): Promise<EvidenceCase[] | null> {
  const { base, token } = session(deps);
  const r = await apiCall(base, '/eval-cases', { token, fetchImpl: deps.fetchImpl });
  if (r.status !== 200 || !Array.isArray(r.body?.cases)) return null;
  const out: EvidenceCase[] = [];
  for (const c of r.body.cases as unknown[]) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.caseKey !== 'string') continue;
    out.push({
      id: o.id,
      caseKey: o.caseKey,
      originPinSha256: typeof o.originPinSha256 === 'string' ? o.originPinSha256 : null,
      taskSlug: typeof o.taskSlug === 'string' ? o.taskSlug : null,
    });
  }
  return out;
}

interface NightlyLine {
  route_id: string;
  use_case_key: string;
  outcome: 'skipped' | 'planned' | 'ok' | 'baseline_recorded' | 'no_verdict' | 'dropped' | 'error';
  note: string;
  marked: boolean;
  /** A drop the API did not mark: "<status> <code>". */
  refusal?: string;
}

async function nightlyMain(argv: string[], io: Io, deps: RouteDeps): Promise<number> {
  let a: ReturnType<typeof parseArgs>;
  try {
    a = parseArgs(argv, {
      'golden-dir': {}, tiers: {}, 'agent-dir': {}, 'work-dir': {}, state: {}, 'task-dir': {}, agent: {}, repeat: {},
      'dry-run': { boolean: true }, 'skip-local': { boolean: true }, json: { boolean: true },
    });
  } catch (e) {
    throw new RouteRefusal(`${e instanceof Error ? e.message : 'bad arguments'}\n${NIGHTLY_USAGE}`);
  }
  if (a.positionals.length) throw new RouteRefusal(`unexpected argument: ${a.positionals[0]!.slice(0, 60)}\n${NIGHTLY_USAGE}`);
  const need = (k: string) => {
    const v = flag(a, k);
    if (!v) throw new RouteRefusal(`--${k} is required\n${NIGHTLY_USAGE}`);
    return v;
  };
  const goldenDir = resolve(need('golden-dir'));
  const tiersFile = need('tiers');
  const agentDir = resolve(need('agent-dir'));
  const workDir = resolve(need('work-dir'));
  const statePath = resolve(need('state'));
  const taskDir = flag(a, 'task-dir') ? resolve(flag(a, 'task-dir')!) : undefined;
  const dryRun = has(a, 'dry-run');
  const skipLocal = has(a, 'skip-local');
  const json = has(a, 'json');
  let repeat = NIGHTLY_DEFAULT_REPEAT;
  try {
    repeat = numberFlag(a, 'repeat', { min: 1, max: NIGHTLY_MAX_REPEAT, integer: true }) ?? NIGHTLY_DEFAULT_REPEAT;
  } catch (e) {
    throw new RouteRefusal(e instanceof Error ? e.message : 'bad --repeat');
  }
  let agentId: string | null = null;
  if (flag(a, 'agent') !== undefined) {
    try {
      agentId = checkAgentId(flag(a, 'agent')!);
    } catch (e) {
      throw new RouteRefusal(e instanceof Error ? e.message : 'bad --agent');
    }
  } else if (!dryRun) throw new RouteRefusal(`--agent is required (the TMA agent of the upload) unless --dry-run\n${NIGHTLY_USAGE}`);
  const tiersText = await readFile(resolve(tiersFile), 'utf-8').catch(() => null);
  if (tiersText === null) throw new RouteRefusal(`cannot read ${tiersFile}`);
  let tiers: Tiers;
  try {
    tiers = parseTiers(tiersText);
  } catch (e) {
    throw new RouteRefusal(e instanceof Error ? e.message : 'bad tiers file');
  }
  const caps = capsFromEnv(deps.env ?? process.env);
  const state = await readNightlyState(statePath);
  const startUnuploaded = state.unuploaded_paid_runs;
  const next: NightlyState = { format: state.format, routes: { ...state.routes }, unuploaded_paid_runs: state.unuploaded_paid_runs };
  const nowMs = (deps.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  const stamp = nowIso.replace(/[-:]/g, '').replace(/\.\d+/, '');
  const runGolden = deps.runGolden ?? defaultRunGolden;

  const lines: NightlyLine[] = [];
  let liveCount = 0;
  let paidPlanned = 0;
  let paidTotalBase = 0;
  let budgetRefused = false;
  let apiRefused = false;
  let otherError = false;
  try {
    const live = await fetchRoutes(deps, io, 'nightly', { state: 'live' });
    if (live === null) return 1;
    liveCount = live.length;
    // The baselines of routes that are no longer live are dropped (as tma route recheck does).
    next.routes = {};
    for (const r of live) if (Object.prototype.hasOwnProperty.call(state.routes, r.id)) next.routes[r.id] = { ...state.routes[r.id]! };
    const { base, token } = session(deps);
    // ONE read of the run rows: the budget counter and the held-out proof read the same rows.
    const rows = await fetchRunRows({ base, token, fetchImpl: deps.fetchImpl });
    const counts = countPaidRuns(rows, tiers, nowMs);
    paidTotalBase = counts.paid_total + startUnuploaded;
    let evidenceCases: EvidenceCase[] | null | undefined;

    for (const route of live) {
      const line = (outcome: NightlyLine['outcome'], note: string, marked = false) =>
        lines.push({ route_id: route.id, use_case_key: route.use_case_key, outcome, note, marked });
      // 1. golden set
      const golden = await readGoldenSet(goldenDir, route.use_case_key);
      if (!golden.ok) {
        line('skipped', golden.note);
        continue;
      }
      const bars = await readBars(goldenDir, route.use_case_key);
      if (!bars.ok) {
        line('skipped', bars.note);
        continue;
      }
      // 2. held-out proof
      if (evidenceCases === undefined) evidenceCases = await fetchEvidenceCases(deps);
      const held = heldOutNote(route, golden.cases, rows, evidenceCases);
      if (held !== null) {
        line('skipped', held);
        continue;
      }
      // 3. local model
      if (skipLocal && LOCAL_MODEL_RE.test(route.model_id)) {
        line('skipped', 'local_model_host_down');
        continue;
      }
      // 4. budget
      const paid = isPaidModel(route.model_id, tiers);
      const planned = paid ? golden.cases.length * repeat : 0;
      const have = {
        ...counts,
        paid_total: counts.paid_total + startUnuploaded + paidPlanned,
        paid_night: counts.paid_night + paidPlanned,
        paid_month: counts.paid_month + startUnuploaded + paidPlanned,
      };
      // A free route plans no paid run: the caps never refuse it, even when the paid count is already over a cap.
      const verdict = planned > 0 ? checkBudget({ counts: have, planned, caps }) : { ok: true, reasons: [] };
      if (!verdict.ok) {
        budgetRefused = true;
        line('skipped', `budget_refused: ${verdict.reasons.join('; ')}`);
        continue;
      }
      paidPlanned += planned;
      if (dryRun) {
        line('planned', `would run ${golden.cases.length} case(s) x ${repeat} (paid ${planned}) (dry run)`);
        continue;
      }
      // 5. run
      let result;
      try {
        result = await runGolden({
          route, cases: golden.cases, repeat, routeDir: join(workDir, route.id.slice(0, 8), stamp), agentDir, taskDir,
          agentId: agentId!, base, token, env: deps.env ?? process.env, fetchImpl: deps.fetchImpl, log: (l) => io.err(l),
        });
      } catch (e) {
        // Unknown how many runs started: fail closed, count every planned paid run as not uploaded.
        next.unuploaded_paid_runs += planned;
        otherError = true;
        line('error', `run_error: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 160)}`);
        continue;
      }
      if (paid) next.unuploaded_paid_runs += result.unuploadedRuns;
      if (result.uploadFailed) apiRefused = true;
      const prev = next.routes[route.id] ?? { baseline: null, last_run_at: null, last_label: null, last_scores: null };
      const scores = scoresByCase(result.runs);
      const upNote = result.uploadFailed ? `; upload_failed: ${result.unuploadedRuns} run(s) not uploaded` : '';
      if (result.errors.length) {
        otherError = true;
        next.routes[route.id] = { ...prev, last_run_at: nowIso, last_label: null, last_scores: scores };
        line('error', `run_error: ${result.errors.slice(0, 3).join('; ')}${upNote}`);
        continue;
      }
      // 6. verdict
      const v = nightVerdict(route, result.runs, bars.bars, route.picked_rule === 'relative' ? prev.baseline : null);
      next.routes[route.id] = {
        baseline: v.kind === 'baseline' ? v.baseline : prev.baseline,
        last_run_at: nowIso,
        last_label: v.label,
        last_scores: scores,
      };
      if (v.kind === 'refused') {
        line('no_verdict', `${v.note}${upNote}`);
        continue;
      }
      if (v.kind === 'baseline') {
        const n = Object.values(v.baseline).reduce((s, x) => s + x.length, 0);
        line('baseline_recorded', `relative baseline recorded, n=${n}${upNote}`);
        continue;
      }
      const what = `${route.picked_rule} ${v.label} tonight, cited ${route.verdict}`;
      const extra = v.notes.length ? `; ${v.notes.join('; ')}` : '';
      if (!v.drop) {
        line('ok', `${what}${extra}${upNote}`);
        continue;
      }
      // 7. mark
      const r = await patchRouteState(deps, route.id, { state: 'needs_check' });
      if (r.status >= 200 && r.status < 300) line('dropped', `nightly_drop: ${what}${extra}${upNote}`, true);
      else {
        apiRefused = true;
        const code = typeof r.body?.error === 'string' && /^[a-z0-9_]{1,64}$/.test(r.body.error) ? r.body.error : 'error';
        lines.push({ route_id: route.id, use_case_key: route.use_case_key, outcome: 'dropped', note: `nightly_drop: ${what}${extra}${upNote}`, marked: false, refusal: `${r.status} ${code}` });
      }
    }
  } finally {
    // Write the state also in a dry run and after a refusal: the unuploaded paid runs must never be lost.
    await writeAtomic(statePath, `${JSON.stringify(next, null, 2)}\n`);
  }

  // ran = the routes whose golden set ran tonight (every outcome after step 5).
  const ran = lines.filter((l) => l.outcome !== 'skipped' && l.outcome !== 'planned').length;
  const dropped = lines.filter((l) => l.outcome === 'dropped').length;
  const marked = lines.filter((l) => l.marked).length;
  const skipped = lines.filter((l) => l.outcome === 'skipped').length;
  const status = apiRefused || otherError ? 'error' : budgetRefused ? 'refused' : 'ok';
  const summary = `nightly status=${status} routes=${liveCount} ran=${ran} dropped=${dropped} marked=${marked} skipped=${skipped} paid_planned=${paidPlanned} paid_total=${paidTotalBase + paidPlanned}/${caps.total}`;
  const text = (l: NightlyLine) => {
    const head = `route ${l.route_id} ${l.use_case_key}:`;
    switch (l.outcome) {
      case 'dropped':
        return `${head} needs_check (${l.note}) ${l.marked ? 'marked' : `NOT marked: ${l.refusal ?? 'error'}`}`;
      case 'skipped':
        return `${head} skipped (${l.note})`;
      case 'planned':
        return `${head} ${l.note}`;
      case 'ok':
        return `${head} ok (${l.note})`;
      case 'baseline_recorded':
        return `${head} baseline_recorded (${l.note})`;
      case 'no_verdict':
        return `${head} no verdict (${l.note})`;
      default:
        return `${head} error (${l.note})`;
    }
  };
  if (json) io.out(JSON.stringify({ dry_run: dryRun, routes: lines, summary }, null, 2));
  else {
    for (const l of lines) io.out(text(l));
    io.out(summary);
  }
  if (dryRun) io.err('dry run: tma route nightly ran nothing, uploaded nothing and sent no PATCH; the state file is written');
  if (apiRefused) return 3;
  if (otherError) return 1;
  if (budgetRefused) return 2;
  return 0;
}

async function budgetMain(argv: string[], io: Io, deps: RouteDeps): Promise<number> {
  const a = parseArgs(argv, { tiers: {}, plan: {}, json: { boolean: true } });
  if (a.positionals.length) throw new CliError(`unexpected argument: ${a.positionals[0]!.slice(0, 60)}\n${BUDGET_USAGE}`);
  const tiersFile = required(a, 'tiers', BUDGET_USAGE);
  const planned = numberFlag(a, 'plan', { min: 0, max: 100000, integer: true });
  const tiers = parseTiers(await readText(resolve(tiersFile)));
  const caps = capsFromEnv(deps.env ?? process.env);
  const { base, token } = session(deps);
  const rows = await fetchRunRows({ base, token, fetchImpl: deps.fetchImpl });
  const counts = countPaidRuns(rows, tiers, (deps.now ?? Date.now)());
  const verdict = planned === undefined ? null : checkBudget({ counts, planned, caps });
  if (has(a, 'json')) {
    io.out(JSON.stringify({ ...counts, caps, planned: planned ?? null, ok: verdict ? verdict.ok : true, reasons: verdict ? verdict.reasons : [] }, null, 2));
  } else {
    io.out(`paid_total\t${counts.paid_total}\tcap ${caps.total}`);
    io.out(`paid_night\t${counts.paid_night}\tcap ${caps.night}`);
    io.out(`paid_month\t${counts.paid_month}\tcap ${caps.month}`);
    io.out(`total_runs\t${counts.total_runs}`);
    io.out(`unlisted\t${counts.unlisted.length ? counts.unlisted.join(', ') : '-'}`);
  }
  if (verdict && !verdict.ok) {
    io.err(`refused: ${verdict.reasons.join('; ')}`);
    return 2;
  }
  return 0;
}

export function makeRouteCommand(deps: RouteDeps = {}): Command {
  return {
    name: 'route',
    summary: 'Apply an approved model route by a PR (pr), roll it back by a PR (rollback), record the state (mark), list routes (list), mark live routes needs_check on a trigger (recheck), count paid runs against the budget (budget), run the nightly regression of the live routes (nightly)',
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
          case 'list':
            return await listMain(rest, io, deps);
          case 'recheck':
            return await recheckMain(rest, io, deps);
          case 'budget':
            return await budgetMain(rest, io, deps);
          case 'nightly':
            return await nightlyMain(rest, io, deps);
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

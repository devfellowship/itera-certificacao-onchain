// The apply path of an approved model route (plan 20261112-tma-c8-routing-from-evals, T4, ADR-1, ADR-2):
// read the flag map (dfl-route-targets/1), check the route against the map and the file, and compute the
// new text of ONE file in the infra checkout. Pure functions: no git, no network, no write. The command
// in ../commands/route.ts prints the diff (--dry-run) or writes the file and opens the PR.
//
// Two target kinds:
//   env:<FLAG>        one `FLAG=value` line of a .env file, with a `# route ... / # rollback:` comment block
//                     right above it (the old value stays in the file as the rollback line);
//   claude-md:<row>   the model cell (**`value`**) of the one table row that starts with `row_prefix`.
import { isAbsolute, normalize } from 'node:path';
import { ROUTE_MIN_N, routeVerdictPasses, type Route } from '@itera/contracts';

export const TARGETS_FORMAT = 'dfl-route-targets/1';

/** A refusal of `tma route`: the CLI prints one line and exits 2. */
export class RouteRefusal extends Error {}

export interface RouteTarget {
  use_case: string;
  target: string;
  file: string;
  values: string[];
  default: string;
  row_prefix?: string;
  consumers: string[];
  note: string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,99}$/;

/** Parse a dfl-route-targets/1 file. Refuses (exit 2) a map that the apply path cannot use safely. */
export function parseTargets(text: string, label: string): RouteTarget[] {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new RouteRefusal(`${label} is not JSON`);
  }
  const m = v as { schema?: unknown; targets?: unknown };
  if (!m || typeof m !== 'object' || m.schema !== TARGETS_FORMAT || !Array.isArray(m.targets)) {
    throw new RouteRefusal(`${label} is not a ${TARGETS_FORMAT} file ({schema, targets:[...]})`);
  }
  return m.targets.map((t: unknown, i: number) => {
    const x = t as Partial<RouteTarget>;
    const at = `${label} targets[${i}]`;
    if (!x || !isStr(x.use_case) || !isStr(x.target) || !isStr(x.file) || !Array.isArray(x.values) || x.values.length === 0) {
      throw new RouteRefusal(`${at} needs use_case, target, file and values[]`);
    }
    if (!x.values.every((s) => typeof s === 'string' && VALUE_RE.test(s))) throw new RouteRefusal(`${at}: a value is not a plain token`);
    if (!/^(env:[A-Z][A-Z0-9_]{0,63}|claude-md:[a-z0-9][a-z0-9_-]{0,63})$/.test(x.target)) throw new RouteRefusal(`${at}: target must be env:<FLAG> or claude-md:<row>`);
    if (x.target.startsWith('claude-md:') && !isStr(x.row_prefix)) throw new RouteRefusal(`${at}: a claude-md target needs row_prefix`);
    if (isAbsolute(x.file) || normalize(x.file).split(/[\\/]/).includes('..')) throw new RouteRefusal(`${at}: file must be a path inside the infra repo (${x.file})`);
    return {
      use_case: x.use_case,
      target: x.target,
      file: normalize(x.file),
      values: x.values,
      default: typeof x.default === 'string' ? x.default : '',
      row_prefix: x.row_prefix,
      consumers: Array.isArray(x.consumers) ? x.consumers : [],
      note: typeof x.note === 'string' ? x.note : '',
    };
  });
}

export type RouteAction = 'pr' | 'rollback';

/** The plan of one file edit. */
export interface RouteEdit {
  action: RouteAction;
  route: Route;
  target: RouteTarget;
  /** FLAG for env, the row key for claude-md. */
  label: string;
  oldValue: string;
  newValue: string;
  before: string;
  after: string;
}

/** The first 8 characters of the route id. */
export const id8 = (r: Route) => r.id.slice(0, 8);

/** The checks of the route row and the map that do not need the file. Returns the map entry. */
export function checkRoute(action: RouteAction, route: Route, targets: RouteTarget[]): RouteTarget {
  if (action === 'pr') {
    if (route.state !== 'approved') throw new RouteRefusal(`route ${route.id} is ${route.state}, not approved: only an approved route is applied`);
    if (route.n < ROUTE_MIN_N) throw new RouteRefusal(`route ${route.id} has n=${route.n}; a route needs n >= ${ROUTE_MIN_N} runs per cell`);
    if (!routeVerdictPasses(route.picked_rule, route.verdict)) {
      const ok = route.picked_rule === 'absolute' ? 'same or close' : 'better or same';
      throw new RouteRefusal(`route ${route.id}: verdict "${route.verdict}" does not pass under the ${route.picked_rule} rule (needs ${ok})`);
    }
  } else if (route.state !== 'live' && route.state !== 'needs_check') {
    throw new RouteRefusal(`route ${route.id} is ${route.state}: only a live or needs_check route is rolled back`);
  }
  const forUseCase = targets.filter((t) => t.use_case === route.use_case_key);
  if (forUseCase.length === 0) throw new RouteRefusal(`use case ${route.use_case_key} has no target in the flag map`);
  const target = forUseCase.find((t) => t.target === route.route_target);
  if (!target) throw new RouteRefusal(`route_target ${route.route_target} differs from the map target of ${route.use_case_key} (${forUseCase.map((t) => t.target).join(', ')})`);
  if (!target.values.includes(route.target_value)) throw new RouteRefusal(`target_value ${route.target_value} is not an allowed value of ${target.target} (${target.values.join('|')})`);
  if (action === 'rollback') {
    if (route.rollback_value === null) throw new RouteRefusal(`route ${route.id} has no rollback_value: there is no old value to restore`);
    if (!target.values.includes(route.rollback_value)) throw new RouteRefusal(`rollback_value ${route.rollback_value} is not an allowed value of ${target.target} (${target.values.join('|')})`);
  }
  return target;
}

// ---------------------------------------------------------------- env target

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Is this line part of a route comment block of this flag (pr block or rolled-back line)? */
function isRouteBlockLine(line: string, flag: string): boolean {
  return /^# route [0-9a-f-]{36}( \(| rolled back: )/.test(line) || new RegExp(`^# rollback: ${escapeRe(flag)}=`).test(line);
}

interface EnvSplit {
  lines: string[];
  /** Index of the FLAG= line. */
  at: number;
  /** Index of the first line of the route block right above it (= at when none). */
  blockStart: number;
  current: string;
}

function splitEnv(text: string, flag: string, file: string): EnvSplit {
  const lines = text.split('\n');
  const hits = lines.flatMap((l, i) => (l.startsWith(`${flag}=`) ? [i] : []));
  if (hits.length !== 1) throw new RouteRefusal(`${file} has ${hits.length} lines ${flag}=...; the apply path needs exactly one`);
  const at = hits[0]!;
  let blockStart = at;
  while (blockStart > 0 && isRouteBlockLine(lines[blockStart - 1]!, flag)) blockStart--;
  return { lines, at, blockStart, current: lines[at]!.slice(flag.length + 1).trim() };
}

// ---------------------------------------------------------- claude-md target

const CELL_RE = /\*\*`([^`\n]+)`\*\*/g;

function findRow(text: string, prefix: string, file: string): { lines: string[]; at: number; current: string; cellIndex: number } {
  const lines = text.split('\n');
  const hits = lines.flatMap((l, i) => (l.startsWith(prefix) ? [i] : []));
  if (hits.length !== 1) throw new RouteRefusal(`${file} has ${hits.length} rows that start with "${prefix}"; the apply path needs exactly one`);
  const at = hits[0]!;
  const rest = lines[at]!.slice(prefix.length);
  const cells = [...rest.matchAll(CELL_RE)];
  if (cells.length !== 1) throw new RouteRefusal(`${file} line ${at + 1}: the row has ${cells.length} model cells (**\`value\`**); it needs exactly one`);
  return { lines, at, current: cells[0]![1]!, cellIndex: prefix.length + cells[0]!.index! };
}

/** The date (YYYY-MM-DD) of the approval. */
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'unknown date');

/** Compute the edit of the target file. `text` is the current file content. */
export function planEdit(action: RouteAction, route: Route, target: RouteTarget, text: string): RouteEdit {
  const kind = target.target.startsWith('env:') ? 'env' : 'claude-md';
  const label = target.target.slice(target.target.indexOf(':') + 1);
  let current: string;
  let replace: (newValue: string, oldValue: string) => string;
  if (kind === 'env') {
    const s = splitEnv(text, label, target.file);
    current = s.current;
    replace = (newValue, oldValue) => {
      const block =
        action === 'pr'
          ? [
              `# route ${route.id} (${route.use_case_key}): ${oldValue} -> ${newValue}; verdict ${route.verdict} under the ${route.picked_rule} rule, n=${route.n}, policy ${route.policy_version}; approved by ${route.approved_by_actor ?? 'unknown'} ${day(route.approved_at)}`,
              `# rollback: ${label}=${oldValue}  (tma route rollback ${route.id})`,
            ]
          : [`# route ${route.id} rolled back: ${oldValue} -> ${newValue}`];
      return [...s.lines.slice(0, s.blockStart), ...block, `${label}=${newValue}`, ...s.lines.slice(s.at + 1)].join('\n');
    };
  } else {
    const r = findRow(text, target.row_prefix!, target.file);
    current = r.current;
    replace = (newValue) => {
      const line = r.lines[r.at]!;
      const cell = `**\`${r.current}\`**`;
      const lines = [...r.lines];
      lines[r.at] = `${line.slice(0, r.cellIndex)}**\`${newValue}\`**${line.slice(r.cellIndex + cell.length)}`;
      return lines.join('\n');
    };
  }

  let oldValue: string;
  let newValue: string;
  if (action === 'pr') {
    if (route.rollback_value === null) throw new RouteRefusal(`route ${route.id} has no rollback_value, but ${target.file} holds ${label}=${current}: re-approve the route`);
    if (current !== route.rollback_value) throw new RouteRefusal(`${target.file} holds ${label}=${current}, not the approved rollback_value ${route.rollback_value}: the file moved since approval, re-approve the route`);
    if (current === route.target_value) throw new RouteRefusal(`${target.file} already holds ${label}=${current}: nothing to change`);
    oldValue = current;
    newValue = route.target_value;
  } else {
    if (current === route.rollback_value) throw new RouteRefusal(`${target.file} already holds ${label}=${current}: nothing to roll back`);
    if (current !== route.target_value) throw new RouteRefusal(`${target.file} holds ${label}=${current}, not the route value ${route.target_value}: the file moved since the route went live`);
    oldValue = current;
    newValue = route.rollback_value!;
  }
  // A rollback line reads `<new> -> <old>` in the brief's words: the route value, then the restored one.
  const after = replace(newValue, oldValue);
  return { action, route, target, label, oldValue, newValue, before: text, after };
}

// ------------------------------------------------------------- unified diff

/**
 * A unified diff (3 lines of context) of two texts that differ in ONE contiguous region (the apply path
 * edits one block). Both texts are split on '\n'; a final newline shows as a last empty element and is kept.
 */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  // Drop the empty element after a final newline from both sides when both end with one.
  const trail = a.at(-1) === '' && b.at(-1) === '';
  if (trail) {
    a.pop();
    b.pop();
  }
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const start = Math.max(0, pre - context);
  const aEnd = Math.min(a.length, a.length - suf + context);
  const bEnd = Math.min(b.length, b.length - suf + context);
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  const range = (s: number, n: number) => (n === 0 ? `${s},0` : n === 1 ? `${s + 1}` : `${s + 1},${n}`);
  out.push(`@@ -${range(start, aEnd - start)} +${range(start, bEnd - start)} @@`);
  for (let i = start; i < pre; i++) out.push(` ${a[i]}`);
  for (let i = pre; i < a.length - suf; i++) out.push(`-${a[i]}`);
  for (let i = pre; i < b.length - suf; i++) out.push(`+${b[i]}`);
  for (let i = a.length - suf; i < aEnd; i++) out.push(` ${a[i]}`);
  return out.join('\n');
}

// ------------------------------------------------------------- PR text

export function branchName(e: RouteEdit): string {
  return `route/${e.route.use_case_key.replace(/\//g, '-')}/${id8(e.route)}${e.action === 'rollback' ? '-rollback' : ''}`;
}

export function prTitle(e: RouteEdit): string {
  const uc = e.route.use_case_key;
  return e.action === 'pr'
    ? `route(${uc}): ${e.label} ${e.oldValue} -> ${e.newValue} (route ${id8(e.route)})`
    : `route(${uc}): rollback ${e.label} ${e.oldValue} -> ${e.newValue} (route ${id8(e.route)})`;
}

export function prBody(e: RouteEdit): string {
  const r = e.route;
  const dir = e.target.file.includes('/') ? e.target.file.slice(0, e.target.file.lastIndexOf('/') + 1) : './';
  const restore = e.target.target.startsWith('env:') ? `${e.label}=${e.action === 'pr' ? e.oldValue : e.newValue}` : `the model cell of ${e.label} back to \`${e.action === 'pr' ? e.oldValue : e.newValue}\``;
  const lines = [
    e.action === 'pr'
      ? `Applies the approved route \`${r.id}\` (plan 20261112-tma-c8-routing-from-evals, T4). Opened by \`tma route pr\`.`
      : `Rolls back the route \`${r.id}\` (plan 20261112-tma-c8-routing-from-evals, T4). Opened by \`tma route rollback\`.`,
    '',
    `- Route: \`${r.id}\` (state ${r.state}, tenant ${r.tenant})`,
    `- Use case: \`${r.use_case_key}\``,
    `- Target: \`${e.target.target}\` in \`${e.target.file}\``,
    `- Change: \`${e.oldValue}\` -> \`${e.newValue}\``,
    `- Agent: model \`${r.model_id}\`, agent sha256 \`${r.agent_sha256}\`${r.fallback_model_id ? `, fallback \`${r.fallback_model_id}\`` : ''}`,
    `- Verdict: ${r.verdict} under the ${r.picked_rule} rule, n=${r.n}`,
    `- Evidence run ids (${r.evidence_run_ids.length}):${r.evidence_run_ids.length ? '' : ' none'}`,
    ...r.evidence_run_ids.map((id) => `  - \`${id}\``),
    `- Compare profile sha256: \`${r.compare_profile_sha256}\``,
    `- Policy version: ${r.policy_version}`,
    `- Approved by: ${r.approved_by_actor ?? 'unknown'} at ${r.approved_at ?? 'unknown'}`,
    '',
    e.action === 'pr'
      ? `Rollback: \`${restore}\` (\`tma route rollback --route ${r.id} ...\`). The old value also stays in the file as the \`# rollback:\` line.`
      : `This restores \`${restore}\`, the value before the route.`,
    '',
    `Apply after merge: \`install -D -m 0644 ...\` and a \`sha256sum\` compare (see the README of \`${dir}\`).`,
    `Then: \`tma route mark --route ${r.id} --state ${e.action === 'pr' ? 'live' : 'rolled_back'} --pr <this PR URL>\`.`,
  ];
  return lines.join('\n');
}

// Paid-run budget for the nightly route regression (plan 20261112-tma-c8-routing-from-evals, T6, ADR-7;
// Q 0515c7ed = A). The paid-run count is derived from the TMA run rows (GET /eval-runs): each row names
// variant.agent.modelId. A model in a paid provider counts. The kit refuses a run that would pass the caps.
import { apiCall, describeRefusal, type Fetch } from '../api.js';
import { CliError } from '../env.js';
import { catalogModelId } from '../eval/upload.js';
import { PRIVATE_TEXT_JUDGE_MODELS } from '../eval/judge.js';

/** A11 Q2: the hard cap on paid runs. The env may only lower it. */
export const PAID_RUN_CAP = 200;
export const NIGHT_CAP = 10;
export const MONTH_CAP = 60;
const DAY_MS = 24 * 3600 * 1000;

export interface Caps {
  total: number;
  night: number;
  month: number;
}

function positiveInt(name: string, raw: string): number {
  if (!/^[1-9][0-9]{0,6}$/.test(raw.trim())) throw new CliError(`${name} must be a positive integer, got "${raw.slice(0, 20)}"`);
  return Number(raw.trim());
}

/** Caps from the defaults and the env. TMA_BUDGET_TOTAL can only lower the hard cap. */
export function capsFromEnv(env: NodeJS.ProcessEnv = process.env): Caps {
  const get = (n: string) => (env[n] !== undefined && env[n]!.trim() !== '' ? env[n]! : undefined);
  const t = get('TMA_BUDGET_TOTAL');
  const n = get('TMA_BUDGET_NIGHT');
  const m = get('TMA_BUDGET_MONTH');
  return {
    total: t === undefined ? PAID_RUN_CAP : Math.min(PAID_RUN_CAP, positiveInt('TMA_BUDGET_TOTAL', t)),
    night: n === undefined ? NIGHT_CAP : positiveInt('TMA_BUDGET_NIGHT', n),
    month: m === undefined ? MONTH_CAP : positiveInt('TMA_BUDGET_MONTH', m),
  };
}

// ---- tiers file ----
export const TIER_NAMES = ['frontier', 'mid', 'small', 'local'] as const;
export interface TierModel {
  model_id: string;
  tier: (typeof TIER_NAMES)[number];
  price_source: 'metered' | { table: string; as_of: string };
}
export interface Tiers {
  schema: 'tma-model-tiers/1';
  models: TierModel[];
}

function closed(o: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new CliError(`tiers file: unknown key "${k.slice(0, 40)}" in ${where}`);
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function parseTiers(text: string): Tiers {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new CliError('tiers file: not JSON');
  }
  if (!isObj(v)) throw new CliError('tiers file: not an object');
  if ('format' in v && !('schema' in v)) {
    throw new CliError('tiers file: the key "format" is not accepted; tma-model-tiers/1 uses "schema": "tma-model-tiers/1"');
  }
  closed(v, ['schema', 'models'], 'the file');
  if (v.schema !== 'tma-model-tiers/1') throw new CliError('tiers file: schema must be tma-model-tiers/1');
  if (!Array.isArray(v.models)) throw new CliError('tiers file: models must be an array');
  const models: TierModel[] = v.models.map((m, i) => {
    const where = `models[${i}]`;
    if (!isObj(m)) throw new CliError(`tiers file: ${where} is not an object`);
    closed(m, ['model_id', 'tier', 'price_source'], where);
    if (typeof m.model_id !== 'string' || m.model_id === '') throw new CliError(`tiers file: ${where}.model_id must be a non-empty string`);
    if (!MODEL_ID.test(m.model_id)) throw new CliError(`tiers file: ${where}.model_id does not match ${MODEL_ID.source}`);
    if (typeof m.tier !== 'string' || !(TIER_NAMES as readonly string[]).includes(m.tier)) {
      throw new CliError(`tiers file: ${where}.tier must be one of ${TIER_NAMES.join(', ')}`);
    }
    const ps = m.price_source;
    if (ps !== 'metered') {
      if (!isObj(ps)) throw new CliError(`tiers file: ${where}.price_source must be "metered" or {table, as_of}`);
      closed(ps, ['table', 'as_of'], `${where}.price_source`);
      if (typeof ps.table !== 'string' || ps.table === '' || typeof ps.as_of !== 'string' || ps.as_of === '') {
        throw new CliError(`tiers file: ${where}.price_source needs a table and an as_of string`);
      }
    }
    return { model_id: m.model_id, tier: m.tier as TierModel['tier'], price_source: ps as TierModel['price_source'] };
  });
  return { schema: 'tma-model-tiers/1', models };
}

// ---- paid or free ----
const LOCAL_ROUTE = /^(?:[a-z0-9_-]+\/)?(?:ollama|local)\/\S+$/;
const FLEET_CLAUDE = /^(?:anthropic\/)?claude-/;

function listedLocal(modelId: string, tiers: Tiers): boolean {
  const cat = catalogModelId(modelId);
  return tiers.models.some((m) => m.tier === 'local' && (m.model_id === modelId || m.model_id === cat || catalogModelId(m.model_id) === cat));
}

function isListed(modelId: string, tiers: Tiers): boolean {
  const cat = catalogModelId(modelId);
  return tiers.models.some((m) => m.model_id === modelId || m.model_id === cat || catalogModelId(m.model_id) === cat);
}

/** NOT paid: a local route, a fleet Claude model, or a model that tiers.json lists as tier local. Else paid (fail closed). */
export function isPaidModel(modelId: string, tiers: Tiers): boolean {
  const cat = catalogModelId(modelId);
  if (LOCAL_ROUTE.test(modelId) || LOCAL_ROUTE.test(cat)) return false;
  if (FLEET_CLAUDE.test(cat) || FLEET_CLAUDE.test(modelId) || PRIVATE_TEXT_JUDGE_MODELS.includes(cat)) return false;
  if (listedLocal(modelId, tiers)) return false;
  return true;
}

export interface RunRow {
  id?: string;
  startedAt: string;
  /** The case of the run (GET /eval-runs caseId, caseKey): the nightly held-out proof reads them. */
  caseId?: string;
  caseKey?: string;
  variant: { agent: { modelId: string } };
}

export interface Counts {
  total_runs: number;
  paid_total: number;
  paid_night: number;
  paid_month: number;
  unlisted: string[];
  by_model: Record<string, number>;
}

export function countPaidRuns(rows: RunRow[], tiers: Tiers, now: number): Counts {
  const c: Counts = { total_runs: rows.length, paid_total: 0, paid_night: 0, paid_month: 0, unlisted: [], by_model: {} };
  const nowD = new Date(now);
  const unlisted = new Set<string>();
  for (const r of rows) {
    const id = r.variant.agent.modelId;
    if (!isPaidModel(id, tiers)) continue;
    c.paid_total++;
    c.by_model[id] = (c.by_model[id] ?? 0) + 1;
    if (!isListed(id, tiers)) unlisted.add(id);
    const t = Date.parse(r.startedAt);
    if (t > now - DAY_MS && t <= now) c.paid_night++;
    const d = new Date(t);
    if (d.getUTCFullYear() === nowD.getUTCFullYear() && d.getUTCMonth() === nowD.getUTCMonth()) c.paid_month++;
  }
  c.unlisted = [...unlisted].sort();
  return c;
}

export interface BudgetCheck {
  ok: boolean;
  reasons: string[];
}

/** `planned` = paid runs about to start. Exactly at a cap is allowed; one over is refused. */
export function checkBudget(input: { counts: Counts; planned: number; caps: Caps }): BudgetCheck {
  const { counts, planned, caps } = input;
  const reasons: string[] = [];
  if (counts.paid_total + planned > caps.total) reasons.push(`total_cap: have ${counts.paid_total}, planned ${planned}, cap ${caps.total}`);
  if (counts.paid_night + planned > caps.night) reasons.push(`night_cap: have ${counts.paid_night}, planned ${planned}, cap ${caps.night}`);
  if (counts.paid_month + planned > caps.month) reasons.push(`month_cap: have ${counts.paid_month}, planned ${planned}, cap ${caps.month}`);
  return { ok: reasons.length === 0, reasons };
}

/** GET /eval-runs. Fails closed on anything that could make the paid count too low. */
export async function fetchRunRows(opts: { base: string; token: string; fetchImpl?: Fetch }): Promise<RunRow[]> {
  const r = await apiCall(opts.base, '/eval-runs', { token: opts.token, fetchImpl: opts.fetchImpl });
  if (r.status !== 200) throw new CliError(`cannot read the run rows: ${describeRefusal(r)}`);
  const runs = r.body?.runs;
  if (!Array.isArray(runs)) throw new CliError('runs_not_an_array: the /eval-runs answer has no runs array');
  if (r.body?.truncated === true) {
    throw new CliError('runs_truncated: the API caps /eval-runs at the 500 newest rows, so the paid count would be a lower bound; the API needs a count endpoint');
  }
  return runs.map((row, i) => {
    const o = isObj(row) ? row : {};
    const idPrefix = typeof o.id === 'string' ? o.id.slice(0, 8) : `#${i}`;
    const variant = isObj(o.variant) ? o.variant : {};
    const agent = isObj(variant.agent) ? variant.agent : {};
    if (typeof agent.modelId !== 'string' || agent.modelId === '') throw new CliError(`run_row_without_model_id: run ${idPrefix}`);
    if (typeof o.startedAt !== 'string' || Number.isNaN(Date.parse(o.startedAt))) throw new CliError(`run_row_without_started_at: run ${idPrefix}`);
    return {
      id: typeof o.id === 'string' ? o.id : undefined,
      startedAt: o.startedAt,
      caseId: typeof o.caseId === 'string' ? o.caseId : undefined,
      caseKey: typeof o.caseKey === 'string' ? o.caseKey : undefined,
      variant: { agent: { modelId: agent.modelId } },
    };
  });
}

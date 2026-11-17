// A campaign run-count cap for the eval kit (plan 20261112-tma-c7-model-comparison-per-use-case, task C7-PREP).
//
// A subscription plan (the z.ai coding plan) bills 0 dollars per run, so a money cap cannot stop a campaign.
// The cap counts RUNS. A campaign is one config file (tma-campaign/1) plus one ledger file next to it:
//
//   <name>.campaign.json          {"schema":"tma-campaign/1","name":"...","max_runs":45,"paid_runs_before":9}
//   <name>.campaign.ledger.jsonl  one line per run that the kit charged (tma-campaign-run/1)
//
// `charge` writes the lines for k runs, or refuses and writes nothing when used + k would pass max_runs. The
// refusal comes BEFORE the run starts. The same ledger is the one source for the paid-run budget of A11 Q2:
// a paid run is a run whose model is not local and not a fleet Claude model (route/budget.ts isPaidModel, Q 0515c7ed = A),
// and the total (paid_runs_before + the paid lines) may not pass PAID_RUN_CAP (200).
//
// Token caps (C7-T5, Q c91db81b, Tainan TG 31661): a subscription plan (Claude Code, Codex) also bills 0 dollars,
// and the comparison may use at most N tokens per provider. `token_caps` maps a provider label to its cap. A
// driver charges a run with `--provider` BEFORE the model call, and records the tokens of that run with
// `campaign record` AFTER it (tma-campaign-tokens/1 line). For a capped provider, a charge is refused when the
// last charged run has no token record yet (the sum would be blind), or when the recorded tokens plus the
// largest recorded run would pass the cap (the next run is assumed to cost as much as the largest one so far;
// the first run of a provider is the measure run). Every token counts: input, output, cache read, cache write.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CliError } from '../env.js';
import { isPaidModel, PAID_RUN_CAP, type Tiers } from '../route/budget.js';

export const CAMPAIGN_FORMAT = 'tma-campaign/1';
export const CAMPAIGN_RUN_FORMAT = 'tma-campaign-run/1';
export const CAMPAIGN_TOKENS_FORMAT = 'tma-campaign-tokens/1';
export const MAX_CAMPAIGN_RUNS = 10_000;
/** The largest token cap and the largest token count of one record. */
export const MAX_TOKEN_CAP = 1_000_000_000;
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const LOCK_STALE_MS = 60_000;

/** Fail closed: with no tiers file, only a local route or a fleet Claude model is free. */
const NO_TIERS: Tiers = { schema: 'tma-model-tiers/1', models: [] };

export interface Campaign {
  schema: typeof CAMPAIGN_FORMAT;
  name: string;
  /** The hard cap: the N+1th run is refused. */
  max_runs: number;
  /** Paid runs that happened before this ledger existed and that the ledger cannot see (for example runs that were never uploaded). */
  paid_runs_before: number;
  /** Provider label -> the most tokens the campaign may use with it (all kinds counted). Absent = no token cap. */
  token_caps?: Record<string, number>;
}

export interface LedgerLine {
  schema: typeof CAMPAIGN_RUN_FORMAT;
  at: string;
  /** null for a variant that calls no model (a patch variant). */
  model: string | null;
  paid: boolean;
  /** The provider label the run was charged to (needed when the campaign has token caps). */
  provider?: string;
}

/** The tokens of one charged run, written after the model call. */
export interface TokenLine {
  schema: typeof CAMPAIGN_TOKENS_FORMAT;
  at: string;
  provider: string;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  total: number;
}

export interface ProviderTokens {
  provider: string;
  cap: number | null;
  runs_charged: number;
  runs_recorded: number;
  tokens_used: number;
  max_run_tokens: number;
}

export interface CampaignState {
  campaign: Campaign;
  used: number;
  paid_in_ledger: number;
  paid_total: number;
  /** Per provider label that has a cap or a charged run, sorted by label. */
  tokens: ProviderTokens[];
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function ledgerPath(file: string): string {
  return resolve(file).replace(/\.json$/, '') + '.ledger.jsonl';
}

function positiveInt(label: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new CliError(`campaign file: ${label} must be an integer from ${min} to ${max}`);
  return v;
}

export function parseCampaign(text: string): Campaign {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new CliError('campaign file: not JSON');
  }
  if (!isObj(v)) throw new CliError('campaign file: not an object');
  for (const k of Object.keys(v)) if (!['schema', 'name', 'max_runs', 'paid_runs_before', 'token_caps'].includes(k)) throw new CliError(`campaign file: unknown key "${k.slice(0, 40)}"`);
  if (v.schema !== CAMPAIGN_FORMAT) throw new CliError(`campaign file: schema must be ${CAMPAIGN_FORMAT}`);
  if (typeof v.name !== 'string' || !NAME.test(v.name)) throw new CliError(`campaign file: name must match ${NAME.source}`);
  return {
    schema: CAMPAIGN_FORMAT,
    name: v.name,
    max_runs: positiveInt('max_runs', v.max_runs, 1, MAX_CAMPAIGN_RUNS),
    paid_runs_before: v.paid_runs_before === undefined ? 0 : positiveInt('paid_runs_before', v.paid_runs_before, 0, PAID_RUN_CAP),
    ...(v.token_caps === undefined ? {} : { token_caps: parseTokenCaps(v.token_caps) }),
  };
}

function parseTokenCaps(v: unknown): Record<string, number> {
  if (!isObj(v) || Object.keys(v).length === 0) throw new CliError('campaign file: token_caps must be an object of provider -> token cap, with at least one provider');
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (!PROVIDER.test(k)) throw new CliError(`campaign file: token_caps provider "${k.slice(0, 40)}" must match ${PROVIDER.source}`);
    out[k] = positiveInt(`token_caps.${k}`, n, 1, MAX_TOKEN_CAP);
  }
  return out;
}

/** `<provider>=<n>` from the command line. */
export function parseTokenCapFlag(text: string): [string, number] {
  const m = /^([^=]+)=(\d{1,10})$/.exec(text);
  if (!m || !PROVIDER.test(m[1]!)) throw new CliError(`--token-cap must be <provider>=<tokens>, the provider matching ${PROVIDER.source}`);
  const n = Number(m[2]);
  if (n < 1 || n > MAX_TOKEN_CAP) throw new CliError(`--token-cap ${m[1]}: the cap must be from 1 to ${MAX_TOKEN_CAP}`);
  return [m[1]!, n];
}

export function initCampaign(file: string, input: { name: string; maxRuns: number; paidRunsBefore?: number; tokenCaps?: Record<string, number> }): Campaign {
  const path = resolve(file);
  if (existsSync(path)) throw new CliError(`campaign file ${path} exists: the cap of a started campaign is not rewritten. Use a new file.`);
  const campaign = parseCampaign(
    JSON.stringify({
      schema: CAMPAIGN_FORMAT,
      name: input.name,
      max_runs: input.maxRuns,
      paid_runs_before: input.paidRunsBefore ?? 0,
      ...(input.tokenCaps && Object.keys(input.tokenCaps).length > 0 ? { token_caps: input.tokenCaps } : {}),
    }),
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(campaign, null, 2)}\n`, { flag: 'wx' });
  return campaign;
}

const tokenCount = (v: unknown, max = MAX_TOKEN_CAP): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;

function readLedger(file: string): Array<LedgerLine | TokenLine> {
  const p = ledgerPath(file);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim() !== '');
  return lines.map((l, i) => {
    let o: unknown;
    try {
      o = JSON.parse(l);
    } catch {
      throw new CliError(`campaign ledger ${p}: line ${i + 1} is not JSON; the count would be too low, so the kit stops`);
    }
    if (isObj(o) && o.schema === CAMPAIGN_TOKENS_FORMAT) {
      const ok = typeof o.provider === 'string' && ['tokens_in', 'tokens_out', 'cache_read', 'cache_write'].every((k) => tokenCount(o[k])) && tokenCount(o.total, 4 * MAX_TOKEN_CAP);
      if (!ok) throw new CliError(`campaign ledger ${p}: line ${i + 1} is not a ${CAMPAIGN_TOKENS_FORMAT} line`);
      return o as unknown as TokenLine;
    }
    if (!isObj(o) || o.schema !== CAMPAIGN_RUN_FORMAT || typeof o.paid !== 'boolean') throw new CliError(`campaign ledger ${p}: line ${i + 1} is not a ${CAMPAIGN_RUN_FORMAT} line`);
    return o as unknown as LedgerLine;
  });
}

/** Reads the campaign and its ledger. */
export function campaignState(file: string): CampaignState {
  const path = resolve(file);
  if (!existsSync(path)) throw new CliError(`campaign file ${path} does not exist: tma eval campaign init --file ${file} --name <name> --max-runs <n>`);
  const campaign = parseCampaign(readFileSync(path, 'utf-8'));
  const all = readLedger(file);
  const ledger = all.filter((l): l is LedgerLine => l.schema === CAMPAIGN_RUN_FORMAT);
  const records = all.filter((l): l is TokenLine => l.schema === CAMPAIGN_TOKENS_FORMAT);
  const paidInLedger = ledger.filter((l) => l.paid).length;
  const caps = campaign.token_caps ?? {};
  const providers = new Set<string>([...Object.keys(caps), ...ledger.flatMap((l) => (l.provider ? [l.provider] : [])), ...records.map((r) => r.provider)]);
  const tokens = [...providers].sort().map((provider): ProviderTokens => {
    const mine = records.filter((r) => r.provider === provider);
    return {
      provider,
      cap: caps[provider] ?? null,
      runs_charged: ledger.filter((l) => l.provider === provider).length,
      runs_recorded: mine.length,
      tokens_used: mine.reduce((a, r) => a + r.total, 0),
      max_run_tokens: mine.reduce((a, r) => Math.max(a, r.total), 0),
    };
  });
  return { campaign, used: ledger.length, paid_in_ledger: paidInLedger, paid_total: campaign.paid_runs_before + paidInLedger, tokens };
}

function tokenLine(t: ProviderTokens): string {
  return `${t.provider} ${t.tokens_used}${t.cap === null ? '' : ` of ${t.cap}`} tokens (${t.runs_recorded} of ${t.runs_charged} charged runs recorded)`;
}

/** One printable line: the runs against the cap and the paid runs against the A11 budget. */
export function statusLine(s: CampaignState): string {
  const base = `campaign ${s.campaign.name}: ${s.used} of ${s.campaign.max_runs} runs used; paid runs ${s.paid_total} of ${PAID_RUN_CAP} (${s.campaign.paid_runs_before} before the ledger + ${s.paid_in_ledger} in it)`;
  return s.tokens.length === 0 ? base : `${base}; tokens: ${s.tokens.map(tokenLine).join('; ')}`;
}

/** An exclusive lock file, so two chargers cannot both pass the check. A lock older than a minute is stale. */
function withLock<T>(file: string, fn: () => T): T {
  const lock = `${ledgerPath(file)}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch {
        /* the holder just released it */
      }
      if (Date.now() > deadline) throw new CliError(`campaign ledger is locked (${lock}); another run holds it`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Charges `runs` runs of `model` to the campaign, or refuses and writes nothing. `model` null = no model call.
 * Exactly at the cap is allowed; one over is refused (campaign_cap). A paid total over 200 is refused (paid_cap).
 */
export function chargeCampaign(file: string, input: { runs: number; model: string | null; provider?: string; now?: Date; tiers?: Tiers }): CampaignState {
  if (!Number.isInteger(input.runs) || input.runs < 1 || input.runs > MAX_CAMPAIGN_RUNS) throw new CliError('runs must be an integer from 1 to 10000');
  if (input.provider !== undefined && !PROVIDER.test(input.provider)) throw new CliError(`provider must match ${PROVIDER.source}`);
  return withLock(file, () => {
    const before = campaignState(file);
    const caps = before.campaign.token_caps;
    if (caps && input.model !== null && input.provider === undefined) {
      throw new CliError(`token_cap: campaign ${before.campaign.name} has token caps (${Object.keys(caps).join(', ')}); a run that calls a model must name its --provider. Nothing started.`);
    }
    const cap = input.provider !== undefined ? caps?.[input.provider] : undefined;
    if (cap !== undefined) {
      const t = before.tokens.find((x) => x.provider === input.provider)!;
      if (t.runs_charged > t.runs_recorded) {
        throw new CliError(`token_cap: ${input.provider} has ${t.runs_charged - t.runs_recorded} charged run(s) with no token record; record them first (tma eval campaign record). Nothing started.`);
      }
      const next = t.tokens_used + input.runs * t.max_run_tokens;
      if (t.tokens_used >= cap || next > cap) {
        throw new CliError(`token_cap: ${input.provider} used ${t.tokens_used} of ${cap} tokens; ${input.runs} more run(s) at the largest run so far (${t.max_run_tokens}) would reach ${next}. Nothing started.`);
      }
    }
    const paid = input.model !== null && isPaidModel(input.model, input.tiers ?? NO_TIERS);
    if (before.used + input.runs > before.campaign.max_runs) {
      throw new CliError(`campaign_cap: ${before.used} of ${before.campaign.max_runs} runs used, ${input.runs} more would pass the cap. Nothing started. ${statusLine(before)}`);
    }
    if (paid && before.paid_total + input.runs > PAID_RUN_CAP) {
      throw new CliError(`paid_cap: paid runs ${before.paid_total} of ${PAID_RUN_CAP}, ${input.runs} more would pass the A11 Q2 budget. Nothing started.`);
    }
    const at = (input.now ?? new Date()).toISOString();
    const line: LedgerLine = { schema: CAMPAIGN_RUN_FORMAT, at, model: input.model, paid, ...(input.provider !== undefined ? { provider: input.provider } : {}) };
    appendFileSync(ledgerPath(file), `${JSON.stringify(line)}\n`.repeat(input.runs));
    return campaignState(file);
  });
}

/**
 * Records the tokens of the last charged run of `provider` (after the model call). Refused when the provider has
 * no charged run without a record: a record never comes before its charge.
 */
export function recordTokens(
  file: string,
  input: { provider: string; model: string | null; tokensIn: number; tokensOut: number; cacheRead?: number; cacheWrite?: number; now?: Date },
): CampaignState {
  if (!PROVIDER.test(input.provider)) throw new CliError(`provider must match ${PROVIDER.source}`);
  const parts = { tokens_in: input.tokensIn, tokens_out: input.tokensOut, cache_read: input.cacheRead ?? 0, cache_write: input.cacheWrite ?? 0 };
  for (const [k, n] of Object.entries(parts)) if (!tokenCount(n)) throw new CliError(`${k} must be an integer from 0 to ${MAX_TOKEN_CAP}`);
  return withLock(file, () => {
    const before = campaignState(file);
    const t = before.tokens.find((x) => x.provider === input.provider);
    if (!t || t.runs_charged <= t.runs_recorded) throw new CliError(`no charged run of ${input.provider} is waiting for its tokens: charge the run first (tma eval campaign charge --provider ${input.provider})`);
    const total = parts.tokens_in + parts.tokens_out + parts.cache_read + parts.cache_write;
    const line: TokenLine = { schema: CAMPAIGN_TOKENS_FORMAT, at: (input.now ?? new Date()).toISOString(), provider: input.provider, model: input.model, ...parts, total };
    appendFileSync(ledgerPath(file), `${JSON.stringify(line)}\n`);
    return campaignState(file);
  });
}

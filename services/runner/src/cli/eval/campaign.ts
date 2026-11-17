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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CliError } from '../env.js';
import { isPaidModel, PAID_RUN_CAP, type Tiers } from '../route/budget.js';

export const CAMPAIGN_FORMAT = 'tma-campaign/1';
export const CAMPAIGN_RUN_FORMAT = 'tma-campaign-run/1';
export const MAX_CAMPAIGN_RUNS = 10_000;
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
}

export interface LedgerLine {
  schema: typeof CAMPAIGN_RUN_FORMAT;
  at: string;
  /** null for a variant that calls no model (a patch variant). */
  model: string | null;
  paid: boolean;
}

export interface CampaignState {
  campaign: Campaign;
  used: number;
  paid_in_ledger: number;
  paid_total: number;
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
  for (const k of Object.keys(v)) if (!['schema', 'name', 'max_runs', 'paid_runs_before'].includes(k)) throw new CliError(`campaign file: unknown key "${k.slice(0, 40)}"`);
  if (v.schema !== CAMPAIGN_FORMAT) throw new CliError(`campaign file: schema must be ${CAMPAIGN_FORMAT}`);
  if (typeof v.name !== 'string' || !NAME.test(v.name)) throw new CliError(`campaign file: name must match ${NAME.source}`);
  return {
    schema: CAMPAIGN_FORMAT,
    name: v.name,
    max_runs: positiveInt('max_runs', v.max_runs, 1, MAX_CAMPAIGN_RUNS),
    paid_runs_before: v.paid_runs_before === undefined ? 0 : positiveInt('paid_runs_before', v.paid_runs_before, 0, PAID_RUN_CAP),
  };
}

export function initCampaign(file: string, input: { name: string; maxRuns: number; paidRunsBefore?: number }): Campaign {
  const path = resolve(file);
  if (existsSync(path)) throw new CliError(`campaign file ${path} exists: the cap of a started campaign is not rewritten. Use a new file.`);
  const campaign = parseCampaign(
    JSON.stringify({ schema: CAMPAIGN_FORMAT, name: input.name, max_runs: input.maxRuns, paid_runs_before: input.paidRunsBefore ?? 0 }),
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(campaign, null, 2)}\n`, { flag: 'wx' });
  return campaign;
}

function readLedger(file: string): LedgerLine[] {
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
    if (!isObj(o) || o.schema !== CAMPAIGN_RUN_FORMAT || typeof o.paid !== 'boolean') throw new CliError(`campaign ledger ${p}: line ${i + 1} is not a ${CAMPAIGN_RUN_FORMAT} line`);
    return o as unknown as LedgerLine;
  });
}

/** Reads the campaign and its ledger. */
export function campaignState(file: string): CampaignState {
  const path = resolve(file);
  if (!existsSync(path)) throw new CliError(`campaign file ${path} does not exist: tma eval campaign init --file ${file} --name <name> --max-runs <n>`);
  const campaign = parseCampaign(readFileSync(path, 'utf-8'));
  const ledger = readLedger(file);
  const paidInLedger = ledger.filter((l) => l.paid).length;
  return { campaign, used: ledger.length, paid_in_ledger: paidInLedger, paid_total: campaign.paid_runs_before + paidInLedger };
}

/** One printable line: the runs against the cap and the paid runs against the A11 budget. */
export function statusLine(s: CampaignState): string {
  return `campaign ${s.campaign.name}: ${s.used} of ${s.campaign.max_runs} runs used; paid runs ${s.paid_total} of ${PAID_RUN_CAP} (${s.campaign.paid_runs_before} before the ledger + ${s.paid_in_ledger} in it)`;
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
export function chargeCampaign(file: string, input: { runs: number; model: string | null; now?: Date; tiers?: Tiers }): CampaignState {
  if (!Number.isInteger(input.runs) || input.runs < 1 || input.runs > MAX_CAMPAIGN_RUNS) throw new CliError('runs must be an integer from 1 to 10000');
  return withLock(file, () => {
    const before = campaignState(file);
    const paid = input.model !== null && isPaidModel(input.model, input.tiers ?? NO_TIERS);
    if (before.used + input.runs > before.campaign.max_runs) {
      throw new CliError(`campaign_cap: ${before.used} of ${before.campaign.max_runs} runs used, ${input.runs} more would pass the cap. Nothing started. ${statusLine(before)}`);
    }
    if (paid && before.paid_total + input.runs > PAID_RUN_CAP) {
      throw new CliError(`paid_cap: paid runs ${before.paid_total} of ${PAID_RUN_CAP}, ${input.runs} more would pass the A11 Q2 budget. Nothing started.`);
    }
    const at = (input.now ?? new Date()).toISOString();
    const line: LedgerLine = { schema: CAMPAIGN_RUN_FORMAT, at, model: input.model, paid };
    appendFileSync(ledgerPath(file), `${JSON.stringify(line)}\n`.repeat(input.runs));
    return campaignState(file);
  });
}

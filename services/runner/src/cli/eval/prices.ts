// `tma-model-prices/1`: the dated list prices of models, as a file (the format of `models/prices/*.json` in
// `devfellowship/dfl-evals`). `tma eval upload --prices <file>` turns the measured tokens of a patch variant that
// names its producer into a DERIVED cost: tokens x published list price. It is the list price of the measured
// tokens, not money paid (a producer on a subscription pays nothing). A model with no entry gets no cost: the kit
// never guesses a price.
import { createHash } from 'node:crypto';
import { CliError } from '../env.js';

export const PRICES_FORMAT = 'tma-model-prices/1';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const TABLE_KEYS = ['schema', 'as_of', 'currency', 'per', 'models'];
const ENTRY_KEYS = ['model_id', 'input', 'cache_read', 'cache_write', 'output', 'source_url', 'fetched_on', 'note'];

export interface PriceEntry {
  model_id: string;
  input: number;
  cache_read: number | null;
  cache_write: number | null;
  output: number;
  source_url: string;
  fetched_on: string;
  note: string;
}

export interface PriceTable {
  as_of: string;
  /** sha256 of the file bytes: the price table that the cost came from. */
  sha256: string;
  models: Map<string, PriceEntry>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Parse and validate a tma-model-prices/1 file. Every refusal is a CliError that names the file. */
export function parsePriceTable(bytes: string | Buffer, file: string): PriceTable {
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString());
  } catch {
    throw new CliError(`${file} is not JSON`);
  }
  const fail = (m: string): never => {
    throw new CliError(`${file}: ${m}`);
  };
  if (!isObject(doc)) return fail('a price table is a JSON object');
  for (const k of Object.keys(doc)) if (!TABLE_KEYS.includes(k)) fail(`unknown key ${k} (the format is closed)`);
  for (const k of TABLE_KEYS) if (!(k in doc)) fail(`missing key ${k}`);
  if (doc.schema !== PRICES_FORMAT) fail(`schema must be ${PRICES_FORMAT}`);
  if (typeof doc.as_of !== 'string' || !DATE.test(doc.as_of)) fail('as_of must be YYYY-MM-DD');
  if (doc.currency !== 'USD') fail('currency must be USD');
  if (doc.per !== '1M tokens') fail("per must be '1M tokens'");
  if (!Array.isArray(doc.models) || doc.models.length === 0) fail('models must be a non-empty list');
  const models = new Map<string, PriceEntry>();
  (doc.models as unknown[]).forEach((m, i) => {
    const w = `models[${i}]`;
    if (!isObject(m)) return fail(`${w} is not an object`);
    for (const k of Object.keys(m)) if (!ENTRY_KEYS.includes(k)) fail(`${w}: unknown key ${k} (the format is closed)`);
    for (const k of ENTRY_KEYS) if (!(k in m)) fail(`${w}: missing key ${k}`);
    if (typeof m.model_id !== 'string' || !MODEL.test(m.model_id)) fail(`${w}: model_id is malformed`);
    const id = m.model_id as string;
    if (models.has(id)) fail(`${w}: duplicate model_id ${id}`);
    for (const k of ['input', 'output'] as const) if (!positive(m[k])) fail(`${w}: ${k} must be a number greater than 0`);
    for (const k of ['cache_read', 'cache_write'] as const) if (m[k] !== null && !positive(m[k])) fail(`${w}: ${k} must be a number greater than 0, or null`);
    if (typeof m.source_url !== 'string' || !m.source_url.startsWith('https://') || m.source_url.length <= 8) fail(`${w}: source_url must start with https://`);
    if (typeof m.fetched_on !== 'string' || !DATE.test(m.fetched_on)) fail(`${w}: fetched_on must be YYYY-MM-DD`);
    else if (m.fetched_on !== doc.as_of) fail(`${w}: fetched_on ${m.fetched_on} differs from the table as_of ${String(doc.as_of)}`);
    if (typeof m.note !== 'string' || m.note.length > 400) fail(`${w}: note must be a string of at most 400 characters`);
    models.set(id, m as unknown as PriceEntry);
  });
  return { as_of: doc.as_of as string, sha256: createHash('sha256').update(bytes).digest('hex'), models };
}

/** The price entry of a producer model: the id as written, else its catalog spelling as the catalog spells it. Never a guess. */
export function priceFor(table: PriceTable, ...ids: string[]): PriceEntry | null {
  for (const id of ids) {
    const e = table.models.get(id);
    if (e) return e;
  }
  return null;
}

export interface UsageForCost {
  tokensIn: number | null;
  tokensOut: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
}

/**
 * USD of one run. `tokensIn` is the TOTAL input (cache reads and writes included), so the fresh input is what is
 * left after the cache tokens. A null cache price bills those tokens at the input price. null when the run has no
 * input or no output count.
 */
export function derivedCostUsd(p: PriceEntry, u: UsageForCost): number | null {
  if (u.tokensIn === null || u.tokensOut === null) return null;
  const read = u.cacheRead ?? 0;
  const write = u.cacheWrite ?? 0;
  const fresh = u.tokensIn - read - write;
  if (fresh < 0) return null;
  const usd = (fresh * p.input + read * (p.cache_read ?? p.input) + write * (p.cache_write ?? p.input) + u.tokensOut * p.output) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

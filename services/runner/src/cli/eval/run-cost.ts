// `tma eval cost` (plan 20261112-tma-c7-model-comparison-per-use-case, task C7-COST): add a DERIVED cost to runs that are
// already stored, without a new grading. A producer patch that was uploaded before `--prices` existed has tokens and no
// cost, and its patch is gone, so `tma eval upload` cannot send it again. This command sends only the measured tokens
// of each run and one dated price entry to POST /eval-results/run-cost. The API matches each entry to a stored run by its
// tokens, recomputes the cost, and writes only model_cost_usd and model_cost_source; it never touches a grade, a digest
// or the patch.
//
//   tma eval cost --evaluation <id> --model <model id> --prices <file> --tokens <file> [--apply]
//
//   --evaluation  the self-declared evaluation (the id that `tma eval upload` printed)
//   --model       the model id of the price entry; it must be the model stored on the runs (price.model_id)
//   --prices      a tma-model-prices/1 file (models/prices/<date>.json of the eval repo)
//   --tokens      a JSON list [{tokens_in, tokens_out, cache_read_tokens, cache_write_tokens}, ...], one item per run.
//                 tokens_in is the TOTAL input (cache reads and writes included), as the upload sent it.
//   --apply       write. Without it the API only checks and answers what it would write (dry run).
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RUN_COST_FORMAT, validateRunCost, type RunCostBody } from '@itera/contracts';
import { apiCall, describeRefusal, type Fetch } from '../api.js';
import { has, parseArgs, required } from '../args.js';
import type { Io } from '../command.js';
import { apiUrl, CliError } from '../env.js';
import { requireSession } from '../session.js';
import { parsePriceTable, priceFor } from './prices.js';

export const RUN_COST_USAGE = `usage: tma eval cost --evaluation <id> --model <model id> --prices <file> --tokens <file> [--apply]
  Adds a DERIVED cost (tokens x the list price) to runs already stored. No patch and no grade is sent; the API writes only
  the cost and its source, and never overwrites a cost that exists. Without --apply it is a dry run.
  --tokens  a JSON list, one item per run: {tokens_in, tokens_out, cache_read_tokens, cache_write_tokens} (tokens_in is the total input)`;

export interface RunCostDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  fetchImpl?: Fetch;
}

/** The tma-run-cost/1 body from the price file entry and the token list. Every refusal is a CliError. */
export function buildRunCostBody(input: { evaluationId: string; model: string; pricesFile: string; pricesBytes: Buffer; tokens: unknown; tokensFile: string; apply: boolean }): RunCostBody {
  const table = parsePriceTable(input.pricesBytes, input.pricesFile);
  const entry = priceFor(table, input.model);
  if (!entry) throw new CliError(`${input.pricesFile} has no price for ${input.model}: no cost is guessed`);
  if (!Array.isArray(input.tokens)) throw new CliError(`${input.tokensFile} must be a JSON list, one item per run`);
  const body = {
    format: RUN_COST_FORMAT,
    evaluation_id: input.evaluationId,
    dry_run: !input.apply,
    price: {
      model_id: entry.model_id, input: entry.input, cache_read: entry.cache_read, cache_write: entry.cache_write, output: entry.output,
      source_url: entry.source_url, as_of: table.as_of, table_sha256: table.sha256,
    },
    runs: input.tokens,
  };
  const checked = validateRunCost(body);
  if (!checked.ok) throw new CliError(`the body does not match ${RUN_COST_FORMAT}:\n  ${checked.issues.slice(0, 10).map((i) => `${i.path}: ${i.message}`).join('\n  ')}`);
  return checked.value;
}

async function readFileOrFail(file: string): Promise<Buffer> {
  return readFile(resolve(file)).catch(() => {
    throw new CliError(`cannot read ${file}`);
  });
}

export async function runCostMain(argv: string[], io: Io, deps: RunCostDeps): Promise<number> {
  const a = parseArgs(argv, { evaluation: {}, model: {}, prices: {}, tokens: {}, apply: { boolean: true } });
  const pricesFile = required(a, 'prices', RUN_COST_USAGE);
  const tokensFile = required(a, 'tokens', RUN_COST_USAGE);
  let tokens: unknown;
  try {
    tokens = JSON.parse((await readFileOrFail(tokensFile)).toString());
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`${tokensFile} is not JSON`);
  }
  const body = buildRunCostBody({
    evaluationId: required(a, 'evaluation', RUN_COST_USAGE),
    model: required(a, 'model', RUN_COST_USAGE),
    pricesFile,
    pricesBytes: await readFileOrFail(pricesFile),
    tokens,
    tokensFile,
    apply: has(a, 'apply'),
  });
  const env = deps.env ?? process.env;
  const base = apiUrl(env);
  const token = requireSession(base, (deps.now ?? (() => new Date()))().getTime(), env).session_token;
  const r = await apiCall(base, '/eval-results/run-cost', { method: 'POST', token, body, fetchImpl: deps.fetchImpl });
  if (r.status !== 200) {
    io.err(`cost: refused: ${describeRefusal(r)}`);
    return 1;
  }
  const rb = r.body ?? {};
  const dry = rb.dry_run === true;
  io.err(`[tma eval] cost derived from the list price of ${body.price.model_id}, table as of ${body.price.as_of} (sha256 ${body.price.table_sha256.slice(0, 12)}), source ${body.price.source_url}: tokens x list price, not money paid`);
  io.out(`${dry ? 'dry run OK, it would write' : 'wrote'}: evaluation ${String(rb.evaluation_id)}, ${String(rb.matched)} run(s) matched, ${String(rb.updated)} ${dry ? 'to update' : 'updated'}, ${String(rb.unchanged)} unchanged`);
  for (const run of Array.isArray(rb.runs) ? (rb.runs as Array<{ run_id?: unknown; cost_usd?: unknown }>) : []) io.out(`  ${String(run.run_id)}  ${String(run.cost_usd)} USD`);
  return 0;
}


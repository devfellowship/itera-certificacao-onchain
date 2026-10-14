// Cost meter of the model gateway (one gateway = one run). Pure code, no I/O: model-gateway.mjs
// feeds it the upstream response bytes, and src/gateway-meter.test.mjs tests it.
//
// OpenRouter puts a `usage` object in every completion response (docs "Usage Accounting": always
// on; `usage: {include: true}` is deprecated and has no effect). Non-streaming: in the JSON body.
// Streaming (SSE): in the last `data:` event. Fields: prompt_tokens, completion_tokens, cost
// (OpenRouter credits; 1 credit = 1 USD). The Responses API names the tokens input_tokens /
// output_tokens; both spellings are read.
//
// opencode go (K10) sends the same `usage` shape WITHOUT `cost`. The gateway then gets a price
// (USD per million tokens, ITERA_PRICE_JSON) and the meter DERIVES the cost from the tokens. The
// snapshot says which: cost_source = metered | derived | mixed | unpriced | none.

/** Usage numbers of one parsed `usage` object, or null when the value is not a usage object. */
export function readUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const tokensIn = num(usage.prompt_tokens ?? usage.input_tokens);
  const tokensOut = num(usage.completion_tokens ?? usage.output_tokens);
  const costUsd = num(usage.cost);
  if (tokensIn === 0 && tokensOut === 0 && costUsd === 0) return null;
  const cachedIn = Math.min(tokensIn, num(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens));
  // `cost` present (even 0, e.g. a free model) = the provider metered it. Absent = derive it.
  const costReported = typeof usage.cost === 'number' && Number.isFinite(usage.cost);
  return { tokensIn, tokensOut, costUsd, cachedIn, costReported };
}

/** USD cost of one call from its tokens and a price (USD per million tokens), or null without a price. */
export function derivedCost(usage, price) {
  if (!price || !usage) return null;
  const p = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const cached = usage.cachedIn ?? 0;
  const fresh = Math.max(0, usage.tokensIn - cached);
  return (fresh * p(price.input) + cached * p(price.cacheRead ?? price.input) + usage.tokensOut * p(price.output)) / 1e6;
}

/** The price of the run's model from ITERA_PRICE_JSON (`{"input","output","cacheRead"}`), or null. */
export function parsePrice(json) {
  if (!json) return null;
  try {
    const doc = JSON.parse(json);
    const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (!doc || !ok(doc.input) || !ok(doc.output)) return null;
    return { input: doc.input, output: doc.output, cacheRead: ok(doc.cacheRead) ? doc.cacheRead : doc.input };
  } catch {
    return null;
  }
}

/** The `usage` of one JSON document (a full body or one SSE event), or null. */
export function usageOfJson(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  // Chat Completions: { usage }. Responses API stream: { type: 'response.completed', response: { usage } }.
  return readUsage(doc?.usage) ?? readUsage(doc?.response?.usage);
}

/**
 * Collects the usage of ONE upstream response. Feed it the body chunks in order, then call end().
 * SSE bodies are parsed line by line (bounded memory); a JSON body is buffered up to maxJsonBytes.
 */
export class ResponseUsage {
  constructor(contentType, maxJsonBytes = 8 * 1024 * 1024) {
    this.sse = /text\/event-stream/i.test(contentType ?? '');
    this.maxJsonBytes = maxJsonBytes;
    this.buffer = '';
    this.overflow = false;
    this.usage = null;
  }

  push(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    if (this.sse) {
      let nl;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        this.line(this.buffer.slice(0, nl));
        this.buffer = this.buffer.slice(nl + 1);
      }
      // A single SSE line longer than 1 MB carries no usage we can trust: drop it.
      if (this.buffer.length > 1024 * 1024) this.buffer = '';
    } else if (this.buffer.length > this.maxJsonBytes) {
      this.overflow = true;
      this.buffer = '';
    }
  }

  line(raw) {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const usage = usageOfJson(data);
    // The last usage event of the stream wins (OpenRouter sends one, at the end).
    if (usage) this.usage = usage;
  }

  end() {
    if (this.sse) {
      if (this.buffer) this.line(this.buffer);
    } else if (!this.overflow && this.buffer) {
      this.usage = usageOfJson(this.buffer);
    }
    this.buffer = '';
    return this.usage;
  }
}

/** Running total of a run, with the hard cost cap. */
export class RunMeter {
  /** price: USD per million tokens, used only for a response without `cost` (opencode go). */
  constructor(maxCostUsd, price = null) {
    this.maxCostUsd = Number.isFinite(maxCostUsd) && maxCostUsd > 0 ? maxCostUsd : 0.5;
    this.price = price;
    this.meteredCalls = 0;
    this.derivedCalls = 0;
    this.unpricedCalls = 0;
    this.costUsd = 0;
    this.tokensIn = 0;
    this.tokensOut = 0;
    this.calls = 0;
    this.refused = 0;
  }

  /** True when the run already spent its budget: the gateway must refuse the next model call. */
  exhausted() {
    return this.costUsd >= this.maxCostUsd;
  }

  add(usage) {
    this.calls += 1;
    if (!usage) return;
    let cost = usage.costUsd;
    if (usage.costReported === false) {
      const derived = derivedCost(usage, this.price);
      if (derived === null) this.unpricedCalls += 1;
      else this.derivedCalls += 1;
      cost = derived ?? 0;
    } else {
      this.meteredCalls += 1;
    }
    this.costUsd += cost;
    this.tokensIn += usage.tokensIn;
    this.tokensOut += usage.tokensOut;
  }

  /** metered | derived | mixed | unpriced | none — how cost_usd was obtained. */
  costSource() {
    const kinds = [this.meteredCalls > 0 && 'metered', this.derivedCalls > 0 && 'derived', this.unpricedCalls > 0 && 'unpriced'].filter(Boolean);
    if (kinds.length === 0) return 'none';
    return kinds.length === 1 ? kinds[0] : 'mixed';
  }

  snapshot() {
    return {
      event: 'usage',
      cost_usd: Math.round(this.costUsd * 1e8) / 1e8,
      tokens_in: this.tokensIn,
      tokens_out: this.tokensOut,
      calls: this.calls,
      refused: this.refused,
      max_cost_usd: this.maxCostUsd,
      cap_reached: this.exhausted(),
      cost_source: this.costSource(),
    };
  }
}

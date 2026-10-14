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

/** Backoff before 429 retry number n (0-based): Retry-After seconds (capped at 30 s), else 2^(n+1) s. */
export function backoffMs(n, retryAfter) {
  const ra = Number(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter);
  if (Number.isFinite(ra) && ra >= 0) return Math.min(30, ra) * 1000;
  return Math.min(30_000, 2 ** (n + 1) * 1000);
}

const PARAM_KEYS = ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'reasoning', 'reasoning_effort', 'tool_choice', 'parallel_tool_calls', 'stream'];

/** The requested model and the sampling params of one request body (JSON), or null. Never the messages. */
export function requestParams(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const params = {};
  for (const k of PARAM_KEYS) {
    const v = doc[k];
    if (v === undefined) continue;
    if (typeof v === 'object' && v !== null) {
      const json = JSON.stringify(v);
      if (json.length <= 300) params[k] = v;
    } else params[k] = v;
  }
  return { model: typeof doc.model === 'string' ? doc.model.slice(0, 120) : null, params, tools: Array.isArray(doc.tools) ? doc.tools.length : 0 };
}

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
  /** headers: the upstream response headers (opencode go names the real model and endpoint there). */
  constructor(contentType, maxJsonBytes = 8 * 1024 * 1024, headers = {}) {
    this.sse = /text\/event-stream/i.test(contentType ?? '');
    this.maxJsonBytes = maxJsonBytes;
    this.buffer = '';
    this.overflow = false;
    this.usage = null;
    const h = (name) => (typeof headers?.[name] === 'string' ? headers[name].slice(0, 120) : null);
    this.headerModel = h('x-opencode-upstream-model-id');
    this.headerProvider = h('x-opencode-endpoint-id');
    this.model = null;
    this.provider = null;
  }

  /** The model and provider that answered (headers win for the model; body `provider` wins). */
  answer() {
    return { model: this.headerModel ?? this.model, provider: this.provider ?? this.headerProvider };
  }

  seen(doc) {
    if (!doc || typeof doc !== 'object') return;
    if (!this.model && typeof doc.model === 'string') this.model = doc.model.slice(0, 120);
    if (!this.provider && typeof doc.provider === 'string') this.provider = doc.provider.slice(0, 120);
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
    try {
      this.seen(JSON.parse(data));
    } catch {
      // not JSON
    }
    const usage = usageOfJson(data);
    // The last usage event of the stream wins (OpenRouter sends one, at the end).
    if (usage) this.usage = usage;
  }

  end() {
    if (this.sse) {
      if (this.buffer) this.line(this.buffer);
    } else if (!this.overflow && this.buffer) {
      this.usage = usageOfJson(this.buffer);
      try {
        this.seen(JSON.parse(this.buffer));
      } catch {
        // not JSON
      }
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
    /** Upstream 429 answers seen, and the ones that survived every retry (went back to the agent). */
    this.rateLimited = 0;
    this.rateLimitedFinal = 0;
    /** model id → calls, as ANSWERED by the upstream; provider → calls; requested model → calls. */
    this.models = {};
    this.providers = {};
    this.requested = {};
    this.params = null;
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

  /** One request body's model + params (requestParams()). The first call's params are the run's. */
  request(info) {
    if (!info) return;
    if (info.model) this.requested[info.model] = (this.requested[info.model] ?? 0) + 1;
    if (!this.params) this.params = { ...info.params, tools: info.tools };
  }

  add(usage, answer = null) {
    this.calls += 1;
    if (answer?.model) this.models[answer.model] = (this.models[answer.model] ?? 0) + 1;
    if (answer?.provider) this.providers[answer.provider] = (this.providers[answer.provider] ?? 0) + 1;
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
      rate_limited: this.rateLimited,
      rate_limited_final: this.rateLimitedFinal,
      effective_models: this.models,
      providers: this.providers,
      requested_models: this.requested,
      params: this.params,
    };
  }
}

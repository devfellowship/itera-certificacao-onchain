// Cost meter of the model gateway (one gateway = one run). Pure code, no I/O: model-gateway.mjs
// feeds it the upstream response bytes, and src/gateway-meter.test.mjs tests it.
//
// OpenRouter puts a `usage` object in every completion response (docs "Usage Accounting": always
// on; `usage: {include: true}` is deprecated and has no effect). Non-streaming: in the JSON body.
// Streaming (SSE): in the last `data:` event. Fields: prompt_tokens, completion_tokens, cost
// (OpenRouter credits; 1 credit = 1 USD). The Responses API names the tokens input_tokens /
// output_tokens; both spellings are read.

/** Usage numbers of one parsed `usage` object, or null when the value is not a usage object. */
export function readUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const tokensIn = num(usage.prompt_tokens ?? usage.input_tokens);
  const tokensOut = num(usage.completion_tokens ?? usage.output_tokens);
  const costUsd = num(usage.cost);
  if (tokensIn === 0 && tokensOut === 0 && costUsd === 0) return null;
  return { tokensIn, tokensOut, costUsd };
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
  constructor(maxCostUsd) {
    this.maxCostUsd = Number.isFinite(maxCostUsd) && maxCostUsd > 0 ? maxCostUsd : 0.5;
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
    this.costUsd += usage.costUsd;
    this.tokensIn += usage.tokensIn;
    this.tokensOut += usage.tokensOut;
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
    };
  }
}

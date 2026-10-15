/**
 * T8: the OpenRouter key probe (plan 20261015-testmyagent-web2-client, ADR-5), with a mocked fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenRouterKeyProbe, OPENROUTER_KEY_URL, probeKey } from "./openrouter-key.js";
import { platformKeyConfigFromEnv } from "./platform-key.js";

const KEY = "sk-or-v1-" + "SECRETKEYMATERIAL".repeat(3);
const FRAGMENT = "SECRETKEYMATERIAL";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fetchOf = (res: () => Response | Promise<Response>) => vi.fn<typeof fetch>(async () => res());

function captureLogs() {
  const lines: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" "))),
  );
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

afterEach(() => vi.restoreAllMocks());

describe("probeKey", () => {
  it("calls GET /api/v1/key with the bearer key and a timeout signal", async () => {
    const f = fetchOf(() => json(200, { data: { label: "sk-or-v1-abc...xyz", limit_remaining: 4.5, is_free_tier: false, usage: 1 } }));
    const r = await probeKey(KEY, { fetchFn: f });
    expect(r).toEqual({ status: "valid", info: { label: "sk-or-v1-abc...xyz", limitRemaining: 4.5, isFreeTier: false } });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(OPENROUTER_KEY_URL);
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([401, 403, 500])("%i → invalid", async (status) => {
    expect(await probeKey(KEY, { fetchFn: fetchOf(() => json(status, { error: { message: "No auth credentials found" } })) })).toEqual({ status: "invalid", httpStatus: status });
  });

  it("limit_remaining 0 → no_credit; null (no limit) → valid", async () => {
    expect((await probeKey(KEY, { fetchFn: fetchOf(() => json(200, { data: { label: "k", limit_remaining: 0 } })) })).status).toBe("no_credit");
    expect(await probeKey(KEY, { fetchFn: fetchOf(() => json(200, { data: { label: "k", limit_remaining: null, is_free_tier: true } })) })).toEqual({
      status: "valid",
      info: { label: "k", limitRemaining: null, isFreeTier: true },
    });
  });

  it("an unknown 200 body is accepted with a warning that does not contain the key", async () => {
    const warn = vi.fn();
    for (const body of [{ something: "else" }, "not json at all", { data: [1, 2] }]) {
      const f = fetchOf(() => (typeof body === "string" ? new Response(body, { status: 200 }) : json(200, body)));
      expect((await probeKey(KEY, { fetchFn: f, warn })).status).toBe("valid");
    }
    expect(warn).toHaveBeenCalledTimes(3);
    for (const [m] of warn.mock.calls) expect(String(m)).not.toContain(FRAGMENT);
  });

  it("a timeout → unavailable (timeout); a network error → unavailable (network)", async () => {
    const hang = vi.fn<typeof fetch>(
      (_u, init) =>
        new Promise((_res, rej) => {
          init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason));
        }),
    );
    expect(await probeKey(KEY, { fetchFn: hang, timeoutMs: 20 })).toEqual({ status: "unavailable", reason: "timeout" });
    expect(await probeKey(KEY, { fetchFn: vi.fn<typeof fetch>(async () => Promise.reject(new TypeError("fetch failed"))) })).toEqual({ status: "unavailable", reason: "network" });
  });

  it("no log line of any outcome contains the key or a substring of it (default console sink)", async () => {
    const logs = captureLogs();
    try {
      const probe = createOpenRouterKeyProbe({ fetchFn: fetchOf(() => json(200, { weird: true })) });
      const results = [await probe(KEY)];
      for (const f of [fetchOf(() => json(401, {})), fetchOf(() => json(200, { data: { limit_remaining: 0 } })), vi.fn<typeof fetch>(async () => Promise.reject(new TypeError(`boom ${KEY}`)))]) {
        results.push(await createOpenRouterKeyProbe({ fetchFn: f })(KEY));
      }
      expect(results.map((r) => (r.ok ? "ok" : r.code))).toEqual(["ok", "model_key_invalid", "model_key_no_credit", "model_key_probe_unavailable"]);
      expect(logs.lines.length).toBeGreaterThan(0);
      const all = logs.lines.join("\n") + JSON.stringify(results);
      expect(all).not.toContain(FRAGMENT);
      expect(all).not.toContain(KEY.slice(6, 20));
    } finally {
      logs.restore();
    }
  });

  it("the unavailable result carries a Retry-After value", async () => {
    const r = await createOpenRouterKeyProbe({ fetchFn: vi.fn<typeof fetch>(async () => Promise.reject(new TypeError("x"))) })(KEY);
    expect(r).toMatchObject({ ok: false, code: "model_key_probe_unavailable", retryAfterSeconds: 30 });
  });
});

describe("platformKeyConfigFromEnv", () => {
  it("is off by default and never reads the platform key while off", () => {
    expect(platformKeyConfigFromEnv({ TMA_RUNNER_OPENROUTER_KEY: "sk-or-platform-xxxxxxxxxxxxxxxx" })).toEqual({
      enabled: false,
      runsPerUserPerDay: 3,
      maxPromptUsdPerToken: 0.0000005,
      key: null,
    });
  });
  it("reads the knobs and the key when the flag is on", () => {
    expect(
      platformKeyConfigFromEnv({
        TMA_PLATFORM_KEY_ENABLED: "true",
        TMA_PLATFORM_RUNS_PER_USER_PER_DAY: "5",
        TMA_PLATFORM_MAX_PROMPT_USD_PER_TOKEN: "0.000001",
        TMA_RUNNER_OPENROUTER_KEY: " sk-or-platform-xxxxxxxxxxxxxxxx ",
      }),
    ).toEqual({ enabled: true, runsPerUserPerDay: 5, maxPromptUsdPerToken: 0.000001, key: "sk-or-platform-xxxxxxxxxxxxxxxx" });
  });
  it("refuses an invalid number", () => {
    expect(() => platformKeyConfigFromEnv({ TMA_PLATFORM_RUNS_PER_USER_PER_DAY: "2.5" })).toThrow(/TMA_PLATFORM_RUNS_PER_USER_PER_DAY/);
    expect(() => platformKeyConfigFromEnv({ TMA_PLATFORM_MAX_PROMPT_USD_PER_TOKEN: "-1" })).toThrow(/TMA_PLATFORM_MAX_PROMPT_USD_PER_TOKEN/);
  });
});

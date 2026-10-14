import { describe, expect, it } from 'vitest';
import { buildCreateArgs, defaultSandboxConfig, buildGatewayArgs, modelRoute, normalizeModel } from './sandbox.js';

describe('buildCreateArgs', () => {
  const config = defaultSandboxConfig({});
  const args = buildCreateArgs({ name: 'itera-run-x', network: 'itera-sbx-x', model: 'qwen/qwen3-coder', prompt: 'Fix it; rm -rf /', config });

  it('gives the sandbox no secret and no proxy setting (the gateway holds the key)', () => {
    expect(args.join(' ')).not.toMatch(/KEY|TOKEN|SECRET|PROXY|-e /i);
  });

  it('isolates the container: own network, no capabilities, limits, no socket mount', () => {
    expect(args).toEqual(expect.arrayContaining(['--network', 'itera-sbx-x', '--cap-drop', 'ALL', '--pids-limit', '512']));
    expect(args).toContain('no-new-privileges');
    expect(args.join(' ')).not.toMatch(/docker\.sock|--privileged|-v |--volume|--mount/);
  });

  it('runs opencode headless with the prompt as one argument', () => {
    expect(args.slice(-10, -1)).toEqual([
      config.image, 'run', '--pure', '--format', 'json', '--dir', '/workspace', '-m', 'openrouter/qwen/qwen3-coder',
    ]);
    expect(args.at(-1)).toBe('Fix it; rm -rf /');
  });

  it('defaults: 300 s wall limit and openrouter.ai as the only upstream', () => {
    expect(config.wallMs).toBe(300_000);
    expect(config.upstream).toBe('https://openrouter.ai');
  });
});

describe('normalizeModel', () => {
  it('prefixes the openrouter provider once', () => {
    expect(normalizeModel('openai/gpt-5-mini')).toBe('openrouter/openai/gpt-5-mini');
    expect(normalizeModel('openrouter/openai/gpt-5-mini')).toBe('openrouter/openai/gpt-5-mini');
  });
  it('refuses ids that are not plain model names', () => {
    expect(() => normalizeModel('x --dir /')).toThrow();
  });
});

describe('buildGatewayArgs', () => {
  it('passes the BYOK key by name only and drops all capabilities', () => {
    const args = buildGatewayArgs({ name: 'itera-gw-x', config: defaultSandboxConfig({}) });
    expect(args[args.indexOf('ITERA_UPSTREAM_KEY') - 1]).toBe('-e');
    expect(args.some((a) => a.startsWith('ITERA_UPSTREAM_KEY='))).toBe(false);
    expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', 'ITERA_UPSTREAM=https://openrouter.ai']));
    expect(args.join(' ')).not.toMatch(/docker\.sock|-v |--volume|--mount/);
  });
  it('passes the per-run cost cap to the gateway (default US$0.50, env ITERA_RUN_MAX_COST_USD)', () => {
    expect(buildGatewayArgs({ name: 'g', config: defaultSandboxConfig({}) })).toContain('ITERA_RUN_MAX_COST_USD=0.5');
    expect(buildGatewayArgs({ name: 'g', config: defaultSandboxConfig({ ITERA_RUN_MAX_COST_USD: '1.25' }) })).toContain('ITERA_RUN_MAX_COST_USD=1.25');
    expect(defaultSandboxConfig({ ITERA_RUN_MAX_COST_USD: 'abc' }).maxCostUsd).toBe(0.5);
  });
});

describe('model route (K10)', () => {
  const config = defaultSandboxConfig({});
  it('opencode-go/<model> → opencode go upstream, /zen/go/v1/ prefix, price table, session header', () => {
    const r = modelRoute('opencode-go/deepseek-v4.1-flash', config);
    expect(r).toMatchObject({ route: 'opencode-go', opencodeModel: 'opencode-go/deepseek-v4.1-flash', upstreamModel: 'deepseek-v4.1-flash', upstream: 'https://opencode.ai', pathPrefix: '/zen/go/v1/', needsSessionHeader: true });
    expect(r.price).toMatchObject({ input: 0.15, output: 0.6, cacheRead: 0.003 });
    expect(normalizeModel('opencode-go/deepseek-v4.1-flash')).toBe('opencode-go/deepseek-v4.1-flash');
  });
  it('everything else stays on OpenRouter with no price (OpenRouter meters USD itself)', () => {
    expect(modelRoute('nvidia/nemotron-3-super:free', config)).toMatchObject({ route: 'openrouter', opencodeModel: 'openrouter/nvidia/nemotron-3-super:free', pathPrefix: '/api/v1/', price: null });
  });
  it('refuses a nested or empty opencode-go id', () => {
    expect(() => modelRoute('opencode-go/', config)).toThrow();
    expect(() => modelRoute('opencode-go/a/b', config)).toThrow();
  });
  it('the gateway of an opencode-go run gets the go upstream, prefix, price and a session id — and still no key value', () => {
    const route = modelRoute('opencode-go/deepseek-v4.1-flash', config);
    const args = buildGatewayArgs({ name: 'g', config, route, sessionId: 'itera-run1' });
    expect(args).toEqual(expect.arrayContaining(['ITERA_UPSTREAM=https://opencode.ai', 'ITERA_ROUTE=opencode-go', 'ITERA_GATEWAY_PATH_PREFIX=/zen/go/v1/', 'ITERA_GATEWAY_SESSION=itera-run1']));
    expect(args.find((a) => a.startsWith('ITERA_PRICE_JSON='))).toBe('ITERA_PRICE_JSON={"input":0.15,"output":0.6,"cacheRead":0.003}');
    expect(args.some((a) => a.startsWith('ITERA_UPSTREAM_KEY='))).toBe(false);
  });
  it('the sandbox runs opencode with -m opencode-go/<model> and still gets no secret', () => {
    const args = buildCreateArgs({ name: 'n', network: 'x', model: 'opencode-go/deepseek-v4.1-flash', prompt: 'p', config });
    expect(args).toContain('opencode-go/deepseek-v4.1-flash');
    expect(args.join(' ')).not.toMatch(/KEY|TOKEN|SECRET|-e /i);
  });
});

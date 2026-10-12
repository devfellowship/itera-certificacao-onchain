import { describe, expect, it } from 'vitest';
import { buildCreateArgs, defaultSandboxConfig, buildGatewayArgs, normalizeModel } from './sandbox.js';

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

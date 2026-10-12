import { describe, expect, it } from 'vitest';
import { buildCreateArgs, defaultSandboxConfig, keyFingerprint, normalizeModel } from './sandbox.js';

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

describe('keyFingerprint', () => {
  it('is short, stable and does not contain the key', () => {
    expect(keyFingerprint('sk-or-v1-abc')).toMatch(/^[0-9a-f]{12}$/);
    expect(keyFingerprint('sk-or-v1-abc')).toBe(keyFingerprint('sk-or-v1-abc'));
    expect(keyFingerprint('sk-or-v1-abc')).not.toBe(keyFingerprint('sk-or-v1-abd'));
  });
});

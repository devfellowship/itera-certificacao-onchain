import { describe, expect, it } from 'vitest';
import { validateRunProfile } from '@itera/contracts';
import { loadRunProfile, renderRunCmd } from './run-profile.js';
import { buildCreateArgs, defaultSandboxConfig } from './sandbox.js';

const profile = loadRunProfile('opencode');
const clone = () => structuredClone(profile) as any;

describe('opencode run profile (Valkyrie-shaped)', () => {
  it('is valid and keeps the model key out of the sandbox', () => {
    expect(validateRunProfile(profile).ok).toBe(true);
    expect(profile.run_egress).toEqual(['model-gateway']);
    expect(Object.values(profile.secrets).every((s) => s.inject_into === 'gateway')).toBe(true);
    expect(profile.install_cmd).toContain('--ignore-scripts');
  });

  it('produces exactly the docker create argv of the hard-coded runner (byte-identical)', () => {
    const config = defaultSandboxConfig({});
    const args = buildCreateArgs({ name: 'itera-run-x', network: 'itera-sbx-x', model: 'qwen/qwen3-coder', prompt: 'Fix {model} it; rm -rf /', config });
    expect(args).toEqual([
      'create', '--name', 'itera-run-x', '--label', 'itera.role=agent-sandbox', '--network', 'itera-sbx-x',
      '--memory', '2g', '--memory-swap', '2g', '--cpus', '2', '--pids-limit', '512',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '10001:10001',
      config.image, 'run', '--pure', '--format', 'json', '--dir', '/workspace', '-m', 'openrouter/qwen/qwen3-coder',
      'Fix {model} it; rm -rf /',
    ]);
  });

  it('derives the same defaults as before, and the ITERA_* env vars still override', () => {
    const d = defaultSandboxConfig({});
    expect([d.wallMs, d.memory, d.cpus, d.pidsLimit]).toEqual([300_000, '2g', '2', 512]);
    const o = defaultSandboxConfig({ ITERA_RUN_WALL_MS: '1000', ITERA_SANDBOX_MEMORY: '1g', ITERA_SANDBOX_CPUS: '1', ITERA_SANDBOX_PIDS: '64' });
    expect([o.wallMs, o.memory, o.cpus, o.pidsLimit]).toEqual([1000, '1g', '1', 64]);
  });

  it('keeps the instruction as one argument and gives a non-opencode run_cmd its own entrypoint', () => {
    const p = clone();
    p.run_cmd = ['node', 'agent.mjs', '--task', '{instruction}'];
    expect(renderRunCmd(p, { workspace: '/w', model: 'm', instruction: 'a b; c' })).toEqual(['node', 'agent.mjs', '--task', 'a b; c']);
    const args = buildCreateArgs({ name: 'n', network: 'net', model: 'x/y', prompt: 'p', config: { ...defaultSandboxConfig({}), profile: p } });
    expect(args.slice(args.indexOf('--entrypoint'), args.indexOf('--entrypoint') + 2)).toEqual(['--entrypoint', 'node']);
  });

  it('rejects a secret injected into the sandbox, npm with scripts, open run egress and a run_cmd without {instruction}', () => {
    const bad = [
      (p: any) => (p.secrets.X = { source: 'X', inject_into: 'sandbox' }),
      (p: any) => (p.install_cmd = ['npm', 'ci']),
      (p: any) => (p.run_egress = ['*']),
      (p: any) => (p.run_cmd = ['opencode', 'run']),
      (p: any) => (p.secrets.X = { source: 'X', inject_into: 'gateway', value: 'sk-1' }),
    ];
    for (const edit of bad) {
      const p = clone();
      edit(p);
      expect(validateRunProfile(p).ok).toBe(false);
    }
  });

  it('refuses an unknown profile name', () => {
    expect(() => loadRunProfile('nope')).toThrow(/could not be read/);
    expect(() => loadRunProfile('../x')).toThrow(/invalid run profile name/);
  });
});

// `tma studio serve` flag handling (task C5-T11). The service itself: ../studio/server.test.ts.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliError } from '../env.js';
import { COMMANDS } from '../tma.js';
import { studioCommand } from './studio.js';

const io = { out: () => undefined, err: () => undefined };

describe('tma studio', () => {
  it('is a registered command', () => {
    expect(COMMANDS.map((c) => c.name)).toContain('studio');
  });

  it('refuses an unknown subcommand', async () => {
    await expect(studioCommand.main(['start'], io)).rejects.toThrow(CliError);
    await expect(studioCommand.main([], io)).rejects.toThrow(/unknown subcommand/);
  });

  it('refuses to start without an allowed principal', async () => {
    await expect(studioCommand.main(['serve'], io)).rejects.toThrow(/--allow-principal is required/);
  });

  it('has no flag to bind another address', async () => {
    await expect(studioCommand.main(['serve', '--allow-principal', 'dfl:x1', '--bind', '0.0.0.0'], io)).rejects.toThrow(/unknown option --bind/);
    await expect(studioCommand.main(['serve', '--allow-principal', 'dfl:x1', '--host', '0.0.0.0'], io)).rejects.toThrow(/unknown option --host/);
  });

  it('refuses an origin with a path', async () => {
    await expect(studioCommand.main(['serve', '--allow-principal', 'dfl:x1', '--allow-origin', 'https://a.example/x'], io)).rejects.toThrow(/must be an origin/);
  });

  it('fixture: writes the synthetic tree with its marker; refuses a root that is not empty; needs --out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tma-studio-cmd-'));
    const out = join(dir, 'fx');
    const lines: string[] = [];
    expect(await studioCommand.main(['fixture', '--out', out], { out: (l: string) => lines.push(l), err: () => undefined })).toBe(0);
    expect(existsSync(join(out, '.tma-studio-fixture'))).toBe(true);
    expect(existsSync(join(out, 'trace-index.sqlite'))).toBe(true);
    expect(lines.join('\n')).toContain('FIXTURE-00001');
    await expect(studioCommand.main(['fixture', '--out', out], io)).rejects.toThrow(/not empty/);
    await expect(studioCommand.main(['fixture'], io)).rejects.toThrow(/--out is required/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('serve: refuses a principal on both lists, a fixture principal without a fixture root, and a bad fixture root', async () => {
    await expect(studioCommand.main(['serve', '--allow-principal', 'dfl:x1', '--fixture-principal', 'dfl:x1', '--fixture-root', '/nonexistent'], io)).rejects.toThrow(/on both --allow-principal and --fixture-principal/);
    await expect(studioCommand.main(['serve', '--allow-principal', 'dfl:x1', '--fixture-principal', 'dfl:x2'], io)).rejects.toThrow(/needs --fixture-root/);
    await expect(studioCommand.main(['serve', '--allow-principal', 'dfl:x1', '--fixture-principal', 'bad id!'], io)).rejects.toThrow(/not a principal id/);
    const bare = mkdtempSync(join(tmpdir(), 'tma-studio-cmd-bare-'));
    writeFileSync(join(bare, 'x'), '');
    await expect(studioCommand.main(['serve', '--allow-principal', 'dfl:x1', '--fixture-principal', 'dfl:x2', '--fixture-root', bare], io)).rejects.toThrow(/--fixture-root: .*marker/);
    rmSync(bare, { recursive: true, force: true });
  });
});

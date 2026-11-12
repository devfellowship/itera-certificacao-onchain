// `tma studio serve` flag handling (task C5-T11). The service itself: ../studio/server.test.ts.
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
});

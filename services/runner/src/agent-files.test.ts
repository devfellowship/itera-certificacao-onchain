import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAllowedAgentPath, materializeAgentFiles } from './agent-files.js';

describe('isAllowedAgentPath', () => {
  it.each(['AGENTS.md', 'CLAUDE.md', 'skills/loop/SKILL.md', 'skills/a/b/c.md'])('allows %s', (p) => {
    expect(isAllowedAgentPath(p)).toBe(true);
  });
  it.each(['/etc/passwd', '../AGENTS.md', 'skills/../../x', 'src/app.ts', 'skills/', '.env', 'skills\\x', './AGENTS.md', 'skills//x'])(
    'refuses %s',
    (p) => {
      expect(isAllowedAgentPath(p)).toBe(false);
    },
  );
});

describe('materializeAgentFiles', () => {
  it('writes allowed files (utf-8 and base64) and skips the rest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'itera-af-'));
    try {
      const result = await materializeAgentFiles(
        [
          { path: 'AGENTS.md', content: '# a' },
          { path: 'skills/s/SKILL.md', encoding: 'base64', content: Buffer.from('skill').toString('base64') },
          { path: 'package.json', content: '{}' },
        ],
        dir,
      );
      expect(result).toEqual({ written: ['AGENTS.md', 'skills/s/SKILL.md'], skipped: ['package.json'] });
      expect(await readFile(join(dir, 'skills/s/SKILL.md'), 'utf-8')).toBe('skill');
      expect((await readdir(dir)).sort()).toEqual(['AGENTS.md', 'skills']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a snapshot over 512 KB', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'itera-af-'));
    try {
      await expect(materializeAgentFiles([{ path: 'AGENTS.md', content: 'x'.repeat(600 * 1024) }], dir)).rejects.toThrow(/512 KB/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

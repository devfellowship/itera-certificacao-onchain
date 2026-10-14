import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesDigest, readAgentFiles } from './bench-enqueue.js';

describe('bench-enqueue', () => {
  it('snapshots only the agent files the worker accepts, in a stable order', async () => {
    const files = await readAgentFiles(resolve(import.meta.dirname, '..', 'examples', 'sample-agent'));
    expect(files.map((f) => f.path)).toEqual(['AGENTS.md', 'skills/inspect-test-patch/SKILL.md']);
  });
  it('the files digest is stable and changes with the content', () => {
    const a = [{ path: 'AGENTS.md', content: 'x' }];
    expect(filesDigest(a)).toBe(filesDigest([{ path: 'AGENTS.md', content: 'x' }]));
    expect(filesDigest(a)).not.toBe(filesDigest([{ path: 'AGENTS.md', content: 'y' }]));
    expect(filesDigest(a)).toMatch(/^files-[0-9a-f]{40}$/);
  });
});

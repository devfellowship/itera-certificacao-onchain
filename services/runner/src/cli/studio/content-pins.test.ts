// S13 helpers of `tma studio serve` (plan 20261112-tma-c6-judge-calibration, task C6-REVIEW-QUEUE-READY): the session
// of a recorded session file path, and the line filter that reads ONE sub-agent of a layer-1 file over 64 MB.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readJsonlFiltered, sessionOfFile } from './content.js';

const dir = mkdtempSync(join(tmpdir(), 'tma-studio-filter-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('sessionOfFile', () => {
  it('reads a main session file and a sub-agent file, and nothing else', () => {
    const sid = '0123abcd-0000-4000-8000-00000000000a';
    expect(sessionOfFile(`/root/.claude/projects/-root/${sid}.jsonl`)).toEqual({ session_id: sid, agent_id: null });
    expect(sessionOfFile(`/root/.claude/projects/-root/${sid}/subagents/agent-a1b2c3.jsonl`)).toEqual({ session_id: sid, agent_id: 'a1b2c3' });
    expect(sessionOfFile('/root/notes.jsonl')).toBeNull();
    expect(sessionOfFile(`/x/${sid}/subagents/agent-../../etc.jsonl`)).toBeNull();
    expect(sessionOfFile(null)).toBeNull();
  });
});

describe('readJsonlFiltered', () => {
  it('keeps only the rows whose head passes, across 4 MiB chunk borders, and never parses the others', () => {
    const pad = (n: number) => 'x'.repeat(n);
    const lines = [
      JSON.stringify({ kind: 'session_tree', session_id: 's', title: 't' }),
      // Lines of 3 MB each, so several fall across a chunk border.
      ...Array.from({ length: 5 }, (_, i) => JSON.stringify({ kind: 'run', agent_id: i % 2 === 0 ? 'keep' : 'drop', session_id: 's', i, spans: pad(3_000_000) })),
      '{not json, and dropped by its head: "agent_id":"drop"',
      JSON.stringify({ kind: 'run', agent_id: 'keep', session_id: 's', i: 99 }),
    ];
    const file = join(dir, 'big.jsonl');
    writeFileSync(file, lines.join('\n'));
    const rows = readJsonlFiltered(file, (h) => /"kind":"session_tree"/.test(h) || /"agent_id":"keep"/.test(h));
    expect(rows.map((r) => r.kind)).toEqual(['session_tree', 'run', 'run', 'run', 'run']);
    expect(rows.filter((r) => r.kind === 'run').map((r) => r.i)).toEqual([0, 2, 4, 99]);
    expect((rows[1]!.spans as string).length).toBe(3_000_000);
  });
});

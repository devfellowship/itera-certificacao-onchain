import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARTIFACT_MAX_FILE_BYTES, ARTIFACT_MAX_RUN_BYTES, REDACTED } from '@itera/contracts/run-artifacts';
import { buildResultArtifact, collectRunArtifacts, RESULT_RESERVE_BYTES, scrubResultText, truncateAtLine } from './run-artifacts.js';
import { changedAgainstBaseline, commitBaseline } from './workspace.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
/** A real 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef';

/** Copy filter that drops `<dir>/.git` (the baseline repository) but keeps `.gitignore`. */
const notGitDir = (dir: string) => (src: string) => src !== join(dir, '.git') && !src.startsWith(`${join(dir, '.git')}/`);

/** A temp baseline repository (src/a.ts + package.json) and a copy of it as the agent's tree. */
async function workspace(): Promise<{ baselineDir: string; agentTree: string }> {
  const root = await mkdtemp(join(tmpdir(), 'itera-artifacts-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const baselineDir = join(root, 'workspace');
  await mkdir(join(baselineDir, 'src'), { recursive: true });
  await writeFile(join(baselineDir, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(baselineDir, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(join(baselineDir, 'README.md'), '# fixture\n');
  await commitBaseline(baselineDir);
  const agentTree = join(root, 'agent-out');
  await cp(baselineDir, agentTree, { recursive: true, filter: notGitDir(baselineDir) });
  return { baselineDir, agentTree };
}

const write = async (tree: string, rel: string, content: string | Buffer) => {
  await mkdir(join(tree, rel, '..'), { recursive: true });
  await writeFile(join(tree, rel), content);
};

describe('changedAgainstBaseline', () => {
  it('lists the added and modified files, not the unchanged ones, not a deletion, not node_modules', async () => {
    const { baselineDir, agentTree } = await workspace();
    await write(agentTree, 'src/a.ts', 'export const a = 2;\n');
    await write(agentTree, 'src/new.ts', 'x');
    await write(agentTree, 'node_modules/x/index.json', '{}');
    await rm(join(agentTree, 'README.md'));
    const changed = await changedAgainstBaseline(baselineDir, agentTree);
    expect(changed.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'A', path: 'src/new.ts' },
    ]);
  });
});

describe('collectRunArtifacts', () => {
  it('stores exactly the allowlisted added/modified files, skips the rest with a reason, and never sees .env or node_modules', async () => {
    const { baselineDir, agentTree } = await workspace();
    const html = `<html><body>report for ${KEY}</body></html>\n`;
    await write(agentTree, 'out/report.html', html);
    await write(agentTree, 'out/result.json', '{"ok":true}\n');
    await write(agentTree, 'out/chart.png', PNG);
    await write(agentTree, 'notes.md', '# notes\n');
    await write(agentTree, '.env', 'SECRET=1\n');
    await write(agentTree, 'node_modules/x/index.json', '{}\n');
    await write(agentTree, 'big.json', `{"pad":"${'x'.repeat(600 * 1024)}"}\n`);
    await write(agentTree, 'script.sh', 'echo hi\n');
    await write(agentTree, 'src/a.ts', 'export const a = 2;\n');
    await write(agentTree, 'sub/.hidden/x.json', '{}\n');
    await write(agentTree, 'bin.txt', Buffer.from([0xff, 0xfe, 0x00, 0xc3]));
    await symlink(join(agentTree, 'notes.md'), join(agentTree, 'link.md'));

    const { artifacts, skipped } = await collectRunArtifacts({ baselineDir, agentTree, events: '', stderrTail: '', modelKey: KEY });

    expect(artifacts.map((a) => a.path)).toEqual(['files/notes.md', 'files/out/chart.png', 'files/out/report.html', 'files/out/result.json']);
    const png = artifacts.find((a) => a.path === 'files/out/chart.png')!;
    expect(png).toEqual({ path: 'files/out/chart.png', content: PNG.toString('base64'), encoding: 'base64', sha256: sha(PNG), bytes: PNG.length });
    const report = artifacts.find((a) => a.path === 'files/out/report.html')!;
    expect(report.content).toBe(html.replace(KEY, REDACTED));
    expect(report).toMatchObject({ encoding: 'utf-8', sha256: sha(report.content), bytes: Buffer.byteLength(report.content) });
    expect(artifacts.find((a) => a.path === 'files/notes.md')).toMatchObject({ content: '# notes\n', encoding: 'utf-8', bytes: 8 });

    expect(skipped).toEqual([
      { path: 'files/big.json', reason: 'too_large' },
      { path: 'files/bin.txt', reason: 'not_utf8' },
      { path: 'files/link.md', reason: 'symlink' },
      { path: 'files/script.sh', reason: 'not_allowed' },
      { path: 'files/src/a.ts', reason: 'not_allowed' },
    ]);
    const all = JSON.stringify({ artifacts, skipped });
    expect(all).not.toContain('.env');
    expect(all).not.toContain('node_modules');
    expect(all).not.toContain('.hidden');
    expect(all).not.toContain(KEY);
  });

  it('stores the stderr tail and the trace in front, redacts the model key in them, and cuts the trace at a line boundary', async () => {
    const { baselineDir, agentTree } = await workspace();
    const line = (i: number) => JSON.stringify({ type: 'text', i, text: `step ${i} with ${KEY}` });
    const events = Array.from({ length: 200 }, (_, i) => line(i)).join('\n') + '\n';
    const cap = 4000;
    const { artifacts, skipped } = await collectRunArtifacts({ baselineDir, agentTree, events, stderrTail: `warn: ${KEY}\n`, modelKey: KEY, maxFileBytes: cap });
    expect(skipped).toEqual([]);
    expect(artifacts.map((a) => a.path)).toEqual(['agent/stderr.txt', 'agent/trace.jsonl']);
    expect(artifacts[0]!.content).toBe(`warn: ${REDACTED}\n`);
    const trace = artifacts[1]!;
    expect(trace.bytes).toBeLessThanOrEqual(cap);
    expect(trace.content).not.toContain(KEY);
    const lines = trace.content.split('\n');
    expect(lines[lines.length - 1]).toBe('');
    const marker = JSON.parse(lines[lines.length - 2]!);
    expect(marker).toMatchObject({ truncated: true });
    expect(marker.droppedBytes).toBeGreaterThan(0);
    // every kept line is a whole redacted event, in order
    const kept = lines.slice(0, -2).map((l) => JSON.parse(l));
    expect(kept.length).toBeGreaterThan(5);
    kept.forEach((e, i) => expect(e).toEqual({ type: 'text', i, text: `step ${i} with ${REDACTED}` }));
    const redactedEvents = events.split(KEY).join(REDACTED);
    expect(marker.droppedBytes).toBe(Buffer.byteLength(redactedEvents) - Buffer.byteLength(lines.slice(0, -2).join('\n') + '\n'));
  });

  it('a trace under the cap is stored whole, and an empty stderr tail is not stored', async () => {
    const { baselineDir, agentTree } = await workspace();
    const { artifacts } = await collectRunArtifacts({ baselineDir, agentTree, events: '{"type":"step"}\n', stderrTail: '   ', modelKey: KEY });
    expect(artifacts).toEqual([{ path: 'agent/trace.jsonl', content: '{"type":"step"}\n', encoding: 'utf-8', sha256: sha('{"type":"step"}\n'), bytes: 16 }]);
  });

  it('the run cap stops at 2 MiB in priority order: stderr, trace, then files in path order', async () => {
    const { baselineDir, agentTree } = await workspace();
    const chunk = 'y'.repeat(500 * 1024);
    for (const n of ['a', 'b', 'c', 'd', 'e']) await write(agentTree, `out/${n}.txt`, chunk);
    const { artifacts, skipped } = await collectRunArtifacts({ baselineDir, agentTree, events: '{"type":"step"}\n', stderrTail: 'warn\n', modelKey: KEY });
    expect(artifacts.map((a) => a.path)).toEqual(['agent/stderr.txt', 'agent/trace.jsonl', 'files/out/a.txt', 'files/out/b.txt', 'files/out/c.txt']);
    const total = artifacts.reduce((s, a) => s + a.bytes, 0);
    expect(total + RESULT_RESERVE_BYTES).toBeLessThanOrEqual(ARTIFACT_MAX_RUN_BYTES);
    expect(total + RESULT_RESERVE_BYTES + 500 * 1024).toBeGreaterThan(ARTIFACT_MAX_RUN_BYTES);
    expect(skipped).toEqual([
      { path: 'files/out/d.txt', reason: 'run_cap' },
      { path: 'files/out/e.txt', reason: 'run_cap' },
    ]);
  });

  it('the count cap keeps 24 agent artifacts (25 minus the result.json reserve)', async () => {
    const { baselineDir, agentTree } = await workspace();
    for (let i = 0; i < 30; i++) await write(agentTree, `n${String(i).padStart(2, '0')}.txt`, `${i}\n`);
    const { artifacts, skipped } = await collectRunArtifacts({ baselineDir, agentTree, events: '', stderrTail: '', modelKey: KEY });
    expect(artifacts).toHaveLength(24);
    expect(artifacts[0]!.path).toBe('files/n00.txt');
    expect(artifacts[23]!.path).toBe('files/n23.txt');
    expect(skipped.map((s) => s.path)).toEqual(['files/n24.txt', 'files/n25.txt', 'files/n26.txt', 'files/n27.txt', 'files/n28.txt', 'files/n29.txt']);
    expect(skipped.every((s) => s.reason === 'run_cap')).toBe(true);
  });

  it('a file exactly at the per-file cap is stored; one byte over is skipped', async () => {
    const { baselineDir, agentTree } = await workspace();
    await write(agentTree, 'at.txt', 'z'.repeat(ARTIFACT_MAX_FILE_BYTES));
    await write(agentTree, 'over.txt', 'z'.repeat(ARTIFACT_MAX_FILE_BYTES + 1));
    const { artifacts, skipped } = await collectRunArtifacts({ baselineDir, agentTree, events: '', stderrTail: '', modelKey: KEY });
    expect(artifacts.map((a) => a.path)).toEqual(['files/at.txt']);
    expect(skipped).toEqual([{ path: 'files/over.txt', reason: 'too_large' }]);
  });
});

describe('truncateAtLine', () => {
  it('returns the text unchanged when it fits', () => {
    expect(truncateAtLine('a\nb\n', 100)).toBe('a\nb\n');
  });
  it('keeps whole lines, appends the marker, and stays under the cap', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n') + '\n';
    const out = truncateAtLine(text, 120);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(120);
    const lines = out.split('\n');
    expect(lines.at(-1)).toBe('');
    expect(JSON.parse(lines.at(-2)!)).toEqual({ truncated: true, droppedBytes: Buffer.byteLength(text) - Buffer.byteLength(lines.slice(0, -2).join('\n') + '\n') });
    for (const l of lines.slice(0, -2)) expect(l).toMatch(/^line-\d+$/);
  });
  it('keeps nothing but the marker when the first line alone is over the cap', () => {
    const out = truncateAtLine('x'.repeat(500) + '\nshort\n', 100);
    expect(out).toBe(`${JSON.stringify({ truncated: true, droppedBytes: 507 })}\n`);
  });
});

describe('buildResultArtifact', () => {
  it('writes tma-run-result/1 with the outcome, no key, no path, no hidden test name', () => {
    const a = buildResultArtifact({
      status: 'infra_error', phase: 'done', scoreTotal: 0, error: `hidden/idempotency.test.ts failed at /tmp/itera-run-abc/fixture/src/ledger.ts:12 with ${KEY}`,
      model: 'qwen/qwen3-coder', route: 'openrouter', agent: { exitCode: 1, timedOut: false, durationMs: 10, agentErrors: ['opencode exited with code 1'] },
      cost: { costUsd: 0.01, tokensIn: 100, tokensOut: 10 }, skipped: [{ path: 'files/big.json', reason: 'too_large' }], secrets: [KEY],
    });
    expect(a.path).toBe('result.json');
    expect(a.encoding).toBe('utf-8');
    expect(a.sha256).toBe(sha(a.content));
    expect(a.bytes).toBe(Buffer.byteLength(a.content));
    expect(JSON.parse(a.content)).toEqual({
      format: 'tma-run-result/1', status: 'infra_error', phase: 'done', scoreTotal: 0,
      error: `<hidden-test> failed at <tmp>:12 with ${REDACTED}`,
      model: 'qwen/qwen3-coder', route: 'openrouter',
      agent: { exitCode: 1, timedOut: false, durationMs: 10, errors: ['opencode exited with code 1'] },
      cost: { usd: 0.01, tokensIn: 100, tokensOut: 10 },
      skipped: [{ path: 'files/big.json', reason: 'too_large' }],
    });
  });
  it('bounds the skipped list so result.json fits its reserve', () => {
    const skipped = Array.from({ length: 5000 }, (_, i) => ({ path: `files/${'p'.repeat(150)}/${i}.txt`, reason: 'run_cap' as const }));
    const a = buildResultArtifact({ status: 'pass', phase: 'done', scoreTotal: 100, error: null, model: 'm', route: 'openrouter', agent: null, cost: null, skipped });
    expect(JSON.parse(a.content).skipped).toHaveLength(200);
    expect(a.bytes).toBeLessThan(RESULT_RESERVE_BYTES);
  });
  it('scrubResultText leaves a plain error alone', () => {
    expect(scrubResultText('grading failed: grader output is not JSON')).toBe('grading failed: grader output is not JSON');
  });
});

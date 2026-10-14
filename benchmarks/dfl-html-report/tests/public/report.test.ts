// Public checks: file shape only, no browser. The hidden suite renders the page and checks the data.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = existsSync('out/report.html') ? readFileSync('out/report.html') : null;

describe('out/report.html and out/result.json exist and have the right shape', () => {
  it('out/report.html exists and is at most 1 MB', () => {
    expect(html).not.toBeNull();
    expect(html!.length).toBeLessThanOrEqual(1024 * 1024);
  });
  it('starts with <!doctype html> and declares utf-8 in the first 1024 bytes', () => {
    const head = (html ?? Buffer.alloc(0)).subarray(0, 1024).toString('utf-8');
    expect(head.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(/<meta\s+charset=["']?utf-8["']?\s*\/?>/i.test(head)).toBe(true);
  });
  it('out/result.json has a url and a sha256', () => {
    const r = JSON.parse(readFileSync('out/result.json', 'utf-8'));
    expect(typeof r.url).toBe('string');
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

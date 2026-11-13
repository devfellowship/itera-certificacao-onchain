import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const questions = JSON.parse(readFileSync('data/questions.json', 'utf-8')).questions as { id: string }[];
const raw = existsSync('out/answers.json') ? readFileSync('out/answers.json', 'utf-8') : null;

describe('out/answers.json has the right shape', () => {
  it('exists and is valid JSON with an answers array', () => {
    expect(raw).not.toBeNull();
    expect(Array.isArray(JSON.parse(raw!).answers)).toBe(true);
  });
  it('has one answer per question, each "path:line" with an existing file', () => {
    const answers = JSON.parse(raw ?? '{"answers":[]}').answers as { id: string; answer: string }[];
    expect(answers.map((a) => a.id).sort()).toEqual(questions.map((q) => q.id).sort());
    for (const a of answers) {
      const m = /^(.+):(\d+)$/.exec(a.answer);
      expect(m, a.id).not.toBeNull();
      expect(existsSync(`repo/${m![1].replace(/^repo\//, '')}`), a.id).toBe(true);
    }
  });
});

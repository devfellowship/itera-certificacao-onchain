// Tests of the judge text fold (plan 20261112-tma-c6-judge-calibration, task C6-FOLD). No model call, no network.
// The fixtures in test/judge-text/ are SYNTHETIC sessions with the event shapes of the real review queue (make-fixtures.py
// writes them; no line of a real session is in them). labels.json holds the hand-labelled decisive events of each one.
// Mutation proof (each line, applied alone, turns a test red):
//   rubricKind: delete the POLL line                                   (async-poll-fail and async-many-polls lose polls)
//   rubricKind: delete the `e.retryOf !== null` line                   (block-blind-retry-fail loses a retry)
//   parseSessionLines: drop the queued_command branch AND the wake msg  (async-watcher-pass loses its wake)
//   foldAttempt: `if (total + delta > room)` -> `if (false)`           (every fold is over the budget)
//   marker: count `b - a - 1`                                          (the poll count no longer adds up to 120)
//   foldAttempt: order `rest` before `rubric`                          (decisive events are elided first)
//   makeModelJudgeFn: delete the maxPromptBytes check                  (an oversize prompt reaches the node)
import { readFileSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealPin } from '@itera/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { CliError } from '../env.js';
import {
  ALIEN01_MAX_TEXT_CHARS,
  ALIEN01_RELAY_PROMPT_MAX_BYTES,
  alien01Complete,
  alien01TextBudget,
  judgePromptBytes,
  makeModelJudgeFn,
  type RunInfer,
} from '../eval/judge-runner.js';
import { cut, FOLD_MIN_BUDGET, foldJudgeText, normalizeText, parseSessionLines, rubricKind, spreadOrder, type FoldJudge, type FoldStep } from '../eval/judge-text.js';
import { REVIEW_BATCH_FORMAT } from '../eval/review-batch.js';
import { captureIo } from '../test/fixtures.js';
import { makeEvalCommand } from './eval.js';

const DIR = join(import.meta.dirname, '..', 'test', 'judge-text');
const lines = (name: string) => readFileSync(join(DIR, `${name}.jsonl`), 'utf-8').split('\n');
interface Label {
  judge: FoldJudge;
  verdict: 'pass' | 'fail';
  decisive: Array<{ seq?: number; text?: string; why: string }>;
  counts?: Record<string, number>;
}
const LABELS = JSON.parse(readFileSync(join(DIR, 'labels.json'), 'utf-8')) as Record<string, Label>;
const BUDGET = ALIEN01_MAX_TEXT_CHARS;
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The golden digests: same fixture + judge + budget => the same bytes (the fold reads no clock and no env). */
const GOLDEN: Record<string, string> = {
  'async-poll-fail': 'ad00ce72556f23778da62deee5f1ab7ea7422456bab9b48976bed31823318fe7',
  'async-watcher-pass': '4e0ca7a6657c3416f060f1e63188408003211bd49b4bfe34e92f57f9ba3a8d0b',
  'async-many-polls': '12a42214477a42e5974b52b56b5361eff7c264936ce86f755b896be36a8a0605',
  'block-blind-retry-fail': 'b65a96dd742534a0b7d571df99513988d8b4262f9c07555455554591fd8919b5',
  'block-reported-pass': '28e7e48b5c47164bcdc3b7392259300d19e100ddc44fb23829516758e9e7c2ae',
};

describe('the fold fits the relay', () => {
  it('every fixture folds to at most the budget, and each fixture is longer than the budget before the fold', () => {
    for (const [name, lab] of Object.entries(LABELS)) {
      const raw = lines(name).join('\n');
      expect(bytes(raw), name).toBeGreaterThan(BUDGET * 5);
      const f = foldJudgeText(lines(name), lab.judge, BUDGET);
      expect(f.bytes, name).toBeLessThanOrEqual(BUDGET);
      expect(f.text.length, name).toBeLessThanOrEqual(ALIEN01_MAX_TEXT_CHARS);
      expect(f.events, name).toBeGreaterThan(f.kept);
    }
  });
  it('the budget is the relay limit minus the frame, never over ALIEN01_MAX_TEXT_CHARS; frame + budget <= 12,288 bytes', () => {
    const shortRubric = 'Fail when a wait has no watcher.';
    expect(alien01TextBudget(shortRubric)).toBe(ALIEN01_MAX_TEXT_CHARS);
    const longRubric = 'r'.repeat(8000);
    const b = alien01TextBudget(longRubric);
    expect(b).toBeLessThan(ALIEN01_MAX_TEXT_CHARS);
    expect(judgePromptBytes(longRubric, '', 'x'.repeat(b))).toBe(ALIEN01_RELAY_PROMPT_MAX_BYTES);
    expect(judgePromptBytes(longRubric, '', 'x'.repeat(b + 1))).toBe(ALIEN01_RELAY_PROMPT_MAX_BYTES + 1);
  });
  it('a budget near the floor still holds: the text never passes it', () => {
    for (const [name, lab] of Object.entries(LABELS)) {
      for (const b of [FOLD_MIN_BUDGET, 1500, 3000]) expect(foldJudgeText(lines(name), lab.judge, b).bytes, `${name} ${b}`).toBeLessThanOrEqual(b);
    }
  });
  it('fails closed: an unknown judge or a budget under the floor is an error', () => {
    expect(() => foldJudgeText(lines('async-poll-fail'), 'code-quality' as FoldJudge, BUDGET)).toThrow(/no fold profile/);
    expect(() => foldJudgeText(lines('async-poll-fail'), 'async-wait-lifecycle', FOLD_MIN_BUDGET - 1)).toThrow(/at least/);
  });
});

describe('the fold is deterministic', () => {
  it('the same input gives the same bytes and the golden digest', () => {
    for (const [name, lab] of Object.entries(LABELS)) {
      const a = foldJudgeText(lines(name), lab.judge, BUDGET);
      const b = foldJudgeText(lines(name), lab.judge, BUDGET);
      expect(b.text, name).toBe(a.text);
      expect(a.sha256, name).toBe(GOLDEN[name]);
    }
  });
});

describe('the decisive events of each rubric survive the fold (hand-labelled fixtures)', () => {
  for (const [name, lab] of Object.entries(LABELS)) {
    it(`${lab.judge}: ${name} (${lab.verdict})`, () => {
      const f = foldJudgeText(lines(name), lab.judge, BUDGET);
      for (const d of lab.decisive) {
        if (d.seq !== undefined) {
          expect(f.keptSeqs, `${name}: #${d.seq} (${d.why})`).toContain(d.seq);
          expect(f.text, `${name}: #${d.seq}`).toMatch(new RegExp(`^#${d.seq} `, 'm'));
        } else expect(f.text, `${name}: ${d.why}`).toContain(d.text!);
      }
    });
  }
  it('each judge has a pass and a fail fixture', () => {
    for (const judge of ['async-wait-lifecycle', 'external-block-handling']) {
      const v = Object.values(LABELS).filter((l) => l.judge === judge).map((l) => l.verdict);
      expect(v, judge).toContain('pass');
      expect(v, judge).toContain('fail');
    }
  });
  it('an elided rubric event is still counted: kept poll lines + the wait* counts of the markers = every poll', () => {
    for (const [name, lab] of Object.entries(LABELS)) {
      if (!lab.counts) continue;
      const f = foldJudgeText(lines(name), lab.judge, BUDGET);
      const kept = f.text.split('\n').filter((l) => /^#\d+ .* Bash .*\bsleep \d/.test(l)).length;
      const elided = [...f.text.matchAll(/\[… \d+ elided: [^\]]*?\bwait\* (\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
      expect(kept + elided, name).toBe(lab.counts['wait*']);
      if (name === 'async-many-polls') expect(elided, 'some polls are folded').toBeGreaterThan(0);
    }
  });
  it('the run with a watcher shows the end of turn BEFORE the wake, and the wake names its step', () => {
    const f = foldJudgeText(lines('async-watcher-pass'), 'async-wait-lifecycle', BUDGET);
    const end = f.text.indexOf('-- the agent ends its turn --');
    const wake = f.text.indexOf('wake of #');
    expect(end).toBeGreaterThan(0);
    expect(wake).toBeGreaterThan(end);
    expect(f.text).toMatch(/^#\d+ \S+ Bash\[bg\] bash watch-pr\.sh/m);
  });
  it('the retries of the blind-retry run say which step they repeat', () => {
    const f = foldJudgeText(lines('block-blind-retry-fail'), 'external-block-handling', BUDGET);
    expect((f.text.match(/=> exit 137.*\(retry of #\d+\)/g) ?? []).length).toBe(4);
    expect(f.text).toContain('out of memory');
    // The block rubric names a retry as its own kind; the async rubric does not name a test run at all.
    const steps = parseSessionLines(lines('block-blind-retry-fail')).events.filter((e): e is FoldStep => e.kind === 'step' && e.retryOf !== null && e.exit === 137);
    expect(steps).toHaveLength(4);
    for (const st of steps) {
      expect(rubricKind('external-block-handling', st)).toBe('retry');
      expect(rubricKind('async-wait-lifecycle', st)).toBeNull();
    }
  });
});

describe('the session reader', () => {
  it('a skill body is not the task and not a message; a wake is counted once', () => {
    const p = parseSessionLines(lines('async-poll-fail'));
    expect(p.task.startsWith('You are a lane of the orchestrator')).toBe(true);
    expect(p.events.some((e) => e.kind === 'msg')).toBe(false);
    const w = parseSessionLines(lines('async-watcher-pass'));
    expect(w.events.filter((e) => e.kind === 'wake')).toHaveLength(1);
  });
  it('normalizeText drops a credential shape and shortens a deep path; cut keeps the limit', () => {
    const t = normalizeText('curl -H "x: ghp_abcdefghijklmnopqrstuv" token=abc123 /home/u/a/b/c/file.txt');
    expect(t).not.toContain('ghp_abcdefghijklmnopqrstuv');
    expect(t).not.toContain('abc123');
    expect(t).toContain('…/c/file.txt');
    expect(cut('abcdef', 4)).toBe('abc…');
  });
  it('spreadOrder: first, last, then middles; every index once', () => {
    expect(spreadOrder(5)).toEqual([0, 4, 2, 1, 3]);
    expect([...spreadOrder(37)].sort((a, b) => a - b)).toEqual([...Array(37).keys()]);
  });
});

describe('the runner refuses a prompt over the relay limit', () => {
  it('before the call and before the cap is spent', async () => {
    let ran = 0;
    const run: RunInfer = async () => { ran += 1; return { code: 0, stdout: '{"verdict":"pass"}' }; };
    const m = makeModelJudgeFn({
      complete: alien01Complete({ command: 'c', baseEnv: {}, run }),
      loadText: async () => 'short text',
      config: { enabled: true, maxCalls: 5, note: null, provider: 'alien01' },
      maxTextChars: ALIEN01_MAX_TEXT_CHARS,
      maxPromptBytes: ALIEN01_RELAY_PROMPT_MAX_BYTES,
    });
    const a = await m.judgeFn({ rubric: 'r'.repeat(ALIEN01_RELAY_PROMPT_MAX_BYTES), expected: '', outputHandle: 'r1', model: 'ollama/gemma4:12b' });
    expect(a).toMatchObject({ infra_ok: false });
    expect(a.reason).toContain('judge_prompt_too_large');
    expect(ran).toBe(0);
    expect(m.budget.used).toBe(0);
    const ok = await m.judgeFn({ rubric: 'Fail when a wait has no watcher.', expected: '', outputHandle: 'r1', model: 'ollama/gemma4:12b' });
    expect(ok).toMatchObject({ infra_ok: true, pass: true });
    expect(ran).toBe(1);
  });
});

describe('tma eval judge texts', () => {
  const H = (c: string) => c.repeat(64);
  const G = (c: string) => c.repeat(40);
  function pin(): Record<string, any> {
    return sealPin({
      format: 'tma-pin/1', repo: 'devfellowship/dfl-example', base_sha: G('a'), harness: 'claude-code', harness_version: '2.1.87',
      harness_repo_sha: G('b'), rules_sha256: H('c'), skills_sha256: [H('1')], model_id: 'claude-opus-5-5', mcp_manifest_sha256: H('d'), input_sha256: H('f'),
      completeness: {
        repo: 'exact', base_sha: 'derived', harness: 'exact', harness_version: 'exact', harness_repo_sha: 'derived', rules_sha256: 'derived',
        skills_sha256: 'derived', model_id: 'derived', mcp_manifest_sha256: 'derived', input_sha256: 'exact',
      },
    });
  }
  const RUN_A = '11111111-1111-4111-8111-111111111111';
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'tma-judge-texts-'));
    made.push(root);
    const jd = join(root, 'judges', 'async-wait-lifecycle', '0.1.0');
    mkdirSync(jd, { recursive: true });
    writeFileSync(join(jd, 'prompt.md'), 'You are a binary judge.\n\n{{rubric}}\n');
    writeFileSync(join(jd, 'rubric.md'), '# rubric\n\n## Criterion\n\nThe run waits with a watcher.\n');
    const p = pin();
    const rows = ['async-poll-fail', 'async-watcher-pass'].map((name, i) => ({
      schema: REVIEW_BATCH_FORMAT, case_key: `trace-fixture-${i}`, use_case: 'build/feature', task_ref: { kind: 'dfl-task', id: `task-fixture-${i}` },
      task_label: null, pin: { pin_sha256: p.pin_sha256, record: p }, session_file: join(DIR, `${name}.jsonl`), task_summary: null,
    }));
    writeFileSync(join(root, 'batch.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(root, 'labels.jsonl'), JSON.stringify({ judge_id: 'async-wait-lifecycle', run_id: RUN_A, case_key: 'trace-fixture-1', label: 'pass' }) + '\n');
    return root;
  }
  const run = async (args: string[]) => {
    const io = captureIo();
    const code = await makeEvalCommand().main(['judge', 'texts', ...args], io).catch((e) => {
      if (e instanceof CliError) {
        io.err(e.message);
        return 1;
      }
      throw e;
    });
    return { code, out: io.outText(), err: io.errText() };
  };

  it('writes one private text per labeled run, named by the run id; prints counts and digests only', async () => {
    const root = setup();
    const out = join(root, 'texts');
    const base = ['--judge', 'async-wait-lifecycle', '--version', '0.1.0', '--repo', root, '--batch', join(root, 'batch.jsonl'), '--out', out];
    const r = await run([...base, '--labels', join(root, 'labels.jsonl')]);
    expect(r.code, r.err).toBe(0);
    expect(readdirSync(out)).toEqual([`${RUN_A}.txt`]);
    expect(statSync(out).mode & 0o777).toBe(0o700);
    expect(statSync(join(out, `${RUN_A}.txt`)).mode & 0o777).toBe(0o600);
    expect(r.out).toContain('1 written, 1 row(s) with no labeled run, 0 unreadable');
    expect(r.out).toContain(`budget ${ALIEN01_MAX_TEXT_CHARS} bytes per text`);
    expect(r.out).not.toContain('watch-pr.sh');
    expect(r.out).not.toContain('cursor');
    const text = readFileSync(join(out, `${RUN_A}.txt`), 'utf-8');
    expect(bytes(text)).toBeLessThanOrEqual(ALIEN01_MAX_TEXT_CHARS);
    expect(text).toContain('wake of #');
    // Same input, same set digest.
    const again = await run([...base, '--labels', join(root, 'labels.jsonl')]);
    expect(again.out.match(/set digest: [0-9a-f]{64}/)![0]).toBe(r.out.match(/set digest: [0-9a-f]{64}/)![0]);
  });
  it('without --labels names each text by its case key; --budget may only lower the budget; an unknown judge is refused', async () => {
    const root = setup();
    const out = join(root, 'by-case');
    const base = ['--version', '0.1.0', '--repo', root, '--batch', join(root, 'batch.jsonl'), '--out', out];
    const r = await run(['--judge', 'async-wait-lifecycle', ...base, '--budget', '3000']);
    expect(r.code, r.err).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['trace-fixture-0.txt', 'trace-fixture-1.txt']);
    for (const f of readdirSync(out)) expect(bytes(readFileSync(join(out, f), 'utf-8'))).toBeLessThanOrEqual(3000);
    expect((await run(['--judge', 'async-wait-lifecycle', ...base, '--budget', '99999'])).err).toContain('--budget must be');
    expect((await run(['--judge', 'code-quality', ...base])).err).toContain('no fold profile');
  });
});

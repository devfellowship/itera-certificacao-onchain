// Tests of `tma eval grade --dry-run`, `tma eval grader prove` and `tma eval judge calibrate` (plan C3 T11).
// Docker never runs (the grader and the sandbox are fakes), no model is called (the JudgeFn is a fake),
// and the network is a fake fetch. git and node are real.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { EvidenceManifest } from '../../../../evaluator/src/types.js';
import { EVALUATOR_VERSION } from '../../../../evaluator/src/runner.js';
import { defaultSandboxConfig } from '../../sandbox.js';
import type { Command } from '../command.js';
import { CliError, sandboxEnv } from '../env.js';
import { calibrationGate, type JudgeFn } from '../eval/judge.js';
import { API, captureIo, tempEnv } from '../test/fixtures.js';
import { makeEvalCommand as makeRaw, type EvalCommandDeps } from './eval.js';

/** As tma.ts runs a command: a CliError is exit 1 with its message on stderr. */
function makeEvalCommand(deps?: EvalCommandDeps): Command {
  const cmd = makeRaw(deps);
  return {
    ...cmd,
    main: async (argv, io) => {
      try {
        return await cmd.main(argv, io);
      } catch (e) {
        if (!(e instanceof CliError)) throw e;
        io.err(e.message);
        return 1;
      }
    },
  };
}

const FIXTURE = join(import.meta.dirname, '..', 'test', 'task-fixture');
const PATCH = 'diff --git a/lib/add.js b/lib/add.js\n--- a/lib/add.js\n+++ b/lib/add.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n';

const made: string[] = [];
const tmp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `tma-c3t11-${name}-`));
  made.push(dir);
  return dir;
};
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const writeJson = (path: string, v: unknown) => (writeFileSync(path, `${JSON.stringify(v, null, 2)}\n`), path);

const manifest = () =>
  ({
    score: { total: 100, public_behavior: 20, hidden_behavior: 50, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5 },
    patch_scope: { allowed: true },
    tests: { public_baseline: { total: 3, passed: 1, failed: 2, state: 'ok' }, public_after_patch: { total: 3, passed: 3, failed: 0, state: 'ok' }, hidden: { total: 4, passed: 4, failed: 0, state: 'ok' } },
    errors: [],
    environment: { executor: { image_id: `sha256:${'a'.repeat(64)}` } },
  }) as unknown as EvidenceManifest;

/** A fake TMA API: GET /evaluations lists the rows, POST adds one. Every call is logged. */
function fakeApi() {
  const rows: unknown[] = [{ id: 'e1' }, { id: 'e2' }];
  const calls: Array<{ method: string; url: string }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url: String(url) });
    if (method === 'POST') rows.push({ id: `e${rows.length + 1}` });
    return new Response(JSON.stringify({ evaluations: rows, count: rows.length }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const count = async () => ((await (await fetchImpl(`${API}/evaluations`)).json()) as { count: number }).count;
  return { fetchImpl, calls, count };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' });

describe('tma eval grade --dry-run (C3 T11)', () => {
  /** A temp git repo that holds a trace_review case folder and its recorded trace, all committed. */
  async function repoWithCase() {
    const repo = tmp('repo');
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'test');
    writeFileSync(join(repo, 'trace.diff'), PATCH);
    const caseFile = writeJson(join(repo, 'case.json'), {
      schema: 'tma-case/1', case_key: 'tiny-add', use_case: 'fix/red-ci', mode: 'trace_review', answer_shape: 'open', pin: null,
      task_ref: { kind: 'tma-task', id: 'task-fixture@3' },
      expected: { text: 'add() returns the sum.', written_by: 'claude-main', written_at: '2026-11-12T18:00:00Z' },
      graders: [{ id: 'hidden-tests', version: EVALUATOR_VERSION, weight: 1, hard_gate: true }], split: 'none', source: 'synthetic',
    });
    const io = captureIo();
    const dir = join(repo, 'case');
    expect(await makeEvalCommand().main(['case', '--case', caseFile, '--dest', dir, '--task-dir', FIXTURE, '--recorded', join(repo, 'trace.diff')], io), io.errText()).toBe(0);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'case');
    return { repo, dir };
  }

  function deps(api: ReturnType<typeof fakeApi>) {
    const graded: string[] = [];
    const d: EvalCommandDeps = {
      env: tempEnv(),
      fetchImpl: api.fetchImpl,
      grade: async (o) => (graded.push(o.patch), manifest()),
      sandbox: async (profile) => ({ config: defaultSandboxConfig(sandboxEnv(profile, {})), imageId: null }),
    };
    return { d, graded };
  }

  it('prints a JSON verdict of the fixture trace; the working tree and the TMA DB do not change', async () => {
    const { repo, dir } = await repoWithCase();
    const api = fakeApi();
    const { d, graded } = deps(api);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    const before = await api.count();
    const callsBefore = api.calls.length;

    const io = captureIo();
    expect(await makeEvalCommand(d).main(['grade', '--case', dir, '--dry-run'], io), io.errText()).toBe(0);
    const verdict = JSON.parse(io.outText());
    expect(verdict).toMatchObject({ format: 'tma-eval-dry-run/1', dry_run: true, case_key: 'tiny-add' });
    expect(verdict.outputs).toHaveLength(1);
    expect(verdict.outputs[0]).toMatchObject({ source: 'recorded', case: { infra_ok: true, pass: true, score: 100 } });
    expect(verdict.outputs[0].graders[0]).toMatchObject({ id: 'hidden-tests', pass: true, decisive: true });
    expect(graded).toEqual([PATCH]);

    // The command made no call at all: only the two GETs of this test reach the API.
    expect(api.calls.length).toBe(callsBefore);
    expect(await api.count()).toBe(before);
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('--trace grades one output file, also read only; the plain grade does write (the check can see a change)', async () => {
    const { repo, dir } = await repoWithCase();
    const api = fakeApi();
    const { d, graded } = deps(api);
    const trace = join(tmp('trace'), 'other.diff');
    writeFileSync(trace, `${PATCH}\n`);
    const io = captureIo();
    expect(await makeEvalCommand(d).main(['grade', '--case', dir, '--dry-run', '--trace', trace], io), io.errText()).toBe(0);
    expect(JSON.parse(io.outText()).outputs[0]).toMatchObject({ source: 'trace', run_id: 'other.diff' });
    expect(graded).toEqual([`${PATCH}\n`]);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(api.calls).toEqual([]);

    const io2 = captureIo();
    expect(await makeEvalCommand(d).main(['grade', '--case', dir, '--trace', trace], io2)).toBe(1);
    expect(io2.errText()).toMatch(/--trace needs --dry-run/);
    expect(await makeEvalCommand(d).main(['grade', '--case', dir], captureIo())).toBe(0);
    expect(git(repo, 'status', '--porcelain')).toMatch(/case\/runs\//);
  });
});

describe('tma eval grader prove (C3 T11)', () => {
  // The grader under test: passes only when fixture/answer.json holds {"value": 42}.
  const GOOD = `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const v = JSON.parse(readFileSync(join(process.argv[2], 'answer.json'), 'utf-8')).value;
console.log('checking the answer');
console.log(JSON.stringify({ pass: v === 42 }));
`;
  const ALWAYS_PASS = `console.log(JSON.stringify({ pass: true }));\n`;
  const CRASH = `process.exit(3);\n`;
  const PLANTED = [41, -42, '42', null, 4.2];

  function graderDir(script: string, withList = false): string {
    const dir = join(tmp('graders'), 'graders', 'answer-is-42', '1.0.0');
    mkdirSync(join(dir, 'fixtures'), { recursive: true });
    writeJson(join(dir, 'grader.json'), { id: 'answer-is-42', version: '1.0.0', kind: 'code', command: [process.execPath, 'grade.mjs'] });
    writeFileSync(join(dir, 'grade.mjs'), script);
    PLANTED.forEach((value, i) => {
      const f = join(dir, 'fixtures', `mutation-${i + 1}`);
      mkdirSync(f);
      writeJson(join(f, 'answer.json'), { value, note: 'PLANTED-BUG-TEXT-MUST-NOT-LEAK' });
      writeJson(join(f, 'expect.json'), { pass: false });
    });
    if (withList) writeJson(join(dir, 'fixtures', 'code-mutations.json'), { mutations: PLANTED.map((_, i) => ({ id: String(i + 1), fixture: `mutation-${i + 1}`, expect: { pass: false } })) });
    return dir;
  }
  const proofOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'proof.json'), 'utf-8'));

  it('a grader that catches its 5 planted bugs writes proof.json with caught 5, total 5 (exit 0)', async () => {
    const dir = graderDir(GOOD);
    const io = captureIo();
    expect(await makeEvalCommand().main(['grader', 'prove', dir], io), io.errText()).toBe(0);
    expect(io.outText()).toMatch(/caught 5 of 5 planted bugs/);
    const p = proofOf(dir);
    expect(p).toMatchObject({ format: 'tma-grader-proof/1', grader: { id: 'answer-is-42', version: '1.0.0' }, caught: 5, total: 5 });
    expect(p.grader.code_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.mutations.map((m: { id: string; caught: boolean; answered_pass: boolean }) => [m.id, m.caught, m.answered_pass])).toEqual(['1', '2', '3', '4', '5'].map((id) => [id, true, false]));
    // ids, counts, digests only: no fixture text, no grader output, no command text.
    const raw = readFileSync(join(dir, 'proof.json'), 'utf-8');
    expect(raw).not.toContain('PLANTED-BUG-TEXT');
    expect(raw).not.toContain('checking the answer');
    expect(raw).not.toContain('grade.mjs');
  });

  it('the always-pass mutation of the grader turns it red: caught 0, exit non-zero', async () => {
    const dir = graderDir(ALWAYS_PASS, true);
    const io = captureIo();
    expect(await makeEvalCommand().main(['grader', 'prove', dir], io)).toBe(1);
    expect(io.outText()).toMatch(/caught 0 of 5/);
    expect(proofOf(dir)).toMatchObject({ caught: 0, total: 5 });
    expect(io.errText()).toMatch(/MISSED \(the grader passed it\)/);
  });

  it('a crash is not a catch; the argv after -- overrides grader.json; --out moves the proof', async () => {
    const dir = graderDir(CRASH);
    expect(await makeEvalCommand().main(['grader', 'prove', dir], captureIo())).toBe(1);
    expect(proofOf(dir)).toMatchObject({ caught: 0, total: 5 });
    expect(proofOf(dir).mutations[0]).toMatchObject({ answered_pass: null, exit_code: 3, caught: false });
    writeFileSync(join(dir, 'good.mjs'), GOOD);
    const out = join(tmp('out'), 'proof.json');
    expect(await makeEvalCommand().main(['grader', 'prove', dir, '--out', out, '--', process.execPath, 'good.mjs'], captureIo())).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf-8'))).toMatchObject({ caught: 5, total: 5 });
  });

  it('refuses a planted bug that expects a pass, and a grader with no planted bug', async () => {
    const dir = graderDir(GOOD);
    writeJson(join(dir, 'fixtures', 'mutation-3', 'expect.json'), { pass: true });
    const io = captureIo();
    expect(await makeEvalCommand().main(['grader', 'prove', dir], io)).toBe(1);
    expect(io.errText()).toMatch(/must expect \{"pass": false\}/);
    const empty = join(tmp('empty'), 'g', '1.0.0');
    mkdirSync(empty, { recursive: true });
    cpSync(join(dir, 'grade.mjs'), join(empty, 'grade.mjs'));
    const io2 = captureIo();
    expect(await makeEvalCommand().main(['grader', 'prove', empty, '--', process.execPath, 'grade.mjs'], io2)).toBe(1);
    expect(io2.errText()).toMatch(/no planted bug/);
  });
});

describe('tma eval grader prove: tma-grader/1 library layout (C3 T11)', () => {
  // Synthetic grader: workdir/answer.txt must contain the word "ok"; no file = infra_error.
  const GRADE = `import argparse, hashlib, json, os, sys
ap = argparse.ArgumentParser()
ap.add_argument('--spec', required=True)
ap.add_argument('--workdir', required=True)
ap.add_argument('--trajectory')
a = ap.parse_args()
def out(status, code):
    print(json.dumps({'schema': 'tma-grader-result/1', 'grader': {'id': 'says-ok', 'semver': '1.0.0', 'code_sha256': 'x'}, 'status': status, 'score': 1.0 if status == 'pass' else 0.0, 'infra_ok': status != 'infra_error', 'checks': []}))
    sys.exit(code)
open(os.path.join(a.workdir, 'scratch.txt'), 'w').write('written')
p = os.path.join(a.workdir, 'answer.txt')
if not os.path.exists(p):
    out('infra_error', 3)
out('pass' if 'ok' in open(p).read().split() else 'fail', 0 if 'ok' in open(p).read().split() else 1)
`;
  const ALWAYS = `import json\nprint(json.dumps({'schema': 'tma-grader-result/1', 'status': 'pass'}))\n`;
  // [name, answer.txt content (null = no file), expected status]
  const MUTS: Array<[string, string | null, 'fail' | 'infra_error']> = [
    ['wrong-word', 'nope', 'fail'],
    ['empty', '', 'fail'],
    ['substring', 'okay', 'fail'],
    ['missing-file', null, 'infra_error'],
    ['upper', 'OK', 'fail'],
  ];

  function fixture(dir: string, name: string, kind: 'reference' | 'mutation', answer: string | null, status: string) {
    const f = join(dir, 'fixtures', name);
    mkdirSync(join(f, 'workdir'), { recursive: true });
    writeJson(join(f, 'fixture.json'), kind === 'reference' ? { kind, expect: { status } } : { kind, proves: 'PLANTED-PROVES-TEXT', expect: { status } });
    writeJson(join(f, 'spec.json'), { note: 'SPEC-TEXT-MUST-NOT-LEAK' });
    if (answer !== null) writeFileSync(join(f, 'workdir', 'answer.txt'), answer);
    writeJson(join(f, 'workdir', 'trajectory.json'), { events: [] });
  }
  function library(script = GRADE, referenceAnswer = 'all ok here'): string {
    const dir = join(tmp('lib'), 'graders', 'says-ok', '1.0.0');
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'grader.json'), { schema: 'tma-grader/1', id: 'says-ok', semver: '1.0.0', kind: 'code', entry: 'grade.py', code_files: ['grade.py'], code_sha256: 'x', description: 'synthetic' });
    writeFileSync(join(dir, 'grade.py'), script);
    fixture(dir, 'reference', 'reference', referenceAnswer, 'pass');
    for (const [n, ans, st] of MUTS) fixture(dir, `mutation-${n}`, 'mutation', ans, st);
    writeJson(join(dir, 'fixtures', 'code-mutations.json'), [{ id: 'c1', file: 'grade.py', find: 'a', replace: 'b' }]);
    return dir;
  }
  const proofOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'proof.json'), 'utf-8'));

  it('caught 5, total 5 with mixed fail / infra_error expectations (exit 0); the checkout is not written', async () => {
    const dir = library();
    const io = captureIo();
    expect(await makeEvalCommand().main(['grader', 'prove', dir], io), io.errText()).toBe(0);
    expect(io.outText()).toMatch(/caught 5 of 5 planted bugs/);
    const p = proofOf(dir);
    expect(p).toMatchObject({ format: 'tma-grader-proof/1', layout: 'tma-grader/1', ok: true, caught: 5, total: 5, grader: { id: 'says-ok', version: '1.0.0' }, reference: { expected_status: 'pass', observed_status: 'pass', passing: true } });
    expect(p.library_mutations.map((m: { id: string; expected_status: string; observed_status: string }) => [m.id, m.expected_status, m.observed_status])).toEqual([
      ['empty', 'fail', 'fail'], ['missing-file', 'infra_error', 'infra_error'], ['substring', 'fail', 'fail'], ['upper', 'fail', 'fail'], ['wrong-word', 'fail', 'fail'],
    ]);
    const raw = readFileSync(join(dir, 'proof.json'), 'utf-8');
    for (const t of ['PLANTED-PROVES-TEXT', 'SPEC-TEXT-MUST-NOT-LEAK', 'grade.py']) expect(raw).not.toContain(t);
    expect(existsSync(join(dir, 'fixtures', 'reference', 'workdir', 'scratch.txt'))).toBe(false);
  });

  it('an always-pass copy of the grader: caught 0, exit non-zero', async () => {
    const dir = library(ALWAYS);
    const io = captureIo();
    expect(await makeEvalCommand().main(['grader', 'prove', dir], io)).toBe(1);
    expect(io.outText()).toMatch(/caught 0 of 5/);
    expect(proofOf(dir)).toMatchObject({ ok: false, reason: 'mutation_missed', caught: 0, total: 5 });
  });

  it('a failing reference makes the proof red with reference_not_passing', async () => {
    const dir = library(GRADE, 'nothing here');
    const io = captureIo();
    expect(await makeEvalCommand().main(['grader', 'prove', dir], io)).toBe(1);
    expect(io.outText()).toMatch(/reference_not_passing/);
    expect(proofOf(dir)).toMatchObject({ ok: false, reason: 'reference_not_passing', reference: { observed_status: 'fail', passing: false }, caught: 5 });
  });

  it('a different non-pass status than expected is a miss', async () => {
    const dir = library();
    writeJson(join(dir, 'fixtures', 'mutation-wrong-word', 'fixture.json'), { kind: 'mutation', proves: 'x', expect: { status: 'infra_error' } });
    const io = captureIo();
    expect(await makeEvalCommand().main(['grader', 'prove', dir], io)).toBe(1);
    const p = proofOf(dir);
    expect(p).toMatchObject({ caught: 4, total: 5, reason: 'mutation_missed' });
    expect(p.library_mutations.find((m: { id: string }) => m.id === 'wrong-word')).toMatchObject({ expected_status: 'infra_error', observed_status: 'fail', caught: false });
  });

  it('refuses a mutation that expects pass, and a library with no mutation fixture', async () => {
    const dir = library();
    writeJson(join(dir, 'fixtures', 'mutation-upper', 'fixture.json'), { kind: 'mutation', expect: { status: 'pass' } });
    const io = captureIo();
    expect(await makeEvalCommand().main(['grader', 'prove', dir], io)).toBe(1);
    expect(io.errText()).toMatch(/must not pass/);
    const none = library();
    for (const [n] of MUTS) rmSync(join(none, 'fixtures', `mutation-${n}`), { recursive: true });
    const io2 = captureIo();
    expect(await makeEvalCommand().main(['grader', 'prove', none], io2)).toBe(1);
    expect(io2.errText()).toMatch(/no planted bug/);
  });
});

describe('tma eval judge calibrate (C3 T11)', () => {
  const RUBRIC = 'RUBRIC-TEXT: fail when the patch edits a file outside lib/.';
  /** An eval repo with sets/calibration/j-scope/{train,dev,test}.jsonl and judges/j-scope/1.0.0/rubric.md. */
  function evalRepo(sizes = { train: 20, dev: 10, test: 86 }): string {
    const repo = tmp('evalrepo');
    const sets = join(repo, 'sets', 'calibration', 'j-scope');
    mkdirSync(sets, { recursive: true });
    let n = 0;
    for (const [split, size] of Object.entries(sizes)) {
      const lines = Array.from({ length: size }, () => {
        n++;
        return JSON.stringify({ id: `item-${n}`, label: n % 3 !== 0 });
      });
      writeFileSync(join(sets, `${split}.jsonl`), `${lines.join('\n')}\n`);
    }
    mkdirSync(join(repo, 'judges', 'j-scope', '1.0.0'), { recursive: true });
    writeFileSync(join(repo, 'judges', 'j-scope', '1.0.0', 'rubric.md'), RUBRIC);
    return repo;
  }
  // The fake judge: right on most items, wrong on every 7th (by id number).
  function fakeJudge() {
    const seen: string[] = [];
    const fn: JudgeFn = async (i) => {
      seen.push(i.outputHandle);
      const n = Number(i.outputHandle.slice('item-'.length));
      const truth = n % 3 !== 0;
      return { infra_ok: true, pass: n % 7 === 0 ? !truth : truth, reason: null };
    };
    return { fn, seen };
  }
  const args = (repo: string, model = 'claude-sonnet-5-5', extra: string[] = []) => ['judge', 'calibrate', '--repo', repo, '--judge', 'j-scope', '--version', '1.0.0', '--model', model, ...extra];
  const calFile = (repo: string) => join(repo, 'judges', 'j-scope', '1.0.0', 'calibration.json');

  it('a split of 86 test labels: tp+fn+tn+fp = 86, calibration.json in the record shape, counts only', async () => {
    const repo = evalRepo();
    const j = fakeJudge();
    const io = captureIo();
    expect(await makeEvalCommand({ judgeFn: j.fn, now: () => new Date('2026-11-13T12:00:00Z') }).main(args(repo), io), io.errText()).toBe(0);
    const c = JSON.parse(readFileSync(calFile(repo), 'utf-8'));
    expect(Object.keys(c).sort()).toEqual(['fn', 'fp', 'n_labels', 'n_test', 'realigned_at', 'tn', 'tp']);
    expect(c.tp + c.fn + c.tn + c.fp).toBe(86);
    expect(c).toMatchObject({ n_labels: 116, n_test: 86, realigned_at: '2026-11-13T12:00:00.000Z' });
    // The judge answered only the test split (ids 31..116).
    expect(j.seen).toHaveLength(86);
    expect(j.seen[0]).toBe('item-31');
    // Expected counts, computed independently.
    let tp = 0, fn = 0, tn = 0, fp = 0;
    for (let n = 31; n <= 116; n++) {
      const truth = n % 3 !== 0;
      const pass = n % 7 === 0 ? !truth : truth;
      if (truth) pass ? tp++ : fn++;
      else pass ? fp++ : tn++;
    }
    expect(c).toMatchObject({ tp, fn, tn, fp });
    // Every 7th answer is wrong, so TPR or TNR falls below 0.90: the record is a side signal, and the command says so.
    expect(calibrationGate(c)).toMatch(/^judge_not_calibrated: /);
    expect(io.outText()).toContain(`gate: side signal only (${calibrationGate(c)})`);
    expect(io.outText()).toMatch(/n_test 86/);
    expect(readFileSync(calFile(repo), 'utf-8')).not.toContain('RUBRIC-TEXT');
  });

  it('refuses a judge model outside the A11 Q1 = B list on a private set (default); --public-set lifts it', async () => {
    const repo = evalRepo();
    const j = fakeJudge();
    const io = captureIo();
    expect(await makeEvalCommand({ judgeFn: j.fn }).main(args(repo, 'openai/gpt-9'), io)).toBe(1);
    expect(io.errText()).toMatch(/judge_model_not_allowed_for_private_text/);
    expect(j.seen).toEqual([]);
    expect(existsSync(calFile(repo))).toBe(false);
    expect(await makeEvalCommand({ judgeFn: j.fn }).main(args(repo, 'ollama/qwen3:14b'), captureIo())).toBe(0);
    rmSync(calFile(repo));
    const io2 = captureIo();
    expect(await makeEvalCommand({ judgeFn: j.fn }).main(args(repo, 'openai/gpt-9', ['--public-set']), io2), io2.errText()).toBe(0);
    expect(JSON.parse(readFileSync(calFile(repo), 'utf-8')).n_test).toBe(86);
  });

  it('writes nothing when the judge does not measure (the default JudgeFn), or when the splits share an item', async () => {
    const repo = evalRepo();
    const io = captureIo();
    expect(await makeEvalCommand().main(args(repo), io)).toBe(1);
    expect(io.errText()).toMatch(/did not measure 86 of 86/);
    expect(existsSync(calFile(repo))).toBe(false);
    writeFileSync(join(repo, 'sets', 'calibration', 'j-scope', 'dev.jsonl'), `${JSON.stringify({ id: 'item-40', label: true })}\n`);
    const io2 = captureIo();
    expect(await makeEvalCommand({ judgeFn: fakeJudge().fn }).main(args(repo), io2)).toBe(1);
    expect(io2.errText()).toMatch(/in both dev and test/);
    writeFileSync(join(repo, 'sets', 'calibration', 'j-scope', 'dev.jsonl'), '{"id":"x","label":"yes"}\n');
    const io3 = captureIo();
    expect(await makeEvalCommand({ judgeFn: fakeJudge().fn }).main(args(repo), io3)).toBe(1);
    expect(io3.errText()).toMatch(/dev.jsonl:1: a label line/);
  });
});

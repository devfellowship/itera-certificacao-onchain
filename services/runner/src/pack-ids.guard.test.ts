// Guard: a pack id IS its bundle folder under benchmarks/ (plan TMA, Q e9dc0ef2 = A, TG 24074: the
// production pack ids were renamed to the folder names and the compatibility alias was removed).
// It goes red when:
//   1. the worker would register a bundle under an id that is not its folder name (curated-packs.ts);
//   2. scenarioDir() maps an id to any folder other than benchmarks/<id>, or an old pack id resolves;
//   3. the runner or evaluator source names a pack id (scenarioId / scenario_id / --task / --scenario /
//      scenarioDir literal) that is not a folder under benchmarks/ or services/runner/test-tasks/,
//      unless it is a listed deliberate negative in its one listed file.
// Mutation proof (PR body): put scenarioId: 'webhook-ledger' back in a test → 3 goes red.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scenarioDir, TaskError } from '../../evaluator/src/task.js';
import { curatedPacks } from './curated-packs.js';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const dirs = (d: string) => readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const bundles = () => dirs(join(repoRoot, 'benchmarks')).filter((f) => existsSync(join(repoRoot, 'benchmarks', f, 'task.json')));
const testTasks = () => dirs(join(repoRoot, 'services', 'runner', 'test-tasks'));

/** Ids that a test names on purpose although no folder has them (refusals and fake scenarios), and the
 *  ONE file where each may appear. The same id anywhere else is red. */
const DELIBERATE_NEGATIVES: Record<string, { file: string; why: string }> = {
  'no-such-task': { file: 'services/runner/src/cli/commands/local.test.ts', why: 'the CLI refuses an unknown --task' },
  'webhook-ledger': { file: 'services/runner/src/cli/commands/local.test.ts', why: 'the CLI refuses an old pack id' },
  Tsk_Webhook_Dup: { file: 'services/runner/src/cli/commands/local.test.ts', why: 'the CLI refuses a slug with capitals' },
  'task-fixture': { file: 'services/runner/src/cli/commands/local.test.ts', why: 'the fixture folder, passed with --task-dir' },
  s: { file: 'services/runner/src/outcome.test.ts', why: 'a fake scenario id (no folder is read)' },
};

/** Every *.ts file under a folder, except node_modules and this guard. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...sources(p)); }
    else if (e.name.endsWith('.ts') && !p.endsWith('pack-ids.guard.test.ts')) out.push(p);
  }
  return out;
}

const REFERENCE = /(?:scenarioId|scenario_id)\s*:\s*['"]([^'"]+)['"]|['"]--(?:task|scenario)['"]\s*,\s*['"]([^'"]+)['"]|scenarioDir\(\s*\w+\s*,\s*['"]([^'"]+)['"]\s*\)/g;

describe('pack ids are bundle folders, with no alias', () => {
  it('1. the worker registers every bundle under its folder name', async () => {
    const { packs, errors } = await curatedPacks(repoRoot);
    expect(errors).toEqual([]);
    expect(packs.map((p) => p.id).sort()).toEqual(bundles().sort());
    for (const p of packs) expect(p.evaluatorRef).toBe(`benchmarks/${p.id}`);
  });

  it('2. scenarioDir(id) is benchmarks/<id>; an old pack id resolves to no folder', () => {
    for (const id of bundles()) {
      const dir = scenarioDir(repoRoot, id);
      expect(dir).toBe(join(repoRoot, 'benchmarks', id));
      expect(statSync(join(dir, 'task.json')).isFile()).toBe(true);
    }
    for (const old of ['webhook-ledger', 'helpdesk-refunds']) expect(existsSync(scenarioDir(repoRoot, old))).toBe(false);
    expect(() => scenarioDir(repoRoot, '../etc')).toThrow(TaskError);
    expect(() => scenarioDir(repoRoot, 'Tsk_X')).toThrow(TaskError);
  });

  it('3. every pack id that the runner and evaluator source names is a folder (or a listed negative)', () => {
    const known = new Set([...bundles(), ...testTasks()]);
    const unknown: string[] = [];
    let seen = 0;
    for (const file of [...sources(join(repoRoot, 'services', 'runner', 'src')), ...sources(join(repoRoot, 'services', 'evaluator', 'src'))]) {
      for (const m of readFileSync(file, 'utf-8').matchAll(REFERENCE)) {
        const id = m[1] ?? m[2] ?? m[3]!;
        if (id.startsWith('-') || !/^[A-Za-z0-9_-]+$/.test(id)) continue; // a flag or a path probe ('../etc'), not an id
        seen++;
        const rel = relative(repoRoot, file);
        if (!known.has(id) && DELIBERATE_NEGATIVES[id]?.file !== rel) unknown.push(`${rel}: ${id}`);
      }
    }
    expect(seen).toBeGreaterThan(10); // the scan finds the references (a broken regex would pass with 0)
    expect(unknown).toEqual([]);
  });
});

// Replaces scripts/check-scenarios.py. Checks every task bundle against the task contract
// (packages/contracts/schemas/task.schema.json, Ajv) and the bundle rules of services/evaluator
// (paths inside the bundle, no symlink, hidden tests protected, lockfile on the npm registry),
// and the planning file benchmarks/scenarios.json (weights total 100, budget parts add up).
// Run: npx tsx scripts/check-tasks.mts
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadTask, readInstruction } from '../services/evaluator/src/task.js';
import { SCORE_WEIGHTS } from '../services/evaluator/src/score.js';

const root = resolve(import.meta.dirname, '..');
const problems: string[] = [];
let checked = 0;

for (const base of ['benchmarks', 'services/runner/test-tasks']) {
  for (const name of await readdir(join(root, base))) {
    const dir = join(root, base, name);
    if (!(await stat(dir)).isDirectory()) continue;
    if (!(await stat(join(dir, 'task.json')).catch(() => null))) {
      if (base === 'benchmarks' && (await stat(join(dir, 'scenario.json')).catch(() => null))) problems.push(`${base}/${name}: scenario.json without task.json`);
      continue;
    }
    try {
      const task = await loadTask(dir);
      const instruction = await readInstruction(task);
      const scenario = await readFile(join(dir, 'scenario.json'), 'utf-8').catch(() => null);
      if (scenario && JSON.parse(scenario).agent_prompt?.trim() !== instruction) {
        problems.push(`${base}/${name}: scenario.json agent_prompt differs from ${task.contract.instruction}`);
      }
      checked++;
    } catch (err) {
      problems.push(`${base}/${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

const plan = JSON.parse(await readFile(join(root, 'benchmarks', 'scenarios.json'), 'utf-8'));
const weights = plan.shared_protocol.score_100 as Record<string, number>;
if (Object.values(weights).reduce((a, b) => a + b, 0) !== 100) problems.push('scenarios.json: score weights do not total 100');
for (const [k, v] of Object.entries(SCORE_WEIGHTS)) if (weights[k] !== v) problems.push(`scenarios.json: weight ${k} differs from services/evaluator/src/score.ts`);
const budget = plan.shared_protocol.runtime_budget_seconds as Record<string, number>;
const parts = Object.entries(budget).filter(([k]) => k !== 'total').reduce((a, [, v]) => a + v, 0);
if (parts !== budget.total) problems.push('scenarios.json: runtime budget total differs from its parts');
const ids = (plan.scenarios as Array<{ id: string }>).map((s) => s.id);
if (new Set(ids).size !== ids.length || ids.some((id) => !/^[a-z0-9-]+$/.test(id))) problems.push('scenarios.json: duplicate or unsafe scenario id');

if (problems.length > 0) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`${checked} task bundle(s) match the task contract; scenarios.json is consistent.`);

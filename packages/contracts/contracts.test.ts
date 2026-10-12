import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateTaskContract } from './index.js';

const ledger = JSON.parse(readFileSync(new URL('../../benchmarks/webhook-ledger/task.json', import.meta.url), 'utf-8'));
const clone = () => structuredClone(ledger);

describe('task.schema.json (Ajv, draft 2020-12)', () => {
  it('accepts the webhook-ledger contract', () => {
    expect(validateTaskContract(ledger)).toMatchObject({ ok: true });
  });
  it('rejects a task.json without verifier.cmd', () => {
    const t = clone();
    delete t.verifier.cmd;
    const r = validateTaskContract(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/cmd/);
  });
  it('rejects unknown keys, absolute and parent paths, and network', () => {
    for (const edit of [
      (t: any) => (t.extra = 1),
      (t: any) => (t.environment.dir = '/etc'),
      (t: any) => (t.tests.hidden = 'tests/../../x'),
      (t: any) => (t.environment.allow_internet = true),
      (t: any) => (t.verifier.timeout_sec = 9999),
      (t: any) => (t.task.name = 'no-org'),
    ]) {
      const t = clone();
      edit(t);
      expect(validateTaskContract(t).ok).toBe(false);
    }
  });
});

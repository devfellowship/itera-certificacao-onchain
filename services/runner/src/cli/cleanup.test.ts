import { describe, expect, it } from 'vitest';
import { belongsTo, nameId, removeRunContainers, trackRun, trackedRuns } from './cleanup.js';
import { newRunId } from './local.js';

describe('signal cleanup of the local runner (L10)', () => {
  it('a new run id is tracked, as the docker name part', () => {
    const id = newRunId();
    expect(trackedRuns()).toContain(nameId(id));
    trackRun('Local-ABC_1');
    expect(trackedRuns()).toContain('local-abc1');
  });

  it('matches only the containers of the given id', () => {
    expect(belongsTo('itera-run-local-1234abcd', 'local-1234abcd')).toBe(true);
    expect(belongsTo('/itera-gw-local-1234abcd', 'local-1234abcd')).toBe(true);
    expect(belongsTo('itera-grade-local-1234abcd-hidden', 'local-1234abcd')).toBe(true);
    expect(belongsTo('itera-mcp-local-1234abcd-helpdesk', 'local-1234abcd')).toBe(true);
    expect(belongsTo('itera-run-local-1234abcdef', 'local-1234abcd')).toBe(false);
    expect(belongsTo('itera-run-local-99999999', 'local-1234abcd')).toBe(false);
    expect(belongsTo('my-own-container-local-1234abcd', 'local-1234abcd')).toBe(false);
  });

  it('removes the matching containers with their volumes, then the run network', async () => {
    const calls: string[][] = [];
    const docker = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'ps') return { code: 0, stdout: 'itera-run-local-aaaa1111\nitera-gw-local-aaaa1111\nitera-run-local-bbbb2222\nsomeone-else\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const removed = await removeRunContainers(['local-aaaa1111'], docker);
    expect(calls[1]).toEqual(['rm', '-f', '-v', 'itera-run-local-aaaa1111', 'itera-gw-local-aaaa1111']);
    expect(calls[2]).toEqual(['network', 'rm', 'itera-sbx-local-aaaa1111']);
    expect(removed).toEqual(['itera-run-local-aaaa1111', 'itera-gw-local-aaaa1111', 'itera-sbx-local-aaaa1111']);
  });

  it('does nothing without a tracked id', async () => {
    const docker = async () => {
      throw new Error('must not call docker');
    };
    expect(await removeRunContainers([], docker)).toEqual([]);
  });
});

describe('exit after a signal', () => {
  it('the normal exit path is not held when no signal came', async () => {
    const { exitAllowed } = await import('./cleanup.js');
    await expect(Promise.race([exitAllowed().then(() => 'free'), new Promise((r) => setTimeout(() => r('held'), 50))])).resolves.toBe('free');
  });
});

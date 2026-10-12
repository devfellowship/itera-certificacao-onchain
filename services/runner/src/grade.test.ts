import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildGraderArgs, GRADER_REPORT, GRADER_UID, stageWorkspace } from './grade.js';
import { defaultSandboxConfig } from './sandbox.js';

const argv = ['npx', 'vitest', 'run', 'tests/hidden', '--reporter=json', '--outputFile={report}'];

describe('buildGraderArgs', () => {
  const args = buildGraderArgs({ name: 'itera-grade-x-hidden', config: defaultSandboxConfig({}), argv });
  const flags = args.join(' ');
  it('has no network, no socket, no worker env, a read-only rootfs and no capabilities', () => {
    expect(args).toEqual(expect.arrayContaining(['--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']));
    expect(flags).not.toMatch(/docker\.sock|-v |--volume|KEY|TOKEN|SECRET|DATABASE_URL|--env-file|--privileged/i);
    // Only anonymous volumes: no host path is mounted.
    for (const m of args.filter((_, i) => args[i - 1] === '--mount')) expect(m).toMatch(/^type=volume,dst=\/(workspace|out)$/);
  });
  it('runs as the grader uid, which is neither root nor the agent uid', () => {
    expect(args).toEqual(expect.arrayContaining(['--user', `${GRADER_UID}:${GRADER_UID}`]));
    expect(GRADER_UID).not.toBe(0);
    expect(GRADER_UID).not.toBe(10001);
  });
  it('sets cpu, memory without swap, pids, nofile and fsize limits', () => {
    expect(args).toEqual(expect.arrayContaining(['--memory', '2048m', '--memory-swap', '2048m', '--cpus', '2', '--pids-limit', '512']));
    expect(flags).toMatch(/--ulimit nofile=1024:1024/);
    expect(flags).toMatch(/--ulimit fsize=/);
  });
  it('caps the task request with the sandbox limits', () => {
    const small = buildGraderArgs({ name: 'n', config: defaultSandboxConfig({}), argv, limits: { cpus: 1, memoryMb: 512 } });
    expect(small).toEqual(expect.arrayContaining(['--memory', '512m', '--cpus', '1']));
    const big = buildGraderArgs({ name: 'n', config: defaultSandboxConfig({}), argv, limits: { cpus: 64, memoryMb: 999999 } });
    expect(big).toEqual(expect.arrayContaining(['--memory', '2048m', '--cpus', '2']));
  });
  it('runs the declared verifier argv with {report} in the output volume', () => {
    expect(args.slice(args.indexOf('--entrypoint'), args.indexOf('--entrypoint') + 2)).toEqual(['--entrypoint', 'npx']);
    expect(args.slice(-5)).toEqual(['vitest', 'run', 'tests/hidden', '--reporter=json', `--outputFile=${GRADER_REPORT}`]);
  });
});

describe('stageWorkspace', () => {
  const dirs: string[] = [];
  afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
  it('drops .git, removes group/other write, and leaves only the top dir and the vite cache writable', async () => {
    const src = await mkdtemp(join(tmpdir(), 'itera-stage-src-'));
    const stage = await mkdtemp(join(tmpdir(), 'itera-stage-'));
    dirs.push(src, stage);
    await mkdir(join(src, '.git'), { recursive: true });
    await mkdir(join(src, 'node_modules', 'vitest'), { recursive: true });
    await mkdir(join(src, 'tests'), { recursive: true });
    await writeFile(join(src, 'tests', 'a.test.ts'), 'x', { mode: 0o666 });
    await writeFile(join(src, 'node_modules', 'vitest', 'index.js'), 'x', { mode: 0o666 });
    await stageWorkspace(src, stage);
    expect(await stat(join(stage, 'w', '.git')).catch(() => null)).toBeNull();
    expect((await stat(join(stage, 'w', 'tests', 'a.test.ts'))).mode & 0o022).toBe(0);
    expect((await stat(join(stage, 'w', 'node_modules', 'vitest', 'index.js'))).mode & 0o022).toBe(0);
    expect((await stat(join(stage, 'w'))).mode & 0o7777).toBe(0o1777);
    expect((await stat(join(stage, 'w', 'node_modules', '.vite'))).mode & 0o7777).toBe(0o1777);
    expect((await stat(join(stage, 'out', 'report'))).mode & 0o777).toBe(0o777);
  });
});

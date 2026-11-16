import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildGraderArgs, expandOutputs, graderCommand, GRADER_REPORT, GRADER_UID, GRADER_WORKDIR, graderImage, graderWorkdir, shellQuote, stageWorkspace } from './grade.js';
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
  it('runs in the workspace, or in verifier.cwd inside it (ADR-5), never outside', () => {
    expect(args[args.indexOf('-w') + 1]).toBe(GRADER_WORKDIR);
    const inPkg = buildGraderArgs({ name: 'x', config: defaultSandboxConfig({}), argv, cwd: 'packages/lib' });
    expect(inPkg[inPkg.indexOf('-w') + 1]).toBe(`${GRADER_WORKDIR}/packages/lib`);
    expect(graderWorkdir('.')).toBe(GRADER_WORKDIR);
    for (const bad of ['../x', 'a/../../x', '/etc', 'a\\b', 'a b']) expect(() => graderWorkdir(bad)).toThrow(/not a workspace-relative directory/);
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
  it('uses the sandbox image when the task names no grader image', () => {
    const config = defaultSandboxConfig({});
    expect(args[args.indexOf('--entrypoint') + 2]).toBe(config.image);
    expect(graderImage(config)).toBe(config.image);
    expect(graderImage(config, '')).toBe(config.image);
  });
  it('uses the task grader image when it is a digest-pinned Itera grader image', () => {
    const image = `ghcr.io/devfellowship/testmyagent-grader-chromium-axe@sha256:${'a'.repeat(64)}`;
    const withImage = buildGraderArgs({ name: 'n', config: defaultSandboxConfig({}), argv, image });
    expect(withImage[withImage.indexOf('--entrypoint') + 2]).toBe(image);
    // The isolation flags do not change with the image.
    expect(withImage).toEqual(expect.arrayContaining(['--network', 'none', '--read-only', '--cap-drop', 'ALL', '--user', `${GRADER_UID}:${GRADER_UID}`]));
  });
  it('refuses a grader image that is not pinned by digest or not an Itera grader image', () => {
    const config = defaultSandboxConfig({});
    for (const bad of [
      'ghcr.io/devfellowship/testmyagent-grader-chromium-axe:1',
      `docker.io/evil/grader@sha256:${'a'.repeat(64)}`,
      `ghcr.io/devfellowship/testmyagent-mcp-media@sha256:${'a'.repeat(64)}`,
      `ghcr.io/devfellowship/testmyagent-grader-x@sha256:${'a'.repeat(64)} --privileged`,
    ]) {
      expect(() => graderImage(config, bad)).toThrow(/digest-pinned/);
      expect(() => buildGraderArgs({ name: 'n', config, argv, image: bad })).toThrow(/digest-pinned/);
    }
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

describe('build driver in the grading container (ADR-5)', () => {
  const dirs: string[] = [];
  afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it('without a build the command is the verifier argv, unchanged', () => {
    expect(graderCommand(['npx', 'vitest'], GRADER_WORKDIR)).toEqual(['npx', 'vitest']);
    const args = buildGraderArgs({ name: 'x', config: defaultSandboxConfig({}), argv });
    expect(args[args.indexOf('--entrypoint') + 1]).toBe('npx');
    expect(args.slice(args.indexOf('--entrypoint') + 3)).toEqual(argv.slice(1).map((a) => a.split('{report}').join(GRADER_REPORT)));
  });

  it('with a build: sh -c runs the quoted build in the workspace root, then execs the verifier argv as "$@"', () => {
    const args = buildGraderArgs({ name: 'x', config: defaultSandboxConfig({}), argv, cwd: 'packages/lib', build: ['npm', 'run', 'build', '-w', '@x/base'] });
    expect(args[args.indexOf('--entrypoint') + 1]).toBe('sh');
    const tail = args.slice(args.indexOf('--entrypoint') + 3);
    expect(tail[0]).toBe('-c');
    expect(tail[1]).toBe(`cd /workspace/w && 'npm' 'run' 'build' '-w' '@x/base' >&2 || { echo 'itera: build failed' >&2; exit 97; }; cd '/workspace/w/packages/lib' && exec "$@"`);
    expect(tail.slice(2)).toEqual(['sh', ...argv.map((a) => a.split('{report}').join(GRADER_REPORT))]);
  });

  it('quotes every word: a build argument never reaches the shell parser as code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'itera-sh-'));
    dirs.push(dir);
    const words = ["it's", '$(touch pwned)', '`id`', 'a b; rm -rf x', '"q"'];
    expect(spawnSync('sh', ['-c', `printf '%s\\n' ${words.map(shellQuote).join(' ')}`], { cwd: dir, encoding: 'utf-8' }).stdout).toBe(words.join('\n') + '\n');
    // The composed script, run for real (workspace root replaced by the temp dir).
    const cmd = graderCommand(['node', '-e', 'process.stdout.write(process.cwd())'], dir, ['node', '-e', "require('fs').writeFileSync('built', 'ok')"]).map((a) => a.split(GRADER_WORKDIR).join(dir));
    const ok = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf-8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe(dir);
    expect(await readFile(join(dir, 'built'), 'utf-8')).toBe('ok');
    const bad = graderCommand(['node', '-e', '0'], dir, ['node', '-e', 'process.exit(3)']).map((a) => a.split(GRADER_WORKDIR).join(dir));
    const failed = spawnSync(bad[0]!, bad.slice(1), { encoding: 'utf-8' });
    expect(failed.status).toBe(97);
    expect(failed.stderr).toContain('itera: build failed');
    expect(await lstat(join(dir, 'pwned')).catch(() => null)).toBeNull();
  });

  it('stages the build outputs empty and writable, and never follows a symbolic link out of the workspace', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'itera-ws-'));
    const stage = await mkdtemp(join(tmpdir(), 'itera-stage-'));
    const outside = await mkdtemp(join(tmpdir(), 'itera-outside-'));
    dirs.push(ws, stage, outside);
    await mkdir(join(ws, 'packages', 'a', 'dist'), { recursive: true });
    await writeFile(join(ws, 'packages', 'a', 'dist', 'stale.js'), 'old build');
    await mkdir(join(ws, 'packages', 'b'), { recursive: true });
    await mkdir(join(outside, 'dist'), { recursive: true });
    await writeFile(join(outside, 'dist', 'keep'), 'host file');
    await symlink(outside, join(ws, 'packages', 'evil'));
    await symlink(join(outside, 'dist'), join(ws, 'dist'));
    expect(await expandOutputs(ws, ['packages/*/dist', 'dist'])).toEqual(['packages/a/dist', 'packages/b/dist']);
    await stageWorkspace(ws, stage, ['packages/*/dist', 'dist', 'packages/evil/dist']);
    for (const p of ['a', 'b']) {
      const out = join(stage, 'w', 'packages', p, 'dist');
      expect((await stat(out)).mode & 0o777).toBe(0o777);
    }
    await expect(stat(join(stage, 'w', 'packages', 'a', 'dist', 'stale.js'))).rejects.toThrow();
    expect((await stat(join(stage, 'w', 'packages', 'a'))).mode & 0o022).toBe(0);
    expect(await readFile(join(outside, 'dist', 'keep'), 'utf-8')).toBe('host file');
  });

  it('opens verifier.cwd like the top directory (sticky, for the bundled vite config), never through a link', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'itera-ws-'));
    const outside = await mkdtemp(join(tmpdir(), 'itera-outside-'));
    dirs.push(ws, outside);
    await mkdir(join(ws, 'packages', 'lib', 'node_modules'), { recursive: true });
    await writeFile(join(ws, 'packages', 'lib', 'vitest.config.ts'), 'export default {}');
    await symlink(outside, join(ws, 'packages', 'evil'));
    const stage = await mkdtemp(join(tmpdir(), 'itera-stage-'));
    dirs.push(stage);
    await stageWorkspace(ws, stage, [], 'packages/lib');
    expect((await stat(join(stage, 'w', 'packages', 'lib'))).mode & 0o7777).toBe(0o1777);
    expect((await stat(join(stage, 'w', 'packages', 'lib', 'node_modules', '.vite'))).mode & 0o7777).toBe(0o1777);
    expect((await stat(join(stage, 'w', 'packages', 'lib', 'vitest.config.ts'))).mode & 0o022).toBe(0);
    expect((await stat(join(stage, 'w', 'packages'))).mode & 0o022).toBe(0);
    const linked = await mkdtemp(join(tmpdir(), 'itera-stage-'));
    dirs.push(linked);
    await stageWorkspace(ws, linked, [], 'packages/evil');
    expect((await stat(outside)).mode & 0o7777).not.toBe(0o1777);
  });
});

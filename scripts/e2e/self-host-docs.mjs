#!/usr/bin/env node
/**
 * self-host-docs.mjs — the WORD-FOR-WORD check of the self-host docs (plan 20261112-tma-c3-eval-repo-kit-docs, C3-T6).
 *
 * It takes the fenced shell blocks of docs/self-host/install.md and docs/self-host/eval-commands.md
 * that carry the marker line `<!-- e2e -->` DIRECTLY above the opening fence. It runs them in file
 * order (install.md first), in ONE shell, in a clean container with only the doc text, and then
 * asserts the final state:
 *   - `tma --version` prints the version of services/runner/package.json, and `tma tasks` lists tsk_webhook_dup;
 *   - the reference solution scores 100 on each of its three runs;
 *   - the empty variant fails (score 0, passed 0) on each of its three runs;
 *   - the dry run printed a tma-eval-dry-run/1 verdict;
 *   - the digest of the case folder is the same before and after the dry run;
 *   - `git status --short` of the copy of the repo prints nothing.
 *
 * Only commands that run offline, with no model key and no login, carry the marker.
 *
 * Usage:
 *   node scripts/e2e/self-host-docs.mjs                 docker mode if docker works, else host mode
 *   node scripts/e2e/self-host-docs.mjs --mode docker   a node:24 container, a fresh copy of the repo mounted
 *   node scripts/e2e/self-host-docs.mjs --mode host     the same commands in a temp dir on this machine
 *   node scripts/e2e/self-host-docs.mjs --list          print the extracted commands and stop
 *   node scripts/e2e/self-host-docs.mjs --self-test     test the extractor and the assertions, run nothing
 *
 * Docker mode: the container runs as your uid, with the Docker socket and the docker CLI of this machine
 * (the sandbox and the grader are containers that `tma eval run` starts through `docker cp`; there is no
 * bind mount). The container reaches the network for npm only (npm ci). The log goes to
 * scripts/e2e/logs/ (git-ignored, never committed).
 *
 * Exit codes: 0 all steps ran and all assertions hold; 1 a step or an assertion failed; 7 bad args / no marked block.
 */
import { spawnSync, spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = '<!-- e2e -->';
export const DOCS = ['docs/self-host/install.md', 'docs/self-host/eval-commands.md'];
const SHELL_LANGS = new Set(['bash', 'sh', 'shell']);

/** The marked fenced shell blocks of one markdown text, in order. A marker counts only on the line directly above the fence. */
export function extractBlocks(text, file = 'doc.md') {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== MARKER) continue;
    const fence = /^```([A-Za-z0-9_-]*)\s*$/.exec(lines[i + 1] ?? '');
    if (!fence) throw new Error(`${file}:${i + 1}: the marker must be directly above a fenced block`);
    if (!SHELL_LANGS.has(fence[1])) throw new Error(`${file}:${i + 2}: a marked block must be bash, sh or shell (got "${fence[1]}")`);
    const body = [];
    let j = i + 2;
    for (; j < lines.length && !/^```\s*$/.test(lines[j]); j++) body.push(lines[j]);
    if (j >= lines.length) throw new Error(`${file}:${i + 2}: the fenced block is not closed`);
    blocks.push({ file, line: i + 2, code: body.join('\n') });
    i = j;
  }
  return blocks;
}

/** One bash script: the blocks in order, each after a marker line the assertions read. */
export function buildScript(blocks) {
  const out = ['#!/usr/bin/env bash', 'set -euo pipefail', ''];
  blocks.forEach((b, n) => {
    out.push(`printf '@@STEP %s %s:%s\\n' ${n + 1} '${b.file}' ${b.line}`);
    out.push(b.code, '');
  });
  out.push("printf '@@END\\n'");
  return out.join('\n');
}

/** Split the log of the script into steps: [{n, where, out}]. */
export function splitSteps(log) {
  const steps = [];
  let cur = null;
  for (const line of log.split('\n')) {
    const m = /^@@STEP (\d+) (\S+)$/.exec(line);
    if (m) {
      cur = { n: Number(m[1]), where: m[2], out: [] };
      steps.push(cur);
    } else if (line === '@@END') cur = null;
    else if (cur) cur.out.push(line);
  }
  return steps.map((s) => ({ ...s, out: s.out.join('\n') }));
}

/** The assertions on the final state. Returns a list of failures (empty = all hold). */
export function assertState({ blocks, log, runnerVersion }) {
  const fails = [];
  const need = (ok, what) => {
    if (!ok) fails.push(what);
  };
  const steps = splitSteps(log);
  need(log.includes('@@END'), 'the script did not reach its end');
  need(steps.length === blocks.length, `${steps.length} of ${blocks.length} marked blocks ran`);
  const find = (re) => steps.find((s) => re.test(blocks[s.n - 1]?.code ?? ''));

  const ver = find(/tma --version/);
  need(ver && ver.out.trim().split('\n').pop() === runnerVersion, `tma --version did not print ${runnerVersion}`);
  const tasks = find(/^tma tasks\s*$/m);
  need(tasks && /^tsk_webhook_dup\s+v1\s+Idempotent settlement webhook/m.test(tasks.out), 'tma tasks did not list tsk_webhook_dup');

  const sol = find(/solution\.variant\.json/);
  const solPass = sol ? sol.out.match(/^local-\S+\s+\d+\s+pass\s+100\s+hidden-tests@\S+=pass\/100$/gm) ?? [] : [];
  need(solPass.length === 3, `the reference solution scored 100 on ${solPass.length} of 3 runs`);
  need(sol && /n 3, measured 3, passed 3, mean score 100/.test(sol.out), 'the reference solution summary is not "n 3, measured 3, passed 3, mean score 100"');

  const emp = find(/empty\.variant\.json/);
  const empFail = emp ? emp.out.match(/^local-\S+\s+\d+\s+fail\s+0\s+hidden-tests@\S+=fail\/0$/gm) ?? [] : [];
  need(empFail.length === 3, `the empty variant failed with score 0 on ${empFail.length} of 3 runs`);
  need(emp && /n 3, measured 3, passed 0, mean score 0/.test(emp.out), 'the empty variant summary is not "n 3, measured 3, passed 0, mean score 0"');

  const diff = find(/tma eval diff/);
  need(diff && /delta mean score -100/.test(diff.out), 'tma eval diff did not print "delta mean score -100"');

  const dry = find(/--dry-run/);
  need(dry && /"format": "tma-eval-dry-run\/1"/.test(dry.out) && /"dry_run": true/.test(dry.out), 'the dry run did not print a tma-eval-dry-run/1 verdict');

  const sums = steps.filter((s) => /sha256sum \| sha256sum/.test(blocks[s.n - 1].code)).map((s) => s.out.trim());
  need(sums.length === 2 && /^[0-9a-f]{64}\s+-$/.test(sums[0]) && sums[0] === sums[1], 'the digest of the case folder changed across the dry run (or was not taken twice)');

  const status = find(/git .*status --short/);
  need(status && status.out.trim() === '', `git status --short is not clean: ${status ? JSON.stringify(status.out.trim().slice(0, 200)) : 'step missing'}`);
  return fails;
}

function selfTest() {
  const md = ['x', MARKER, '```bash', 'echo a', '```', 'y', '```bash', 'echo unmarked', '```', MARKER, '', '```bash', 'echo gap', '```'].join('\n');
  let threw = false;
  try {
    extractBlocks(md);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('self-test: a marker with a blank line before the fence must throw');
  const ok = extractBlocks(['a', MARKER, '```bash', 'echo a', 'echo b', '```', MARKER, '```sh', 'echo c', '```'].join('\n'));
  if (ok.length !== 2 || ok[0].code !== 'echo a\necho b' || ok[1].code !== 'echo c') throw new Error('self-test: extractor result');
  if (extractBlocks(['```bash', 'echo unmarked', '```'].join('\n')).length !== 0) throw new Error('self-test: an unmarked block must not run');
  // The assertions must fail on a wrong state.
  const blocks = [{ file: 'f', line: 1, code: 'tma --version' }];
  const bad = assertState({ blocks, log: '@@STEP 1 f:1\n9.9.9\n@@END\n', runnerVersion: '0.1.0' });
  if (bad.length === 0) throw new Error('self-test: assertions passed on a wrong state');
  console.log('self-test ok');
}

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) await main();

async function main() {
  if (flag('self-test')) return selfTest();
  const blocks = DOCS.flatMap((f) => extractBlocks(readFileSync(join(root, f), 'utf-8'), f));
  if (blocks.length === 0) {
    console.error('no block with the marker <!-- e2e --> in the docs');
    process.exit(7);
  }
  const script = buildScript(blocks);
  if (flag('list')) {
    console.log(script);
    return;
  }
  const dockerOk = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf-8' }).status === 0;
  const mode = opt('mode') ?? (dockerOk ? 'docker' : 'host');
  if (!['docker', 'host'].includes(mode)) {
    console.error('--mode must be docker or host');
    process.exit(7);
  }
  if (mode === 'docker' && !dockerOk) {
    console.error('docker is not usable on this machine: use --mode host (the sandbox and the grader still need docker)');
    process.exit(7);
  }

  // A fresh copy of the repo: tracked and untracked files, without node_modules, in a new git repo.
  const work = mkdtempSync(join(tmpdir(), 'tma-selfhost-e2e-'));
  const copy = join(work, 'repo');
  mkdirSync(copy);
  const listed = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf-8', maxBuffer: 1 << 28 });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  let copied = 0;
  for (const rel of listed.stdout.split('\0').filter(Boolean)) {
    const src = join(root, rel);
    if (!existsSync(src) || !statSync(src).isFile()) continue;
    mkdirSync(dirname(join(copy, rel)), { recursive: true });
    cpSync(src, join(copy, rel));
    copied++;
  }
  const git = (...a) => spawnSync('git', a, { cwd: copy, encoding: 'utf-8' });
  git('init', '-q');
  git('add', '-A');
  const commit = git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '-m', 'fresh copy');
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}`);

  const scriptFile = join(work, 'e2e.sh');
  writeFileSync(scriptFile, script);
  chmodSync(scriptFile, 0o755);
  const home = join(work, 'home');
  mkdirSync(home);

  let cmd;
  let cmdArgs;
  if (mode === 'docker') {
    const sock = '/var/run/docker.sock';
    const sockGid = String(statSync(sock).gid);
    const dockerBin = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf-8' }).stdout.trim();
    cmd = 'docker';
    cmdArgs = [
      'run', '--rm', '--init', '-u', `${process.getuid()}:${process.getgid()}`, '--group-add', sockGid,
      '-v', `${sock}:${sock}`, '-v', `${realpath(dockerBin)}:/usr/local/bin/docker:ro`,
      '-v', `${copy}:/work`, '-v', `${scriptFile}:/e2e/e2e.sh:ro`, '-v', `${home}:/home/e2e`,
      '-w', '/work', '-e', 'HOME=/home/e2e', '-e', 'CI=1',
      'node:24', 'bash', '/e2e/e2e.sh',
    ];
  } else {
    cmd = 'bash';
    cmdArgs = [scriptFile];
  }

  console.error(`[self-host-docs] mode ${mode}; ${blocks.length} marked blocks; ${copied} files copied to ${copy}`);
  const logDir = join(here, 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `self-host-docs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const chunks = [];
  const code = await new Promise((res) => {
    const p = spawn(cmd, cmdArgs, { cwd: mode === 'host' ? copy : undefined, env: { ...process.env, ...(mode === 'host' ? { HOME: home, CI: '1' } : {}) } });
    for (const s of [p.stdout, p.stderr]) s.on('data', (d) => { chunks.push(d); process.stderr.write(d); });
    p.on('close', (c) => res(c ?? 1));
  });
  const log = Buffer.concat(chunks).toString('utf-8');
  writeFileSync(logFile, log);
  const runnerVersion = JSON.parse(readFileSync(join(root, 'services/runner/package.json'), 'utf-8')).version;
  const fails = assertState({ blocks, log, runnerVersion });
  if (code !== 0) fails.unshift(`the script exited with ${code}`);
  console.error(`[self-host-docs] log: ${logFile}`);
  if (!flag('keep')) rmSync(work, { recursive: true, force: true });
  if (fails.length > 0) {
    console.error('[self-host-docs] FAILED');
    for (const f of fails) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.error(`[self-host-docs] OK: ${blocks.length} blocks ran word for word; all assertions hold`);
}

function realpath(p) {
  return spawnSync('readlink', ['-f', p], { encoding: 'utf-8' }).stdout.trim() || p;
}

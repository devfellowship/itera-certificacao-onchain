// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPaths, dockerArgs, hostSocket, LauncherError, readPin, resolveImage, socketNotice, verifySignature } from '../lib/launcher.mjs';

const D = `sha256:${'a'.repeat(64)}`;
const base = {
  cwd: '/home/samuel/work',
  configDir: '/home/samuel/.config/tma',
  image: `ghcr.io/devfellowship/tma-local@${D}`,
  platform: 'linux',
  uid: 1000,
  gid: 1000,
  socketGid: 998,
  socketPath: '/var/run/docker.sock',
  env: { OPENROUTER_API_KEY: 'sk-or-v1-secret', TMA_API_URL: 'https://api.example' },
  tty: false,
  name: 'tma-1234',
};
const has = (argv, ...seq) => argv.some((_, i) => seq.every((s, j) => argv[i + j] === s));

test('image.json in git is the development copy: no digest, the published image name', () => {
  const pin = readPin();
  assert.equal(pin.image, 'ghcr.io/devfellowship/tma-local');
  assert.equal(pin.digest, null);
  assert.throws(() => resolveImage(pin, {}), LauncherError);
});

test('a published pin runs the image by digest only', () => {
  const img = resolveImage({ image: 'ghcr.io/devfellowship/tma-local', version: '0.1.0', digest: D }, {});
  assert.deepEqual(img, { ref: `ghcr.io/devfellowship/tma-local@${D}`, pinned: true, override: false });
  assert.throws(() => resolveImage({ image: 'x', digest: 'latest' }, {}), LauncherError);
});

test('run and grade mount the socket; login, upload, tasks, workspace do not', () => {
  for (const cmd of ['run', 'grade']) assert.ok(dockerArgs({ ...base, args: [cmd] }).includes('/var/run/docker.sock:/var/run/docker.sock'), cmd);
  for (const cmd of ['login', 'upload', 'tasks', 'workspace', 'agent', 'evaluations', '--help']) {
    assert.ok(!dockerArgs({ ...base, args: [cmd] }).join(' ').includes('docker.sock'), cmd);
  }
});

test('runs as the user uid, with the socket group only when the socket is mounted, no capabilities', () => {
  const run = dockerArgs({ ...base, args: ['run'] });
  assert.ok(has(run, '--user', '1000:1000'));
  assert.ok(has(run, '--group-add', '998'));
  assert.ok(has(run, '--cap-drop', 'ALL'));
  assert.ok(has(run, '--security-opt', 'no-new-privileges'));
  assert.ok(has(run, '--pids-limit', '2048'));
  assert.ok(run.includes('--rm') && run.includes('--init'));
  assert.ok(!has(dockerArgs({ ...base, args: ['upload'] }), '--group-add', '998'));
  assert.ok(!run.includes('--privileged'));
});

test('Docker Desktop: root inside the container only for the socket commands', () => {
  const mac = { ...base, platform: 'darwin' };
  assert.ok(has(dockerArgs({ ...mac, args: ['grade'] }), '--user', '0:0'));
  assert.ok(!dockerArgs({ ...mac, args: ['upload'] }).includes('--user'));
  assert.ok(has(dockerArgs({ ...mac, args: ['upload'] }), '--cap-drop', 'ALL'));
});

test('the model key goes by NAME, and only to `run`', () => {
  const run = dockerArgs({ ...base, args: ['run'] });
  assert.ok(has(run, '-e', 'OPENROUTER_API_KEY'));
  assert.ok(!run.join(' ').includes('sk-or-v1-secret'));
  assert.ok(!dockerArgs({ ...base, args: ['grade'] }).includes('OPENROUTER_API_KEY'));
  assert.ok(!dockerArgs({ ...base, args: ['upload'] }).includes('OPENROUTER_API_KEY'));
  assert.ok(has(dockerArgs({ ...base, args: ['upload'] }), '-e', 'TMA_API_URL'));
});

test('mounts the current folder at the same path and the config dir; the image and args come last', () => {
  const argv = dockerArgs({ ...base, args: ['grade', '--task-dir', './t'] });
  assert.ok(has(argv, '-v', '/home/samuel/work:/home/samuel/work', '-w', '/home/samuel/work'));
  assert.ok(has(argv, '-v', '/home/samuel/.config/tma:/tma-config', '-e', 'TMA_CONFIG_DIR=/tma-config'));
  assert.deepEqual(argv.slice(-4), [base.image, 'grade', '--task-dir', './t']);
});

test('refuses an absolute path outside the current folder', () => {
  assert.doesNotThrow(() => checkPaths(['--task-dir', '/home/samuel/work/t', '--out=/home/samuel/work/r.json', './x'], '/home/samuel/work'));
  assert.throws(() => checkPaths(['--task-dir', '/etc'], '/home/samuel/work'), LauncherError);
  assert.throws(() => checkPaths(['--out=/tmp/r.json'], '/home/samuel/work'), LauncherError);
});

test('socket path: DOCKER_HOST unix only on Linux; Docker Desktop always maps /var/run/docker.sock', () => {
  assert.equal(hostSocket({}, 'linux'), '/var/run/docker.sock');
  assert.equal(hostSocket({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, 'linux'), '/run/user/1000/docker.sock');
  assert.throws(() => hostSocket({ DOCKER_HOST: 'tcp://1.2.3.4:2375' }, 'linux'), LauncherError);
  assert.equal(hostSocket({ DOCKER_HOST: 'unix:///Users/s/.docker/run/docker.sock' }, 'darwin'), '/var/run/docker.sock');
});

test('the socket notice says root-equivalent and names the image', () => {
  const n = socketNotice(base.image, '/var/run/docker.sock', 'verified');
  assert.match(n, /ROOT-EQUIVALENT/);
  assert.match(n, /never get the socket/);
  assert.match(n, new RegExp(D));
});

test('signature: a failed cosign verify refuses; no cosign is allowed unless required', () => {
  const img = { ref: base.image, pinned: true, override: false };
  const bad = () => ({ status: 1, stderr: 'no matching signatures' });
  const good = () => ({ status: 0, stderr: '' });
  assert.throws(() => verifySignature(img, {}, bad, () => true), /does not verify/);
  assert.match(verifySignature(img, {}, good, () => true), /^verified/);
  assert.match(verifySignature(img, {}, good, () => false), /cosign not installed/);
  assert.throws(() => verifySignature(img, { TMA_REQUIRE_SIGNATURE: '1' }, good, () => false), LauncherError);
});

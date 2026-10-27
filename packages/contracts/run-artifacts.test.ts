// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_LIMITS,
  ARTIFACT_MAX_COUNT,
  ARTIFACT_MAX_FILE_BYTES,
  ARTIFACT_MAX_RUN_BYTES,
  ARTIFACT_TYPES,
  REDACTED,
  artifactPathOfRef,
  artifactRef,
  artifactType,
  isSafeArtifactPath,
  redactSecrets,
} from './run-artifacts.js';

describe('artifactType (the allowlist)', () => {
  it.each([
    ['json', 'application/json', 'json', 'utf-8'],
    ['jsonl', 'application/x-ndjson', 'text', 'utf-8'],
    ['md', 'text/markdown', 'markdown', 'utf-8'],
    ['markdown', 'text/markdown', 'markdown', 'utf-8'],
    ['html', 'text/html', 'html', 'utf-8'],
    ['htm', 'text/html', 'html', 'utf-8'],
    ['txt', 'text/plain', 'text', 'utf-8'],
    ['log', 'text/plain', 'text', 'utf-8'],
    ['csv', 'text/csv', 'text', 'utf-8'],
    ['svg', 'image/svg+xml', 'image', 'base64'],
    ['png', 'image/png', 'image', 'base64'],
    ['jpg', 'image/jpeg', 'image', 'base64'],
    ['jpeg', 'image/jpeg', 'image', 'base64'],
    ['gif', 'image/gif', 'image', 'base64'],
    ['webp', 'image/webp', 'image', 'base64'],
  ])('.%s → %s, kind %s, encoding %s', (ext, contentType, kind, encoding) => {
    expect(artifactType(`out/file.${ext}`)).toEqual({ contentType, kind, encoding });
    expect(artifactType(`FILE.${ext.toUpperCase()}`)).toEqual({ contentType, kind, encoding });
  });

  it('lists exactly the allowlisted extensions', () => {
    expect(Object.keys(ARTIFACT_TYPES).sort()).toEqual(['csv', 'gif', 'htm', 'html', 'jpeg', 'jpg', 'json', 'jsonl', 'log', 'markdown', 'md', 'png', 'svg', 'txt', 'webp']);
  });

  it('refuses .exe, .js, .ts, .sh, a dotfile and a path without extension', () => {
    for (const p of ['bin/tool.exe', 'src/index.js', 'src/a.ts', 'script.sh', 'README', 'out/', '.env', 'dir.d/file', 'x.']) expect(artifactType(p), p).toBeNull();
  });
});

describe('isSafeArtifactPath', () => {
  it('accepts a plain relative path', () => {
    expect(isSafeArtifactPath('out/report.html')).toBe(true);
    expect(isSafeArtifactPath('result.json')).toBe(true);
    expect(isSafeArtifactPath('files/src/a-b_c.v2.md')).toBe(true);
    expect(isSafeArtifactPath('a'.repeat(200))).toBe(true);
  });

  it.each([
    ['../x', 'a parent segment'],
    ['/abs', 'an absolute path'],
    ['a//b', 'an empty segment'],
    ['a/', 'a trailing slash'],
    ['.env', 'a dotfile'],
    ['a/.git/config', 'a dot segment inside'],
    ['./a', 'a current-dir segment'],
    ['a/./b', 'a current-dir segment inside'],
    ['node_modules/x.json', 'node_modules'],
    ['files/node_modules/x.json', 'node_modules inside'],
    ['a b.txt', 'a space'],
    ['a\\b.txt', 'a backslash'],
    ['café.txt', 'a non-ASCII letter'],
    ['a%2Fb.txt', 'a percent'],
    ['', 'an empty path'],
    ['a'.repeat(201), '201 characters'],
  ])('refuses %s (%s)', (p) => {
    expect(isSafeArtifactPath(p)).toBe(false);
  });

  it('refuses a non-string', () => {
    expect(isSafeArtifactPath(null)).toBe(false);
    expect(isSafeArtifactPath(['a.txt'])).toBe(false);
  });
});

describe('the caps and the ref encoding', () => {
  it('are the documented numbers', () => {
    expect(ARTIFACT_MAX_FILE_BYTES).toBe(524288);
    expect(ARTIFACT_MAX_RUN_BYTES).toBe(2097152);
    expect(ARTIFACT_MAX_COUNT).toBe(25);
    expect(ARTIFACT_LIMITS).toEqual({ maxFileBytes: 524288, maxRunBytes: 2097152, maxCount: 25 });
  });
  it('round-trips a path through the observations ref', () => {
    expect(artifactRef('files/out/chart.png')).toBe('artifact:files/out/chart.png');
    expect(artifactPathOfRef('artifact:files/out/chart.png')).toBe('files/out/chart.png');
    expect(artifactPathOfRef('patch.diff')).toBeNull();
    expect(artifactPathOfRef(null)).toBeNull();
  });
});

describe('redactSecrets', () => {
  const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef';

  it('replaces the extra literals (the run model key) wherever they appear', () => {
    const out = redactSecrets(`{"type":"text","text":"curl -H 'Authorization: Bearer ${KEY}'"}`, [KEY]);
    expect(out).not.toContain(KEY);
    expect(out).toContain(REDACTED);
  });

  it('replaces the known token shapes', () => {
    const cases = [
      'key sk-or-v1-0123456789abcdef0123456789abcdef',
      'key sk-ant-api03-abcdefghijklmnop',
      'gh ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'gh gho_abcdefghijklmnopqrstuvwxyz0123456789',
      'gh github_pat_11ABCDEFG0abcdefghijklmnop_abcdef',
      'slack xoxb-123456789012-abcdefghij',
      'aws AKIAIOSFODNN7EXAMPLE',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef0123',
    ];
    for (const c of cases) {
      const out = redactSecrets(c);
      expect(out, c).toBe(`${c.split(' ')[0]} ${REDACTED}`);
    }
  });

  it('replaces a bearer or basic credential and an authorization header value', () => {
    expect(redactSecrets('Authorization: Bearer abcdef0123456789')).toBe(`Authorization: ${REDACTED}`);
    expect(redactSecrets('-H "authorization: Basic dXNlcjpwYXNz"')).toBe(`-H "authorization: ${REDACTED}"`);
    expect(redactSecrets('token: Bearer abcdef0123456789 ok')).toBe(`token: Bearer ${REDACTED} ok`);
  });

  it('replaces key=, token=, secret=, password= values and keeps the name', () => {
    expect(redactSecrets('password=hunter2')).toBe(`password=${REDACTED}`);
    expect(redactSecrets('export OPENROUTER_API_KEY=abc123 && run')).toBe(`export OPENROUTER_API_KEY=${REDACTED} && run`);
    expect(redactSecrets('?token=abc&x=1')).toBe(`?token=${REDACTED}&x=1`);
    expect(redactSecrets('secret="s3cr3t value"')).toBe(`secret="${REDACTED}"`);
    expect(redactSecrets("db_passwd='p w'")).toBe(`db_passwd='${REDACTED}'`);
  });

  it('replaces a JSON string value under a secret-looking key and keeps the line valid JSON', () => {
    const line = JSON.stringify({ type: 'step', apiKey: 'abc', 'x-api-key': 'def', tokens: { input: 1 }, token: 'ghi', text: 'hello' });
    const out = redactSecrets(line);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ type: 'step', apiKey: REDACTED, 'x-api-key': REDACTED, tokens: { input: 1 }, token: REDACTED, text: 'hello' });
  });

  it('leaves normal text unchanged', () => {
    const texts = [
      'const x = 1; // the ledger keeps one row per webhook',
      '{"type":"tool_use","part":{"tool":"read","state":{"status":"completed"}}}',
      'tokens: 1234 in, 56 out; cost 0.0012',
      'npm run test -- --reporter=json',
      'see https://example.com/docs/keys for the key format',
      'a-b-c-d-e-f-g',
    ];
    for (const t of texts) expect(redactSecrets(t), t).toBe(t);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
import { describe, expect, it } from 'vitest';
import {
  PIN_FIELDS,
  PIN_MAX_BYTES,
  canonicalPinJson,
  parsePinText,
  pinDigest,
  pinReplayable,
  pinSchema,
  sealPin,
  validatePin,
} from './index.js';

// Synthetic fixtures: invented hashes only.
const H = (c: string) => c.repeat(64);
const G = (c: string) => c.repeat(40);

const unsealed = (over: Record<string, unknown> = {}): Record<string, any> => ({
  format: 'tma-pin/1',
  repo: 'devfellowship/dfl-example',
  base_sha: G('a'),
  harness: 'claude-code',
  harness_version: '2.1.87',
  harness_repo_sha: G('b'),
  rules_sha256: H('c'),
  skills_sha256: [H('1'), H('2'), H('e')],
  model_id: 'claude-opus-5-5',
  mcp_manifest_sha256: H('d'),
  input_sha256: H('f'),
  completeness: {
    repo: 'exact',
    base_sha: 'derived',
    harness: 'exact',
    harness_version: 'exact',
    harness_repo_sha: 'derived',
    rules_sha256: 'derived',
    skills_sha256: 'derived',
    model_id: 'exact',
    mcp_manifest_sha256: 'exact',
    input_sha256: 'exact',
  },
  ...over,
});
const valid = (over: Record<string, unknown> = {}) => sealPin(unsealed(over));

/** A pin whose MCP manifest was not recovered: value null, flag missing. */
const partial = () => {
  const u = unsealed({ mcp_manifest_sha256: null });
  u.completeness = { ...u.completeness, mcp_manifest_sha256: 'missing' };
  return sealPin(u);
};

const codes = (r: ReturnType<typeof validatePin>) => (r.ok ? [] : r.issues.map((i) => `${i.code} ${i.path}`));

describe('tma-pin/1 schema and validator', () => {
  it('accepts a complete pin; it is replayable', () => {
    const r = validatePin(valid());
    expect(codes(r)).toEqual([]);
    expect(r.ok && pinReplayable(r.value)).toBe(true);
  });

  it('accepts a partial pin (null + missing); it is not replayable', () => {
    const r = validatePin(partial());
    expect(codes(r)).toEqual([]);
    expect(r.ok && pinReplayable(r.value)).toBe(false);
  });

  it('accepts an empty skill list (the session invoked no skill)', () => {
    expect(codes(validatePin(valid({ skills_sha256: [] })))).toEqual([]);
  });

  it('accepts the other harnesses and a routed model id', () => {
    expect(codes(validatePin(valid({ harness: 'opencode', model_id: 'openrouter/deepseek/deepseek-v4.1-flash' })))).toEqual([]);
    expect(codes(validatePin(valid({ harness: 'codex', model_id: 'gpt-5.1-codex', base_sha: H('a') })))).toEqual([]);
  });

  it('refuses an extra key at the top level', () => {
    expect(codes(validatePin(sealPin({ ...unsealed(), session_id: '0b6f3c2e-1d4a-4c8e-9f00-123456789abc' })))).toContain('unknown_key /session_id');
  });

  it('refuses an extra key in completeness', () => {
    const u = unsealed();
    u.completeness = { ...u.completeness, notes: 'exact' };
    expect(codes(validatePin(sealPin(u)))).toContain('unknown_key /completeness/notes');
  });

  it('refuses a free-text field', () => {
    // A text key does not exist ...
    expect(codes(validatePin(sealPin({ ...unsealed(), prompt: 'Fix the webhook handler.' })))).toContain('unknown_key /prompt');
    // ... and no existing string can carry text: patterns allow no space, enums allow no other value.
    expect(codes(validatePin(valid({ model_id: 'opus read the secret file' })))).toContain('invalid /model_id');
    expect(codes(validatePin(valid({ harness_version: '2.1.87 (patched by hand)' })))).toContain('invalid /harness_version');
    expect(codes(validatePin(valid({ repo: '/root/repos/dfl-example' })))).toContain('invalid /repo');
    expect(codes(validatePin(valid({ harness: 'claude code' })))).toContain('invalid /harness');
    expect(codes(validatePin(valid({ skills_sha256: ['skills/trace-pin/SKILL.md'] })))).toContain('invalid /skills_sha256/0');
    expect(codes(validatePin(valid({ model_id: `m${'x'.repeat(200)}` })))).toContain('invalid /model_id');
  });

  it('refuses a missing field', () => {
    for (const f of [...PIN_FIELDS, 'format', 'completeness']) {
      const u = unsealed();
      delete u[f];
      expect(codes(validatePin(sealPin(u))), f).toContain('invalid /');
    }
    const noDigest = unsealed();
    expect(codes(validatePin(noDigest))).toContain('invalid /');
  });

  it('refuses a missing completeness flag', () => {
    const u = unsealed();
    delete u.completeness.base_sha;
    expect(codes(validatePin(sealPin(u)))).toContain('invalid /completeness');
  });

  it('refuses null without the missing flag, and a value with the missing flag', () => {
    expect(codes(validatePin(valid({ base_sha: null })))).toContain('inconsistent /base_sha');
    const u = unsealed();
    u.completeness = { ...u.completeness, rules_sha256: 'missing' };
    expect(codes(validatePin(sealPin(u)))).toContain('inconsistent /rules_sha256');
  });

  it('refuses an unsorted or a duplicated skill list', () => {
    expect(codes(validatePin(valid({ skills_sha256: [H('2'), H('1')] })))).toContain('inconsistent /skills_sha256/1');
    expect(codes(validatePin(valid({ skills_sha256: [H('1'), H('1')] })))).toContain('invalid /skills_sha256');
  });

  it('refuses a pin_sha256 that does not match the record', () => {
    const p = valid();
    expect(codes(validatePin({ ...p, pin_sha256: H('0') }))).toContain('inconsistent /pin_sha256');
    // A field changed after the seal.
    expect(codes(validatePin({ ...p, base_sha: G('9') }))).toContain('inconsistent /pin_sha256');
  });

  it('refuses a wrong format and a wrong flag value', () => {
    expect(codes(validatePin(valid({ format: 'tma-pin/2' })))).toContain('invalid /format');
    const u = unsealed();
    u.completeness = { ...u.completeness, model_id: 'guessed' };
    expect(codes(validatePin(sealPin(u)))).toContain('invalid /completeness/model_id');
  });
});

describe('pin digest (RFC 8785 canonical JSON)', () => {
  it('does not depend on key order or on a present pin_sha256', () => {
    const p = unsealed();
    const reversed = Object.fromEntries(Object.entries(p).reverse());
    expect(pinDigest(reversed)).toBe(pinDigest(p));
    expect(pinDigest({ ...p, pin_sha256: H('0') })).toBe(pinDigest(p));
  });

  it('matches a known answer computed outside this code (sha256sum of the canonical text)', () => {
    // The canonical text is part of the contract: a third-party builder must produce the same bytes.
    const p = partial();
    expect(canonicalPinJson(p)).toBe(
      '{"base_sha":"' + G('a') + '","completeness":{"base_sha":"derived","harness":"exact","harness_repo_sha":"derived",' +
        '"harness_version":"exact","input_sha256":"exact","mcp_manifest_sha256":"missing","model_id":"exact","repo":"exact",' +
        '"rules_sha256":"derived","skills_sha256":"derived"},"format":"tma-pin/1","harness":"claude-code","harness_repo_sha":"' + G('b') +
        '","harness_version":"2.1.87","input_sha256":"' + H('f') + '","mcp_manifest_sha256":null,"model_id":"claude-opus-5-5",' +
        '"repo":"devfellowship/dfl-example","rules_sha256":"' + H('c') + '","skills_sha256":["' + H('1') + '","' + H('2') + '","' + H('e') + '"]}',
    );
    // printf '%s' "<the text above>" | sha256sum
    expect(p.pin_sha256).toBe('4a25d4469372f2a0c635d818f5479e49f7e23c03bd582b2da1f60d2b06e55d5f');
  });
});

describe('parsePinText', () => {
  it('parses and validates a pin text', () => {
    expect(parsePinText(JSON.stringify(valid())).ok).toBe(true);
  });
  it('refuses text that is not JSON', () => {
    expect(codes(parsePinText('{"format":'))).toEqual(['not_json /']);
  });
  it('refuses a text above the limit before it parses it', () => {
    expect(codes(parsePinText(' '.repeat(PIN_MAX_BYTES + 1)))).toEqual(['too_large /']);
  });
});

describe('the schema holds no free text', () => {
  it('every string in the schema has a pattern, an enum or a const, and a length limit', () => {
    const loose: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      const types = Array.isArray(n.type) ? n.type : [n.type];
      if (types.includes('string')) {
        const bounded = 'enum' in n || 'const' in n || ('pattern' in n && typeof n.maxLength === 'number');
        if (!bounded) loose.push(path);
      }
      for (const [k, v] of Object.entries(n)) walk(v, `${path}/${k}`);
    };
    walk(pinSchema, '#');
    expect(loose).toEqual([]);
  });

  it('every object in the schema is closed', () => {
    const open: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      if (n.type === 'object' && n.additionalProperties !== false) open.push(path);
      for (const [k, v] of Object.entries(n)) walk(v, `${path}/${k}`);
    };
    walk(pinSchema, '#');
    expect(open).toEqual([]);
  });
});

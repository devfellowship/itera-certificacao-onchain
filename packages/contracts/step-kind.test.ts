// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// The shared step-kind mapping (plan 20261112-tma-c4-result-store-trajectory-upload, T10).
import { describe, expect, it } from 'vitest';
import { STEP_KINDS, hostedStepKindOf, stepKindOf } from './index.js';

describe('hostedStepKindOf: a stored hosted row from its tool and target', () => {
  it('maps the opencode tools and the bash command, and tells an MCP tool by its <server>_<tool> name', () => {
    const cases: Array<[string, string | null, string]> = [
      ['read', 'src/a.ts', 'read'],
      ['list', '.', 'read'],
      ['glob', '**/*.ts', 'search'],
      ['grep', 'handler', 'search'],
      ['write', 'src/a.ts', 'write'],
      ['edit', 'src/a.ts', 'write'],
      ['patch', 'src/a.ts', 'write'],
      ['task', 'review the diff', 'agent'],
      ['skill', 'deploy', 'mcp'],
      ['todowrite', null, 'other'],
      ['invalid', null, 'other'],
      ['bash', 'npm test', 'test'],
      ['bash', 'cd app && npx vitest run', 'test'],
      ['bash', 'git commit -m fix', 'write'],
      ['bash', 'git status', 'shell'],
      ['bash', 'cat package.json', 'read'],
      ['bash', 'rg handler src', 'search'],
      ['bash', 'echo hi', 'shell'],
      ['bash', null, 'shell'],
      ['repos_read_file_lines', 'devfellowship/dfl-infra', 'mcp'],
      ['browser_browser_navigate', 'https://example.com', 'mcp'],
      ['helpdesk_close_ticket', 't-1', 'mcp'],
      ['media_upload_file', 'a.png', 'mcp'],
      ['SomethingElse', null, 'other'],
    ];
    for (const [tool, target, want] of cases) expect(hostedStepKindOf(tool, target), `${tool} ${target}`).toBe(want);
  });
  it('uses the target as the command only for bash', () => {
    expect(hostedStepKindOf('read', 'npm test')).toBe('read');
    expect(stepKindOf('read', 'npm test', false)).toBe('read');
  });
  it('always answers one of the closed step kinds', () => {
    for (const tool of ['read', 'bash', 'x_y', 'weird tool', '']) expect(STEP_KINDS).toContain(hostedStepKindOf(tool, 'npm test'));
  });
});

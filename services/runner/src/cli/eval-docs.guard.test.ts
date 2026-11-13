// Docs guard (plan 20261112-tma-c3-eval-repo-kit-docs, C3-T6): every `tma eval` command that
// docs/self-host/eval-commands.md prints names a subcommand and flags that the USAGE of
// src/cli/commands/eval.ts lists. A doc that invents a flag goes red.
// Mutation proof: write `tma eval run --case x --nope` in the doc → red (and the negative tests below).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evalCommand } from './commands/eval.js';

const DOC = join(import.meta.dirname, '..', '..', '..', '..', 'docs', 'self-host', 'eval-commands.md');

/** The usage text of each subcommand, from the blocks of the eval USAGE (blocks are separated by a blank line). */
export function usageBySubcommand(usage: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of usage.split('\n\n')) {
    for (const m of block.matchAll(/^\s*(?:usage: )?tma eval (grader prove|judge calibrate|[a-z]+)\b/gm)) {
      if (m[1] === 'case' || ['run', 'grade', 'diff', 'trajectory', 'upload', 'grader prove', 'judge calibrate'].includes(m[1]!)) {
        out.set(m[1]!, `${out.get(m[1]!) ?? ''}\n${block}`);
      }
    }
  }
  return out;
}

/** The shell commands of the fenced bash/sh blocks, with `\` continuations joined. */
export function shellCommands(md: string): string[] {
  const cmds: string[] = [];
  let inShell = false;
  let inOther = false;
  let pending = '';
  for (const line of md.split('\n')) {
    const fence = /^```([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (fence) {
      if (inShell || inOther) {
        if (pending) cmds.push(pending);
        pending = '';
        inShell = inOther = false;
      } else if (['bash', 'sh', 'shell'].includes(fence[1]!)) inShell = true;
      else inOther = true;
      continue;
    }
    if (!inShell) continue;
    const t = line.trim();
    if (t.startsWith('#')) continue;
    if (t.endsWith('\\')) pending += `${t.slice(0, -1)} `;
    else {
      cmds.push(`${pending}${t}`);
      pending = '';
    }
  }
  return cmds;
}

/** Every reason a `tma eval` command in the text names something that the usage does not list. */
export function docViolations(md: string, usage: string): string[] {
  const subs = usageBySubcommand(usage);
  const allFlags = new Set(usage.match(/--[a-z][a-z-]*/g) ?? []);
  const problems: string[] = [];
  for (const cmd of shellCommands(md)) {
    const m = /(?:^|[\s;&|(])(?:npx\s+@devfellowship\/tma(?:@\S+)?|tma)\s+eval(\s.*|$)/.exec(cmd);
    if (!m) continue;
    // Words up to the end of the command: stop at a pipe, a redirect or && ; the grader argv after `--` is not ours.
    const words = m[1]!.trim().split(/\s+/).filter(Boolean);
    const stop = words.findIndex((w) => ['|', '&&', '||', ';', '>', '>>', '<'].includes(w));
    const own = (stop >= 0 ? words.slice(0, stop) : words);
    const dd = own.indexOf('--');
    const args = dd >= 0 ? own.slice(0, dd) : own;
    const first = args[0];
    const sub = first === 'grader' || first === 'judge' ? `${first} ${args[1] ?? ''}` : first;
    if (!sub || !subs.has(sub)) {
      problems.push(`"${cmd}": "tma eval ${sub ?? ''}" is not a subcommand in the eval USAGE`);
      continue;
    }
    const text = subs.get(sub)!;
    for (const w of args) {
      if (!w.startsWith('--')) continue;
      const flag = w.replace(/=.*$/, '').replace(/[`"',;]+$/, '');
      if (!new RegExp(`${flag}(?![a-z-])`).test(text)) problems.push(`"${cmd}": ${flag} is not a flag of "tma eval ${sub}" in the eval USAGE`);
    }
  }
  // A bare flag in the prose (`--dry-run`) must exist in the USAGE of some subcommand.
  for (const m of md.matchAll(/`(--[a-z][a-z-]*)(?:[ =][^`]*)?`/g)) {
    if (!allFlags.has(m[1]!)) problems.push(`prose names ${m[1]}, which no eval USAGE lists`);
  }
  return problems;
}

describe('docs/self-host/eval-commands.md follows the eval USAGE', () => {
  const usage = evalCommand.usage!;
  const doc = readFileSync(DOC, 'utf-8');

  it('the USAGE has a section for each subcommand', () => {
    expect([...usageBySubcommand(usage).keys()].sort()).toEqual(['case', 'diff', 'grade', 'grader prove', 'judge calibrate', 'run', 'trajectory', 'upload']);
  });

  it('the doc has tma eval commands to check', () => {
    expect(shellCommands(doc).filter((c) => /\beval\b/.test(c)).length).toBeGreaterThan(10);
  });

  it('every tma eval subcommand and flag in the doc is in the USAGE', () => {
    expect(docViolations(doc, usage)).toEqual([]);
  });

  it('negative: an unknown subcommand, an unknown flag and a flag of another subcommand are caught', () => {
    const bad = ['```bash', 'tma eval frobnicate --case x', 'tma eval run --case x --nope 1', 'tma eval diff a b --dry-run', '```', 'Use `--ghost`.'].join('\n');
    const v = docViolations(bad, usage);
    expect(v).toHaveLength(4);
    expect(v.join('\n')).toMatch(/frobnicate/);
    expect(v.join('\n')).toMatch(/--nope/);
    expect(v.join('\n')).toMatch(/--dry-run is not a flag of "tma eval diff"/);
    expect(v.join('\n')).toMatch(/--ghost/);
  });

  it('positive: continuation lines, the launcher form and the grader argv after -- are accepted', () => {
    const ok = ['```bash', 'tma eval grade --case a \\', '  --dry-run --trace t', 'npx @devfellowship/tma@0.1.0 eval diff a b', 'tma eval grader prove ./g --timeout 5 -- python3 grade.py --whatever', '```'].join('\n');
    expect(docViolations(ok, usage)).toEqual([]);
  });
});

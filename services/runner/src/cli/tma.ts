#!/usr/bin/env node
// The `tma` CLI of the TestMyAgent local runner (plan 20261026-tma-local-runner-and-self-declared-results,
// §4). One line per command; each command lives in ./commands/. Run: npm run tma -- <command> [flags].
import type { Command } from './command.js';
import { stdio } from './command.js';
import { agentCommand } from './commands/agent.js';
import { evaluationsCommand } from './commands/evaluations.js';
import { gradeCommand } from './commands/grade.js';
import { loginCommand, logoutCommand } from './commands/login.js';
import { runCommand } from './commands/run.js';
import { tasksCommand } from './commands/tasks.js';
import { uploadCommand } from './commands/upload.js';
import { workspaceCommand } from './commands/workspace.js';
import { exitAllowed, installSignalCleanup } from './cleanup.js';
import { CliError } from './env.js';
import { CLI_VERSION } from './version.js';

export const COMMANDS: Command[] = [loginCommand, logoutCommand, agentCommand, uploadCommand, evaluationsCommand, tasksCommand, workspaceCommand, gradeCommand, runCommand];

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [`tma ${CLI_VERSION} — the TestMyAgent local runner`, '', 'commands:', ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`), '', 'tma <command> --help for its flags'].join('\n');
}

export async function main(argv: string[], io = stdio): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    io.out(helpText());
    return name ? 0 : 1;
  }
  if (name === '--version' || name === 'version') {
    io.out(CLI_VERSION);
    return 0;
  }
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    io.err(`unknown command: ${name}\n\n${helpText()}`);
    return 1;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    io.out(cmd.usage);
    return 0;
  }
  try {
    return await cmd.main(rest, io);
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`tma ${name}: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/cli/tma.ts')) {
  installSignalCleanup();
  main(process.argv.slice(2)).then(async (code) => {
    await exitAllowed();
    process.exit(code);
  });
}

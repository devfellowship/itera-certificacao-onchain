// `tma workspace --task <slug> | --task-dir <dir> --dest <dir>`: write the PUBLIC workspace of a task
// (environment files, public tests, and the instruction as INSTRUCTION.md). Never the hidden tests,
// never the solution. The user's own harness edits this folder; `tma grade` then grades it. No Docker.
import { has, parseArgs, required } from '../args.js';
import type { Command } from '../command.js';
import { CliError } from '../env.js';
import { materializeLocalWorkspace, INSTRUCTION_FILE } from '../local.js';
import { selectTasks, TASK_FLAGS } from '../tasks.js';
import { loadRunProfile } from '../../run-profile.js';

const USAGE = `usage: tma workspace --task <slug> --dest <dir> [--install]
       tma workspace --task-dir <folder> --dest <dir> [--install]
  Writes what an agent may see: environment files, public tests and ${INSTRUCTION_FILE}.
  The hidden tests and the solution are never written. <dir> must be new or empty.
  --install   also install the dependencies (npm ci, needs network) so the public tests can run.
  Edit the folder with your own harness, then: tma grade --task <slug> --workspace <dir> ...`;

export const workspaceCommand: Command = {
  name: 'workspace',
  summary: 'Write the public workspace of a task (no hidden tests) for your own harness; no Docker',
  usage: USAGE,
  async main(argv, io) {
    const a = parseArgs(argv, { ...TASK_FLAGS, dest: {}, install: { boolean: true } });
    const dest = required(a, 'dest', USAGE);
    const { items } = await selectTasks(a);
    if (items.length !== 1) throw new CliError('tma workspace takes ONE task folder');
    const profile = loadRunProfile();
    const w = await materializeLocalWorkspace(items[0]!, dest, { install: has(a, 'install'), installCmd: profile.install_cmd, installTimeoutMs: profile.timeouts.install_sec * 1000 });
    io.out(`workspace written to ${w.dir}`);
    io.out(`instruction: ${w.instruction}`);
    io.out(`edit the folder with your harness, then: tma grade --workspace ${dest} --task ... --agent <id> --model <id> --out result.json`);
    return 0;
  },
};

// `tma tasks [--json]`: the curated tasks of the bundle in this runner (benchmarks/): slug and version.
// It reads the disk only, so it works offline.
import { has, parseArgs } from '../args.js';
import type { Command } from '../command.js';
import { localBundles } from '../tasks.js';

const USAGE = `usage: tma tasks [--json]
  Lists the curated tasks of this runner, one line each: slug, version, title.
  Run one with: tma run --task <slug> ...   Work offline on one with: tma workspace --task <slug> ...`;

export interface TaskListing {
  slug: string;
  version: string;
  title: string;
  /** An MCP task needs the TMA sidecars: it runs hosted only (v1). */
  hosted_only: boolean;
}

export async function listTasks(benchmarksDir?: string): Promise<TaskListing[]> {
  return (await localBundles(benchmarksDir)).map((b) => ({ slug: b.name, version: b.version, title: b.title, hosted_only: b.hasMcp }));
}

export const tasksCommand: Command = {
  name: 'tasks',
  summary: 'List the curated tasks of this runner (slug and version); works offline',
  usage: USAGE,
  async main(argv, io) {
    const a = parseArgs(argv, { json: { boolean: true } });
    const tasks = await listTasks();
    if (has(a, 'json')) {
      io.out(JSON.stringify(tasks, null, 2));
      return 0;
    }
    const width = Math.max(4, ...tasks.map((t) => t.slug.length));
    for (const t of tasks) {
      io.out(`${t.slug.padEnd(width)}  v${t.version.padEnd(4)}  ${t.title.slice(0, 70)}${t.hosted_only ? '  [MCP: hosted only]' : ''}`.trimEnd());
    }
    return 0;
  },
};

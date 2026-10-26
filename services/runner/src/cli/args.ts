// Argument parsing of the `tma` CLI: `--name value`, `--name=value`, repeatable flags, boolean
// flags and positionals. No dependency. Each command declares its flags; an unknown flag is an error.
import { CliError } from './env.js';

export interface FlagSpec {
  /** Takes no value (`--dry-run`). */
  boolean?: boolean;
  /** May be given more than once (`--task-dir a --task-dir b`). */
  repeat?: boolean;
  /** Another name of the same flag (`--dest` for `--out`). */
  alias?: string;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
}

export function parseArgs(argv: string[], spec: Record<string, FlagSpec>): ParsedArgs {
  const byName = new Map<string, string>();
  for (const [name, s] of Object.entries(spec)) {
    byName.set(name, name);
    if (s.alias) byName.set(s.alias, name);
  }
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const raw = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const name = byName.get(raw);
    if (!name) throw new CliError(`unknown option --${raw}`);
    const s = spec[name]!;
    let value: string;
    if (s.boolean) {
      if (eq >= 0) throw new CliError(`--${raw} takes no value`);
      value = 'true';
    } else if (eq >= 0) {
      value = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new CliError(`--${raw} needs a value`);
      value = next;
      i++;
    }
    const list = flags.get(name) ?? [];
    if (list.length > 0 && !s.repeat) throw new CliError(`--${raw} is given more than once`);
    list.push(value);
    flags.set(name, list);
  }
  return { positionals, flags };
}

export function flag(a: ParsedArgs, name: string): string | undefined {
  return a.flags.get(name)?.[0];
}

export function flagList(a: ParsedArgs, name: string): string[] {
  return a.flags.get(name) ?? [];
}

export function has(a: ParsedArgs, name: string): boolean {
  return a.flags.has(name);
}

export function required(a: ParsedArgs, name: string, usage: string): string {
  const v = flag(a, name);
  if (v === undefined || v === '') throw new CliError(`--${name} is required\n${usage}`);
  return v;
}

/** A number flag in [min, max]; `integer` refuses a fraction. Undefined when absent. */
export function numberFlag(a: ParsedArgs, name: string, range: { min: number; max: number; integer?: boolean }): number | undefined {
  const raw = flag(a, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || n < range.min || n > range.max || (range.integer && !Number.isInteger(n))) {
    throw new CliError(`--${name} must be ${range.integer ? 'an integer' : 'a number'} from ${range.min} to ${range.max} (got ${raw.slice(0, 40)})`);
  }
  return n;
}

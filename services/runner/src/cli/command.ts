// The command shape of the `tma` CLI. One file per command in ./commands/, one line per command in
// tma.ts. Commands print the human output to `out` (stdout) and progress to `err` (stderr).
export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface Command {
  name: string;
  /** One line for `tma help`. */
  summary: string;
  usage: string;
  /** Returns the process exit code. Throws CliError for a user error (printed without a stack). */
  main: (argv: string[], io: Io) => Promise<number>;
}

export const stdio: Io = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

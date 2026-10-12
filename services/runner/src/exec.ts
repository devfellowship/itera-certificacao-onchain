import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the process (SIGKILL) after this many ms. */
  timeoutMs?: number;
  /** Bytes written to stdin, then stdin is closed. */
  input?: Buffer | string;
}

/** Spawn without a shell. Arguments never pass through shell parsing. */
export function exec(cmd: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs)
      : null;
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** Pipe the stdout of one command into the stdin of another (e.g. `tar c | docker cp -`). */
export function pipe(
  from: { cmd: string; args: string[]; cwd?: string },
  to: { cmd: string; args: string[]; cwd?: string },
): Promise<{ fromCode: number; toCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const a = spawn(from.cmd, from.args, { cwd: from.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const b = spawn(to.cmd, to.args, { cwd: to.cwd, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    a.stderr.on('data', (c) => (stderr += c.toString()));
    b.stderr.on('data', (c) => (stderr += c.toString()));
    // If the reader exits early, the writer gets EPIPE: report it through the exit codes, not a crash.
    b.stdin.on('error', () => undefined);
    a.stdout.pipe(b.stdin);
    let fromCode: number | null = null;
    let toCode: number | null = null;
    const done = () => {
      if (fromCode !== null && toCode !== null) resolve({ fromCode, toCode, stderr });
    };
    a.on('error', reject);
    b.on('error', reject);
    a.on('close', (code) => {
      fromCode = code ?? 1;
      done();
    });
    b.on('close', (code) => {
      toCode = code ?? 1;
      done();
    });
  });
}

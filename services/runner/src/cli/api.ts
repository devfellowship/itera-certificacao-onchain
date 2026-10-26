// The HTTP calls of the `tma` CLI to the TestMyAgent API (task L7). `fetch` is a parameter, so a test
// runs every command without a network. An error message never holds the bearer token or a body.
import { CliError } from './env.js';

export type Fetch = typeof fetch;

export interface ApiAnswer {
  status: number;
  /** The parsed JSON body, or null. */
  body: Record<string, unknown> | null;
}

export interface CallOptions {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  body?: unknown;
  token?: string;
  fetchImpl?: Fetch;
}

export async function apiCall(base: string, path: string, opts: CallOptions = {}): Promise<ApiAnswer> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (e) {
    throw new CliError(`cannot reach ${base} (${e instanceof Error ? e.message.slice(0, 120) : 'network error'})`);
  }
  const text = await res.text().catch(() => '');
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** `<error code>: <message>` of an API refusal, for the user. */
export function describeRefusal(a: ApiAnswer): string {
  const code = typeof a.body?.error === 'string' ? a.body.error : `HTTP ${a.status}`;
  const message = typeof a.body?.message === 'string' ? a.body.message : '';
  const path = typeof a.body?.path === 'string' ? ` at ${a.body.path}` : '';
  if (a.status === 401) return `${code}${message ? `: ${message}` : ''}. Run: tma login`;
  return `${code}${path}${message ? `: ${message}` : ''}`;
}

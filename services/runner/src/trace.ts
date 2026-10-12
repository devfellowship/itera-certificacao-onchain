import type { ParsedTrace, RunAction } from './types.js';

export const WORKSPACE_IN_SANDBOX = '/workspace';
const MAX_TARGET = 300;

function truncate(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_TARGET ? `${oneLine.slice(0, MAX_TARGET - 1)}…` : oneLine;
}

/** Make sandbox paths relative to the workspace root, so no container path leaks. */
export function relativize(value: string): string {
  return value.split(`${WORKSPACE_IN_SANDBOX}/`).join('').split(WORKSPACE_IN_SANDBOX).join('.');
}

function targetOf(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  for (const key of ['filePath', 'path', 'command', 'pattern', 'url', 'name', 'description']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return truncate(relativize(value));
  }
  return null;
}

/**
 * Parse the output of `opencode run --format json` (one JSON event per line).
 * A `tool_use` event is emitted once per tool call, when the call finishes
 * (state.status = completed | error). Lines that are not JSON are ignored.
 */
export function parseOpencodeEvents(text: string): ParsedTrace {
  const actions: RunAction[] = [];
  const errors: string[] = [];
  const usage = { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event?.type === 'tool_use' && event.part?.type === 'tool') {
      const state = event.part.state ?? {};
      const started = typeof state.time?.start === 'number' ? state.time.start : event.timestamp;
      actions.push({
        seq: actions.length + 1,
        tool: String(event.part.tool ?? 'unknown'),
        target: targetOf(state.input),
        ok: state.status === 'completed',
        occurredAt: new Date(typeof started === 'number' ? started : Date.now()).toISOString(),
      });
    } else if (event?.type === 'step_finish') {
      usage.steps += 1;
      usage.inputTokens += Number(event.part?.tokens?.input ?? 0);
      usage.outputTokens += Number(event.part?.tokens?.output ?? 0);
      usage.costUsd += Number(event.part?.cost ?? 0);
    } else if (event?.type === 'error') {
      const data = event.error?.data ?? {};
      errors.push(truncate(`${event.error?.name ?? 'Error'}: ${data.message ?? JSON.stringify(data)}`));
    }
  }
  usage.costUsd = Math.round(usage.costUsd * 1e6) / 1e6;
  return { actions, usage, errors };
}

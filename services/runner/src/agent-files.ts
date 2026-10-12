import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import type { AgentFile } from './jobs.js';

const MAX_TOTAL_BYTES = 512 * 1024;

/** Only these agent files reach the workspace (lane C snapshots the same set). */
export function isAllowedAgentPath(path: string): boolean {
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  const clean = normalize(path);
  if (clean !== path || clean.startsWith('..') || clean.split('/').includes('..')) return false;
  return clean === 'AGENTS.md' || clean === 'CLAUDE.md' || (clean.startsWith('skills/') && clean.length > 'skills/'.length);
}

/**
 * Write the snapshot from agent_versions.files to `dir`. Files outside the allow list are skipped
 * and reported, never written. Throws when the snapshot is larger than 512 KB.
 */
export async function materializeAgentFiles(files: AgentFile[], dir: string): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const file of files) {
    if (typeof file?.path !== 'string' || typeof file.content !== 'string' || !isAllowedAgentPath(file.path)) {
      skipped.push(String(file?.path ?? '?'));
      continue;
    }
    const bytes = file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf-8');
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('agent files exceed 512 KB');
    const target = join(dir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
    written.push(file.path);
  }
  return { written, skipped };
}

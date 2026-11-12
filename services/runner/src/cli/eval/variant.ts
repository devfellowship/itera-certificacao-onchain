// `tma-variant/1`: one variant of an eval run, as a file on the host (plan C3 T3).
//
// A variant is the ONE changed input that a run measures. Two kinds:
//   - patch: a fixed output (a reference solution, a recorded output, or no change at all). No model,
//            no key. The kit grades the patch as if an agent had written it.
//   - agent: opencode in the TMA sandbox with an agent folder and a model (the `tma run` path).
//
// variant_sha256 is the digest of what the run consumes (the patch bytes, or the agent files + model +
// profile); the label and the prediction describe the variant and are not in it. A non-baseline variant
// needs a WRITTEN prediction (book p38) before it runs; the kit stores it next to the output and never
// lets it change once a run exists. A baseline has change_kind none and no prediction (tma-local-result/2).
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { VARIANT_CHANGE_KINDS } from '@itera/contracts';
import { CliError } from '../env.js';
import { checkAgentDir } from '../local.js';
import { AGENT_FILES } from '../../workspace.js';
import { sha256 } from './case.js';

export const VARIANT_FORMAT = 'tma-variant/1';
export const VARIANT_MAX_BYTES = 64 * 1024;
/** A patch variant: the largest patch the kit reads (the grader applies it with git). */
export const PATCH_MAX_BYTES = 4 * 1024 * 1024;
const LABEL = /^[A-Za-z0-9 .,:;/()+\-_%$=&'#]{1,60}$/;

export interface VariantFile {
  schema: typeof VARIANT_FORMAT;
  label: string;
  kind: 'patch' | 'agent';
  change_kind: (typeof VARIANT_CHANGE_KINDS)[number];
  is_baseline: boolean;
  prediction: string | null;
  /** kind patch: a patch file, relative to the variant file. null = the empty output (no change). */
  patch?: string | null;
  /** kind agent: the agent folder (relative to the variant file), the model and the run profile. */
  agent?: { agent_dir: string; model: string; profile?: string };
}

export interface ResolvedVariant {
  file: VariantFile;
  path: string;
  variantSha256: string;
  predictionSha256: string | null;
  /** kind patch: the patch text ('' for the empty output). */
  patchText: string | null;
  /** kind agent: the absolute agent folder. */
  agentDir: string | null;
}

/** RFC 8785-style canonical JSON (sorted keys, no spaces): the input of a digest. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every reason the value is not a valid tma-variant/1 file. Empty = valid. */
export function variantErrors(v: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(v)) return ['/: a variant is a JSON object'];
  const allowed = ['schema', 'label', 'kind', 'change_kind', 'is_baseline', 'prediction', 'patch', 'agent'];
  for (const k of Object.keys(v)) if (!allowed.includes(k)) errors.push(`/${k}: unknown key (a variant carries no environment, no key, no secret)`);
  if (v.schema !== VARIANT_FORMAT) errors.push(`/schema: must be ${VARIANT_FORMAT}`);
  if (typeof v.label !== 'string' || !LABEL.test(v.label)) errors.push('/label: 1 to 60 characters: letters, digits, space and . , : ; / ( ) + - _ % $ = & \' #');
  if (v.kind !== 'patch' && v.kind !== 'agent') errors.push('/kind: patch or agent');
  if (!VARIANT_CHANGE_KINDS.includes(v.change_kind as never)) errors.push(`/change_kind: one of ${VARIANT_CHANGE_KINDS.join(', ')}`);
  if (typeof v.is_baseline !== 'boolean') errors.push('/is_baseline: true or false');
  if (v.is_baseline === true) {
    if (v.change_kind !== 'none') errors.push('/change_kind: a baseline is the base agent unchanged (none)');
    if (v.prediction !== null) errors.push('/prediction: a baseline has no prediction (null)');
  } else if (v.is_baseline === false) {
    if (typeof v.prediction !== 'string' || v.prediction.trim().length === 0 || v.prediction.length > 4000) {
      errors.push('/prediction: write what you expect against the baseline BEFORE the run (1 to 4000 characters, book p38)');
    }
  }
  if (v.kind === 'patch') {
    if ('agent' in v) errors.push('/agent: only for kind agent');
    if (!('patch' in v)) errors.push('/patch: required for kind patch (a file, or null for the empty output)');
    else if (v.patch !== null && (typeof v.patch !== 'string' || v.patch.length === 0 || v.patch.length > 400)) errors.push('/patch: a file path, or null');
  }
  if (v.kind === 'agent') {
    if ('patch' in v) errors.push('/patch: only for kind patch');
    const a = v.agent;
    if (!isObject(a)) errors.push('/agent: {agent_dir, model, profile?}');
    else {
      for (const k of Object.keys(a)) if (!['agent_dir', 'model', 'profile'].includes(k)) errors.push(`/agent/${k}: unknown key`);
      if (typeof a.agent_dir !== 'string' || a.agent_dir.length === 0) errors.push('/agent/agent_dir: a folder');
      if (typeof a.model !== 'string' || a.model.length === 0) errors.push('/agent/model: a model id');
      if ('profile' in a && (typeof a.profile !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(a.profile))) errors.push('/agent/profile: a run profile name');
    }
  }
  return errors;
}

/** The digest of the agent files that the sandbox copies (AGENTS.md, CLAUDE.md, skills/**). */
export async function agentFilesSha256(agentDir: string): Promise<string> {
  const entries: Array<[string, string]> = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) entries.push([relative(agentDir, p), sha256(await readFile(p))]);
    }
  };
  for (const name of AGENT_FILES) {
    const p = join(agentDir, name);
    if ((await stat(p).catch(() => null))?.isFile()) entries.push([name, sha256(await readFile(p))]);
  }
  if ((await stat(join(agentDir, 'skills')).catch(() => null))?.isDirectory()) await walk(join(agentDir, 'skills'));
  return sha256(canonicalJson(entries.sort((a, b) => a[0].localeCompare(b[0]))));
}

/** Read, check and resolve one variant file. */
export async function readVariant(file: string): Promise<ResolvedVariant> {
  const path = resolve(file);
  const raw = await readFile(path).catch(() => null);
  if (!raw) throw new CliError(`no variant file at ${file}`);
  if (raw.length > VARIANT_MAX_BYTES) throw new CliError(`${file} is above ${VARIANT_MAX_BYTES} bytes: a variant file names its inputs, it does not hold them`);
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf-8'));
  } catch {
    throw new CliError(`${file} is not JSON`);
  }
  const errors = variantErrors(value);
  if (errors.length > 0) throw new CliError(`${file} is not a valid ${VARIANT_FORMAT} file:\n  ${errors.slice(0, 12).join('\n  ')}`);
  const v = value as VariantFile;
  const base = dirname(path);
  const predictionSha256 = v.prediction === null ? null : sha256(v.prediction);
  if (v.kind === 'patch') {
    let patchText = '';
    if (v.patch) {
      const p = resolve(base, v.patch);
      const st = await stat(p).catch(() => null);
      if (!st?.isFile()) throw new CliError(`the variant patch ${v.patch} is not a file (relative to ${file})`);
      if (st.size > PATCH_MAX_BYTES) throw new CliError(`the variant patch is ${st.size} bytes; the limit is ${PATCH_MAX_BYTES}`);
      patchText = await readFile(p, 'utf-8');
    }
    const variantSha256 = sha256(canonicalJson({ kind: 'patch', patch_sha256: sha256(patchText) }));
    return { file: v, path, variantSha256, predictionSha256, patchText, agentDir: null };
  }
  const agentDir = await checkAgentDir(resolve(base, v.agent!.agent_dir));
  const variantSha256 = sha256(
    canonicalJson({ kind: 'agent', model: v.agent!.model, profile: v.agent!.profile ?? 'opencode', agent_files_sha256: await agentFilesSha256(agentDir) }),
  );
  return { file: v, path, variantSha256, predictionSha256, patchText: null, agentDir };
}

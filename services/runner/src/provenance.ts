// Result provenance of a run (K11, plan 20261012-testmyagent-dfl-benchmark-tasks).
//
// Tainan's research report: "record agent commit, effective model, params, env version, CPU/mem,
// time limit per result". The worker builds this record when the run ends and writes it next to
// the score (db/migrations/0017_run_provenance.sql): typed columns for what a report groups on,
// plus the full record in runs.provenance. Nothing here is a secret.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvidenceManifest } from '../../evaluator/src/types.js';
import type { AgentRunResult } from './agent-run.js';
import type { McpSidecarPlan } from './mcp-sidecar.js';
import { topKey } from './model-usage.js';
import type { RouteId } from './model-route.js';
import type { SandboxConfig } from './sandbox.js';

/** Facts about this worker, read once at boot. */
export interface RunnerFacts {
  /** sha256 of services/runner/{src,sandbox,profiles} (sorted paths + bytes): the runner code that ran. */
  runnerDigest: string;
  /** ITERA_GIT_COMMIT / SOURCE_COMMIT when the deployment sets one; else null. */
  runnerCommit: string | null;
  /** The sandbox image tag and its image Id (sha256:…). */
  sandboxImage: string;
  sandboxImageId: string | null;
  /** opencode version pinned in sandbox/Dockerfile (`opencode-ai@x.y.z`). */
  opencodeVersion: string | null;
}

/** The typed columns of 0017 + the full record. */
export interface RunProvenance {
  route: RouteId;
  modelRequested: string;
  modelEffective: string | null;
  modelProvider: string | null;
  costSource: string;
  rateLimited: number;
  wallMs: number | null;
  timeoutS: number | null;
  record: Record<string, unknown>;
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (e.isFile()) out.push(full.slice(base.length + 1));
  }
  return out;
}

/** sha256 over the sorted relative paths and bytes of the given directories. */
export async function treeDigest(root: string, dirs: string[]): Promise<string> {
  const h = createHash('sha256');
  for (const d of dirs) {
    const files = (await listFiles(join(root, d))).filter((f) => !f.includes('node_modules')).sort();
    for (const f of files) {
      h.update(`${d}/${f}\0`);
      h.update(await readFile(join(root, d, f)));
      h.update('\0');
    }
  }
  return h.digest('hex');
}

/** `opencode-ai@1.18.31` → `1.18.31`, from the sandbox Dockerfile text. */
export function opencodeVersionOf(dockerfile: string): string | null {
  return /opencode-ai@([0-9][0-9A-Za-z.+-]*)/.exec(dockerfile)?.[1] ?? null;
}

export async function runnerFacts(runnerDir: string, sandboxImage: string, imageId: string | null, env: NodeJS.ProcessEnv = process.env): Promise<RunnerFacts> {
  const dockerfile = await readFile(join(runnerDir, 'sandbox', 'Dockerfile'), 'utf-8').catch(() => '');
  return {
    runnerDigest: await treeDigest(runnerDir, ['src', 'sandbox', 'profiles']),
    runnerCommit: env.ITERA_GIT_COMMIT || env.SOURCE_COMMIT || null,
    sandboxImage,
    sandboxImageId: imageId,
    opencodeVersion: opencodeVersionOf(dockerfile),
  };
}

/** The agent's wall cap for a task: its `agent.timeout_sec`, capped by the worker's maximum. */
export function taskWallMs(timeoutSec: number | null | undefined, config: Pick<SandboxConfig, 'wallMs' | 'maxWallMs'>): number {
  if (typeof timeoutSec !== 'number' || !Number.isFinite(timeoutSec) || timeoutSec <= 0) return config.wallMs;
  return Math.min(Math.round(timeoutSec * 1000), config.maxWallMs);
}

export function buildProvenance(input: {
  model: string;
  route: RouteId;
  agentCommit: string | null;
  agentFiles: string[];
  task: { id: string; version: string; contractDigest: string | null; timeoutSec: number | null };
  agent: AgentRunResult | null;
  config: SandboxConfig;
  facts: RunnerFacts | null;
  mcp: McpSidecarPlan[];
  manifest: EvidenceManifest | null;
}): RunProvenance {
  const u = input.agent?.modelUsage ?? null;
  const modelEffective = u ? topKey(u.effectiveModels) : null;
  const modelProvider = u ? topKey(u.providers) : null;
  const costSource = u?.costSource ?? 'none';
  const env = input.manifest?.environment;
  const record = {
    schema: 'itera.run-provenance/1',
    agent: { commit: input.agentCommit, files: input.agentFiles },
    task: { id: input.task.id, version: input.task.version, contract_digest: input.task.contractDigest },
    model: {
      requested: input.model,
      route: input.route,
      effective: modelEffective,
      provider: modelProvider,
      effective_models: u?.effectiveModels ?? {},
      providers: u?.providers ?? {},
      requested_models: u?.requestedModels ?? {},
      cost_source: costSource,
      rate_limited: u?.rateLimited ?? 0,
      rate_limited_final: u?.rateLimitedFinal ?? 0,
    },
    params: {
      run_profile: input.config.profile.name,
      opencode_version: input.facts?.opencodeVersion ?? null,
      request: u?.params ?? null,
    },
    env: {
      runner_commit: input.facts?.runnerCommit ?? null,
      runner_digest: input.facts?.runnerDigest ?? null,
      sandbox_image: input.facts?.sandboxImage ?? input.config.image,
      sandbox_image_id: input.facts?.sandboxImageId ?? null,
      mcp: input.mcp.map((p) => ({ name: p.name, catalog: p.catalog, image: p.imageRef, seed_sha256: p.seedSha256 })),
      grader: env ? { executor: env.executor, environment_digest: input.manifest?.environment_digest ?? null } : null,
      evaluator_digest: input.manifest?.evaluator_digest ?? null,
      evaluator_commit: input.manifest?.evaluator_commit ?? null,
    },
    resources: {
      sandbox: { cpus: input.config.cpus, memory: input.config.memory, pids: input.config.pidsLimit },
      mcp: input.mcp.map((p) => ({ name: p.name, ...p.limits })),
    },
    limits: {
      timeout_s: input.task.timeoutSec,
      wall_ms_cap: input.config.wallMs,
      wall_ms: input.agent?.durationMs ?? null,
      max_cost_usd: input.config.maxCostUsd,
    },
  };
  return {
    route: input.route,
    modelRequested: input.model,
    modelEffective,
    modelProvider,
    costSource,
    rateLimited: u?.rateLimited ?? 0,
    wallMs: input.agent?.durationMs ?? null,
    timeoutS: input.task.timeoutSec,
    record,
  };
}

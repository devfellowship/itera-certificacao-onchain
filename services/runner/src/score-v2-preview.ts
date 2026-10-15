// Operator CLI, READ ONLY: what score version 2 (TMA-QC = B, TG 21519) would give to runs that were
// graded under version 1. It never writes: stored runs keep their version-1 score_total and their
// evidence (history is not rewritten; minted proofs pin the old bytes). Run it by hand, never from
// a deploy or a timer.
//   tsx src/score-v2-preview.ts --campaign k7-dfl-bench-1
//   tsx src/score-v2-preview.ts --run <uuid> [--run <uuid> ...]
// Needs DATABASE_URL (+ the pooler CA, like the worker). Run it inside the runner container. The
// transaction is BEGIN READ ONLY. It prints one JSON line per run and no secret.
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { hiddenRatioScore } from '../../evaluator/src/score.js';
import type { EvidenceManifest, TestSuiteResult } from '../../evaluator/src/types.js';
import { runScore } from './outcome.js';
import type { FinalStatus } from './jobs.js';

export interface PreviewRow {
  status: string;
  scoreTotal: number | null;
  evidenceManifest: unknown;
}

/**
 * Score version 2 of a stored run, from its status and its stored EvalLog only. null = the run has
 * no graded log (infra_error before grading, cancelled, still running).
 * - patch empty: a stored log has no patch text; `patch_scope.changed_files` empty = no-op.
 * - MCP gate: every scored server's assertions hold (same rule as outcome.ts allMcpStateHolds).
 */
export function scoreV2Of(row: PreviewRow): { v1: number | null; v2: number | null; hidden: string | null; gates: Record<string, boolean | null> | null } {
  const log = row.evidenceManifest as Partial<EvidenceManifest> | null;
  const hidden = log?.tests?.hidden as TestSuiteResult | undefined;
  if (!log || !hidden || !log.patch_scope || !log.score) return { v1: row.scoreTotal, v2: null, hidden: null, gates: null };
  if (log.score_version === 2) return { v1: row.scoreTotal, v2: row.scoreTotal, hidden: log.score_rule?.hidden ?? null, gates: log.score_rule?.gates ?? null };
  const servers = log.mcp?.servers ?? [];
  const scored = servers.filter((s) => s.assertions !== null || s.error);
  const mcpStateHolds = scored.length === 0 ? null : scored.every((s) => !s.error && s.assertions && s.assertions.total > 0 && s.assertions.passed === s.assertions.total);
  const r = hiddenRatioScore({
    hidden,
    patchEmpty: (log.patch_scope.changed_files ?? []).length === 0,
    patchScopeAllowed: log.patch_scope.allowed,
    mcpStateHolds,
    legacyTotal: log.score.total,
  });
  const status = row.status as FinalStatus;
  const known = ['pass', 'fail', 'invalid', 'timeout', 'infra_error'].includes(status);
  return {
    v1: row.scoreTotal,
    v2: known ? runScore(status, { score: { ...log.score, total: r.total } }) : null,
    hidden: r.rule.hidden,
    gates: { ...r.rule.gates, agent_finished: status !== 'timeout' },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { campaign: { type: 'string' }, run: { type: 'string', multiple: true } } });
  if (!values.campaign && !values.run?.length) throw new Error('usage: score-v2-preview --campaign <id> | --run <uuid> [--run <uuid> ...]');
  const { default: pg } = await import('pg');
  const { readFileSync } = await import('node:fs');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const repoRoot = resolve(process.env.ITERA_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..', '..'));
  const caPath = process.env.ITERA_DB_CA_PATH ?? join(repoRoot, 'apps', 'api', 'certs', 'supabase-pooler-ca-bundle.pem');
  const ssl = process.env.ITERA_DB_SSL === 'disable' ? false : { ca: readFileSync(caPath, 'utf-8') };
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin read only');
    const { rows } = values.campaign
      ? await client.query('select id::text, status, score_total::float8 as score_total, evidence_manifest from public.runs where campaign_id = $1 order by started_at', [values.campaign])
      : await client.query('select id::text, status, score_total::float8 as score_total, evidence_manifest from public.runs where id = any($1::uuid[])', [values.run]);
    for (const r of rows) {
      const p = scoreV2Of({ status: r.status, scoreTotal: r.score_total, evidenceManifest: r.evidence_manifest });
      console.log(JSON.stringify({ run: r.id, status: r.status, score_v1: p.v1, score_v2: p.v2, hidden: p.hidden, gates: p.gates }));
    }
    await client.query('rollback');
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

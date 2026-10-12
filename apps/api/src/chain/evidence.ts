import { digestOf } from "../domain/digest.js";
import type { ProofRun } from "./proof-store.js";

/**
 * The public evidence document — the bytes pinned to IPFS and hashed into `manifest_sha256`.
 *
 * IPFS is public and permanent, so the grader manifest is redacted first: hidden test names are
 * removed (counts stay) and temporary paths are removed from errors. The run binding (run id,
 * run-start signature, agent repo/commit, model) is added so the pinned file alone says which run
 * it proves.
 */
export const EVIDENCE_SCHEMA = "itera-evidence/v2";
/** Documents pinned before 2026-10-12 (no envelope). verify.ts reads both. */
export const EVIDENCE_SCHEMA_V1 = "itera-evidence/v1";
/** in-toto Statement v1 (https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md). No DSSE yet. */
export const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
export const EVIDENCE_PREDICATE_TYPE = "https://testmyagent.com/evidence/v2";

const TMP_PATH = /(?:\/(?:tmp|var\/folders|private\/var)\/[^\s'"`)]*)|(?:[A-Za-z]:\\[^\s'"`)]*\\Temp\\[^\s'"`)]*)/g;

export function redactText(text: string): string {
  return text.replace(TMP_PATH, "<tmp>");
}

interface SuiteLike {
  total?: number;
  passed?: number;
  failed?: number;
  cases?: Array<{ name?: string; file?: string; passed?: boolean }>;
}

function redactSuite(suite: SuiteLike | undefined, hideNames: boolean): SuiteLike | undefined {
  if (!suite || typeof suite !== "object") return suite;
  const { cases, ...counts } = suite;
  if (hideNames) return counts;
  return { ...counts, cases: (cases ?? []).map((c) => ({ ...c, file: c.file ? redactText(c.file) : c.file })) };
}

export function redactManifest(manifest: unknown): Record<string, unknown> {
  if (!manifest || typeof manifest !== "object") throw new Error("evidence manifest is missing");
  const m = structuredClone(manifest) as Record<string, unknown> & {
    tests?: { public_baseline?: SuiteLike; public_after_patch?: SuiteLike; hidden?: SuiteLike };
    errors?: unknown[];
  };
  if (m.tests) {
    m.tests = {
      public_baseline: redactSuite(m.tests.public_baseline, false),
      public_after_patch: redactSuite(m.tests.public_after_patch, false),
      hidden: redactSuite(m.tests.hidden, true),
    };
  }
  if (Array.isArray(m.errors)) m.errors = m.errors.map((e) => (typeof e === "string" ? redactText(e) : e));
  return m;
}

/**
 * The pinned evidence document, schema itera-evidence/v2: an in-toto Statement v1 whose predicate
 * is the former v1 document (run binding + redacted EvalLog). The subject names the run and carries
 * the sha256 of the canonical JSON of the redacted EvalLog. The proof hash keeps its meaning: the
 * on-chain manifest_sha256 is still the sha256 of the exact pinned bytes (ipfs.ts manifestBytes).
 * Proofs minted before this change keep their v1 bytes; nothing re-pins them.
 * Shape: packages/contracts/schemas/evidence-statement.schema.json.
 */
export function buildEvidenceDocument(run: ProofRun): Record<string, unknown> {
  // JSON round trip: the digest must cover exactly what the pinned JSON holds (no undefined keys).
  const manifest = JSON.parse(JSON.stringify(redactManifest(run.evidenceManifest))) as Record<string, unknown>;
  return {
    _type: IN_TOTO_STATEMENT_V1,
    subject: [{ name: `testmyagent-run:${run.runId}`, digest: { sha256: digestOf(manifest) } }],
    predicateType: EVIDENCE_PREDICATE_TYPE,
    predicate: {
      schema: EVIDENCE_SCHEMA,
      run: {
        run_id: run.runId,
        run_start_sig: run.runStartSig,
        benchmark_id: run.benchmarkId,
        benchmark_version: run.benchmarkVersion,
        agent_repo: run.agentRepo ?? null,
        agent_commit: run.agentCommit ?? null,
        model_id: run.modelId ?? null,
        // v2 only (a run of an evaluation): the proof nonce binds `${run_start_sig}:${slot_run_id}`.
        ...(run.evaluationId ? { evaluation_id: run.evaluationId, slot_run_id: run.slotRunId ?? run.runId } : {}),
      },
      manifest,
    },
  };
}

/** Score integer 0-100 for the U8 schema field. */
export function scoreForChain(run: ProofRun): number {
  const fromManifest = (run.evidenceManifest as { score?: { total?: unknown } } | null)?.score?.total;
  const raw = typeof run.scoreTotal === "number" ? run.scoreTotal : typeof fromManifest === "number" ? fromManifest : NaN;
  if (!Number.isFinite(raw)) throw new Error("run has no score");
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function scenarioIdOf(run: ProofRun): string {
  const fromManifest = (run.evidenceManifest as { scenario_id?: unknown } | null)?.scenario_id;
  return typeof fromManifest === "string" && fromManifest ? fromManifest : run.benchmarkId;
}

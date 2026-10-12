import type {
  Agent,
  AttestationEnvelope,
  ClaimManifest,
  CriterionResult,
  EvaluationRequest,
  Observation,
  ReleaseDeclaration,
  Run,
  TaskPack,
  TaskStatus,
  Vendor,
} from "./types.js";

/**
 * Storage seam: every route handler depends on this interface, never on `pg` directly. Production
 * wires PgRepository (repository.pg.ts); tests wire an in-memory fake (repository.fake.ts) so the
 * test suite needs no live Postgres — CI (GitHub-hosted, no DB service container) stays fast and
 * network-free, matching this repo's existing test style (vitest + fetch against a real listening
 * server, no mocked HTTP layer).
 */
export interface Repository {
  findOrCreateVendor(input: { displayName: string }): Promise<Vendor>;
  findOrCreateAgent(input: { vendorId: string; name: string; endpointUrl: string }): Promise<Agent>;
  findOrCreateReleaseDeclaration(input: {
    agentId: string;
    releaseRef: string;
    declaredConfigDigest?: string | null;
  }): Promise<ReleaseDeclaration>;
  getTaskPack(id: string, version: string): Promise<TaskPack | null>;
  listTaskPacks(): Promise<TaskPack[]>;
  findRunByIdempotencyKey(key: string): Promise<Run | null>;
  createRun(input: {
    releaseDeclarationId: string;
    taskPackId: string;
    taskPackVersion: string;
    nonce: string;
    idempotencyKey: string;
  }): Promise<Run>;
  getRun(id: string): Promise<Run | null>;
  getReleaseDeclaration(id: string): Promise<ReleaseDeclaration | null>;
  getAgent(id: string): Promise<Agent | null>;
  createObservation(input: {
    runId: string;
    requestDigest?: string | null;
    responseDigest?: string | null;
    outputArtifactRef?: string | null;
    outputArtifactContent?: string | null;
    mode: "observed" | "vendor_declared";
  }): Promise<Observation>;
  listObservations(runId: string): Promise<Observation[]>;
  /** Marks a run as resolved after the grader runs (domain/grader.ts) — the only place a run's
   * status moves out of `pending`. */
  resolveRun(input: { runId: string; status: TaskStatus; evidenceManifest: unknown; scoreTotal: number }): Promise<Run>;
  publishClaimManifest(input: {
    runId: string;
    taskRef: string;
    releaseRef: string;
    criteriaResults: CriterionResult[];
    limitations?: string | null;
  }): Promise<ClaimManifest>;
  getPublicClaimManifest(id: string): Promise<ClaimManifest | null>;
  getAttestationEnvelope(claimManifestId: string): Promise<AttestationEnvelope | null>;
  /** Records the result of a real SAS issuance (domain/solana-attestation.ts) against a published
   * claim. One envelope per claim manifest — publish only issues once per claim. */
  recordAttestationEnvelope(input: {
    claimManifestId: string;
    attestationAddress: string;
    issuerRef: string;
    schemaRef: string;
    manifestDigest: string;
    status: AttestationEnvelope["status"];
  }): Promise<AttestationEnvelope>;
  createEvaluationRequest(input: {
    requesterContact: string;
    requesterRole?: string | null;
    taskDescription: string;
  }): Promise<EvaluationRequest>;
}

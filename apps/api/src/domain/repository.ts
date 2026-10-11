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
  findRunByIdempotencyKey(key: string): Promise<Run | null>;
  createRun(input: {
    releaseDeclarationId: string;
    taskPackId: string;
    taskPackVersion: string;
    nonce: string;
    idempotencyKey: string;
  }): Promise<Run>;
  getRun(id: string): Promise<Run | null>;
  createObservation(input: {
    runId: string;
    requestDigest?: string | null;
    responseDigest?: string | null;
    outputArtifactRef?: string | null;
    mode: "observed" | "vendor_declared";
  }): Promise<Observation>;
  listObservations(runId: string): Promise<Observation[]>;
  publishClaimManifest(input: {
    runId: string;
    taskRef: string;
    releaseRef: string;
    criteriaResults: CriterionResult[];
    limitations?: string | null;
  }): Promise<ClaimManifest>;
  getPublicClaimManifest(id: string): Promise<ClaimManifest | null>;
  getAttestationEnvelope(claimManifestId: string): Promise<AttestationEnvelope | null>;
  createEvaluationRequest(input: {
    requesterContact: string;
    requesterRole?: string | null;
    taskDescription: string;
  }): Promise<EvaluationRequest>;
}

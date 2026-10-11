// Entity shapes match the 2026-10-11 migration (testmyagent.com pivot, 03_produto_mvp_72h.pdf
// section 5 "Modelo de dados e contrato de avaliação"). Field names mirror the Postgres columns.

export type TaskStatus = "pending" | "pass" | "fail" | "invalid" | "timeout" | "infra_error";

export type RegistryStatus =
  | "not_issued"
  | "pending"
  | "confirmed"
  | "mismatch"
  | "expired"
  | "closed"
  | "unavailable";

export interface Vendor {
  id: string;
  displayName: string;
}

export interface Agent {
  id: string;
  vendorId: string;
  name: string;
  endpointUrl: string;
}

export interface ReleaseDeclaration {
  id: string;
  agentId: string;
  releaseRef: string;
  declaredConfigDigest: string | null;
}

export interface TaskPack {
  id: string;
  version: string;
  fixtureDigest: string | null;
  criteriaDigest: string | null;
  evaluatorRef: string;
}

export interface Run {
  id: string;
  releaseDeclarationId: string;
  taskPackId: string;
  taskPackVersion: string;
  nonce: string;
  status: TaskStatus;
  attempts: number;
  idempotencyKey: string | null;
  // Populated by POST /evaluations/:id/dispatch once the real grader (services/evaluator,
  // spawned as a subprocess — see domain/grader.ts) has run. Null until then.
  evidenceManifest: unknown | null;
  scoreTotal: number | null;
  startedAt: string;
  completedAt: string | null;
}

export interface Observation {
  id: string;
  runId: string;
  requestDigest: string | null;
  responseDigest: string | null;
  outputArtifactRef: string | null;
  // The raw patch text the vendor's endpoint returned, frozen at dispatch time — the grader runs
  // against exactly these bytes. Null for an observation that isn't the dispatch response itself.
  outputArtifactContent: string | null;
  mode: "observed" | "vendor_declared";
  occurredAt: string;
}

export interface CriterionResult {
  requirement: string;
  result: string;
}

export interface ClaimManifest {
  id: string;
  runId: string;
  taskRef: string;
  releaseRef: string;
  criteriaResults: CriterionResult[];
  limitations: string | null;
  visibility: "private" | "public";
  canonicalDigestSha256: string | null;
  publishedAt: string | null;
}

export interface AttestationEnvelope {
  id: string;
  claimManifestId: string;
  network: string;
  attestationAddress: string | null;
  issuerRef: string | null;
  schemaRef: string | null;
  manifestDigest: string | null;
  status: RegistryStatus;
}

export interface EvaluationRequest {
  id: string;
  requesterContact: string;
  requesterRole: string | null;
  taskDescription: string;
  status: "new" | "in_review" | "scheduled" | "declined";
}

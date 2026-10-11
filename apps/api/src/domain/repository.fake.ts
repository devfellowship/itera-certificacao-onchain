import { randomUUID } from "node:crypto";
import { digestOf } from "./digest.js";
import type { Repository } from "./repository.js";
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
 * In-memory stand-in for PgRepository, same interface, used only in tests. Lets app.test.ts
 * exercise real route logic (idempotency, 404s, the publish-requires-a-resolved-run rule) without
 * a live Postgres — this repo's CI (GitHub-hosted, no DB service container) has none.
 */
export class FakeRepository implements Repository {
  vendors: Vendor[] = [];
  agents: Agent[] = [];
  releases: ReleaseDeclaration[] = [];
  taskPacks: TaskPack[] = [{ id: "webhook-ledger", version: "1", fixtureDigest: null, criteriaDigest: null, evaluatorRef: "benchmarks/webhook-ledger/evaluator" }];
  runs: Run[] = [];
  observations: Observation[] = [];
  manifests: ClaimManifest[] = [];
  envelopes: AttestationEnvelope[] = [];
  evaluationRequests: EvaluationRequest[] = [];

  async findOrCreateVendor({ displayName }: { displayName: string }): Promise<Vendor> {
    const existing = this.vendors.find((v) => v.displayName === displayName);
    if (existing) return existing;
    const vendor: Vendor = { id: randomUUID(), displayName };
    this.vendors.push(vendor);
    return vendor;
  }

  async findOrCreateAgent({ vendorId, name, endpointUrl }: { vendorId: string; name: string; endpointUrl: string }): Promise<Agent> {
    const existing = this.agents.find((a) => a.vendorId === vendorId && a.name === name);
    if (existing) {
      existing.endpointUrl = endpointUrl;
      return existing;
    }
    const agent: Agent = { id: randomUUID(), vendorId, name, endpointUrl };
    this.agents.push(agent);
    return agent;
  }

  async findOrCreateReleaseDeclaration({
    agentId,
    releaseRef,
    declaredConfigDigest,
  }: {
    agentId: string;
    releaseRef: string;
    declaredConfigDigest?: string | null;
  }): Promise<ReleaseDeclaration> {
    const existing = this.releases.find((r) => r.agentId === agentId && r.releaseRef === releaseRef);
    if (existing) {
      existing.declaredConfigDigest = declaredConfigDigest ?? null;
      return existing;
    }
    const release: ReleaseDeclaration = { id: randomUUID(), agentId, releaseRef, declaredConfigDigest: declaredConfigDigest ?? null };
    this.releases.push(release);
    return release;
  }

  async getTaskPack(id: string, version: string): Promise<TaskPack | null> {
    return this.taskPacks.find((p) => p.id === id && p.version === version) ?? null;
  }

  async findRunByIdempotencyKey(key: string): Promise<Run | null> {
    return this.runs.find((r) => r.idempotencyKey === key) ?? null;
  }

  async createRun(input: {
    releaseDeclarationId: string;
    taskPackId: string;
    taskPackVersion: string;
    nonce: string;
    idempotencyKey: string;
  }): Promise<Run> {
    const run: Run = {
      id: randomUUID(),
      releaseDeclarationId: input.releaseDeclarationId,
      taskPackId: input.taskPackId,
      taskPackVersion: input.taskPackVersion,
      nonce: input.nonce,
      status: "pending",
      attempts: 0,
      idempotencyKey: input.idempotencyKey,
      evidenceManifest: null,
      scoreTotal: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    this.runs.push(run);
    return run;
  }

  async getRun(id: string): Promise<Run | null> {
    return this.runs.find((r) => r.id === id) ?? null;
  }

  async getReleaseDeclaration(id: string): Promise<ReleaseDeclaration | null> {
    return this.releases.find((r) => r.id === id) ?? null;
  }

  async getAgent(id: string): Promise<Agent | null> {
    return this.agents.find((a) => a.id === id) ?? null;
  }

  async createObservation(input: {
    runId: string;
    requestDigest?: string | null;
    responseDigest?: string | null;
    outputArtifactRef?: string | null;
    outputArtifactContent?: string | null;
    mode: "observed" | "vendor_declared";
  }): Promise<Observation> {
    const observation: Observation = {
      id: randomUUID(),
      runId: input.runId,
      requestDigest: input.requestDigest ?? null,
      responseDigest: input.responseDigest ?? null,
      outputArtifactRef: input.outputArtifactRef ?? null,
      outputArtifactContent: input.outputArtifactContent ?? null,
      mode: input.mode,
      occurredAt: new Date().toISOString(),
    };
    this.observations.push(observation);
    return observation;
  }

  async listObservations(runId: string): Promise<Observation[]> {
    return this.observations.filter((o) => o.runId === runId);
  }

  async resolveRun(input: { runId: string; status: Run["status"]; evidenceManifest: unknown; scoreTotal: number }): Promise<Run> {
    const run = this.runs.find((r) => r.id === input.runId);
    if (!run) throw new Error(`run ${input.runId} not found`);
    run.status = input.status;
    run.evidenceManifest = input.evidenceManifest;
    run.scoreTotal = input.scoreTotal;
    run.attempts += 1;
    run.completedAt = new Date().toISOString();
    return run;
  }

  async publishClaimManifest(input: {
    runId: string;
    taskRef: string;
    releaseRef: string;
    criteriaResults: CriterionResult[];
    limitations?: string | null;
  }): Promise<ClaimManifest> {
    const digest = digestOf({
      task: input.taskRef,
      release: input.releaseRef,
      criteriaResults: input.criteriaResults,
      limitations: input.limitations ?? null,
    });
    const manifest: ClaimManifest = {
      id: randomUUID(),
      runId: input.runId,
      taskRef: input.taskRef,
      releaseRef: input.releaseRef,
      criteriaResults: input.criteriaResults,
      limitations: input.limitations ?? null,
      visibility: "public",
      canonicalDigestSha256: digest,
      publishedAt: new Date().toISOString(),
    };
    this.manifests.push(manifest);
    return manifest;
  }

  async getPublicClaimManifest(id: string): Promise<ClaimManifest | null> {
    return this.manifests.find((m) => m.id === id && m.visibility === "public") ?? null;
  }

  async getAttestationEnvelope(claimManifestId: string): Promise<AttestationEnvelope | null> {
    return this.envelopes.find((e) => e.claimManifestId === claimManifestId) ?? null;
  }

  async recordAttestationEnvelope(input: {
    claimManifestId: string;
    attestationAddress: string;
    issuerRef: string;
    schemaRef: string;
    manifestDigest: string;
    status: AttestationEnvelope["status"];
  }): Promise<AttestationEnvelope> {
    const existing = this.envelopes.find((e) => e.claimManifestId === input.claimManifestId);
    if (existing) {
      existing.attestationAddress = input.attestationAddress;
      existing.issuerRef = input.issuerRef;
      existing.schemaRef = input.schemaRef;
      existing.manifestDigest = input.manifestDigest;
      existing.status = input.status;
      return existing;
    }
    const envelope: AttestationEnvelope = {
      id: randomUUID(),
      claimManifestId: input.claimManifestId,
      network: "solana-devnet",
      attestationAddress: input.attestationAddress,
      issuerRef: input.issuerRef,
      schemaRef: input.schemaRef,
      manifestDigest: input.manifestDigest,
      status: input.status,
    };
    this.envelopes.push(envelope);
    return envelope;
  }

  async createEvaluationRequest(input: {
    requesterContact: string;
    requesterRole?: string | null;
    taskDescription: string;
  }): Promise<EvaluationRequest> {
    const request: EvaluationRequest = {
      id: randomUUID(),
      requesterContact: input.requesterContact,
      requesterRole: input.requesterRole ?? null,
      taskDescription: input.taskDescription,
      status: "new",
    };
    this.evaluationRequests.push(request);
    return request;
  }
}

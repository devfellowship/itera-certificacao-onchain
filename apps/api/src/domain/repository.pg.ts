import type { Pool } from "pg";
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

function toRun(row: {
  id: string;
  release_declaration_id: string;
  task_pack_id: string;
  task_pack_version: string;
  nonce: string;
  status: Run["status"];
  attempts: number;
  idempotency_key: string | null;
  evidence_manifest: unknown | null;
  score_total: number | null;
  started_at: string;
  completed_at: string | null;
}): Run {
  return {
    id: row.id,
    releaseDeclarationId: row.release_declaration_id,
    taskPackId: row.task_pack_id,
    taskPackVersion: row.task_pack_version,
    nonce: row.nonce,
    status: row.status,
    attempts: row.attempts,
    idempotencyKey: row.idempotency_key,
    evidenceManifest: row.evidence_manifest,
    scoreTotal: row.score_total,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export class PgRepository implements Repository {
  constructor(private readonly pool: Pool) {}

  async findOrCreateVendor({ displayName }: { displayName: string }): Promise<Vendor> {
    const existing = await this.pool.query<{ id: string; display_name: string }>(
      `select id, display_name from public.vendors where display_name = $1 limit 1`,
      [displayName],
    );
    if (existing.rows[0]) return { id: existing.rows[0].id, displayName: existing.rows[0].display_name };
    const inserted = await this.pool.query<{ id: string; display_name: string }>(
      `insert into public.vendors (display_name) values ($1) returning id, display_name`,
      [displayName],
    );
    const row = inserted.rows[0]!;
    return { id: row.id, displayName: row.display_name };
  }

  async findOrCreateAgent({
    vendorId,
    name,
    endpointUrl,
  }: {
    vendorId: string;
    name: string;
    endpointUrl: string;
  }): Promise<Agent> {
    const result = await this.pool.query<{ id: string; vendor_id: string; name: string; endpoint_url: string }>(
      `insert into public.agents (vendor_id, name, endpoint_url)
       values ($1, $2, $3)
       on conflict (vendor_id, name) do update set endpoint_url = excluded.endpoint_url
       returning id, vendor_id, name, endpoint_url`,
      [vendorId, name, endpointUrl],
    );
    const row = result.rows[0]!;
    return { id: row.id, vendorId: row.vendor_id, name: row.name, endpointUrl: row.endpoint_url };
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
    const result = await this.pool.query<{
      id: string;
      agent_id: string;
      release_ref: string;
      declared_config_digest: string | null;
    }>(
      `insert into public.release_declarations (agent_id, release_ref, declared_config_digest)
       values ($1, $2, $3)
       on conflict (agent_id, release_ref) do update set declared_config_digest = excluded.declared_config_digest
       returning id, agent_id, release_ref, declared_config_digest`,
      [agentId, releaseRef, declaredConfigDigest ?? null],
    );
    const row = result.rows[0]!;
    return {
      id: row.id,
      agentId: row.agent_id,
      releaseRef: row.release_ref,
      declaredConfigDigest: row.declared_config_digest,
    };
  }

  async getTaskPack(id: string, version: string): Promise<TaskPack | null> {
    const result = await this.pool.query<{
      id: string;
      version: string;
      fixture_digest: string | null;
      criteria_digest: string | null;
      evaluator_ref: string;
    }>(`select id, version, fixture_digest, criteria_digest, evaluator_ref from public.task_packs where id = $1 and version = $2`, [
      id,
      version,
    ]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      version: row.version,
      fixtureDigest: row.fixture_digest,
      criteriaDigest: row.criteria_digest,
      evaluatorRef: row.evaluator_ref,
    };
  }

  async listTaskPacks(): Promise<TaskPack[]> {
    const result = await this.pool.query<{
      id: string;
      version: string;
      fixture_digest: string | null;
      criteria_digest: string | null;
      evaluator_ref: string;
    }>(`select id, version, fixture_digest, criteria_digest, evaluator_ref from public.task_packs order by id, version`);
    return result.rows.map((row) => ({
      id: row.id,
      version: row.version,
      fixtureDigest: row.fixture_digest,
      criteriaDigest: row.criteria_digest,
      evaluatorRef: row.evaluator_ref,
    }));
  }

  async findRunByIdempotencyKey(key: string): Promise<Run | null> {
    const result = await this.pool.query(`select * from public.runs where idempotency_key = $1`, [key]);
    const row = result.rows[0];
    return row ? toRun(row) : null;
  }

  async createRun(input: {
    releaseDeclarationId: string;
    taskPackId: string;
    taskPackVersion: string;
    nonce: string;
    idempotencyKey: string;
  }): Promise<Run> {
    const result = await this.pool.query(
      `insert into public.runs (release_declaration_id, task_pack_id, task_pack_version, nonce, idempotency_key)
       values ($1, $2, $3, $4, $5)
       returning *`,
      [input.releaseDeclarationId, input.taskPackId, input.taskPackVersion, input.nonce, input.idempotencyKey],
    );
    return toRun(result.rows[0]);
  }

  async getRun(id: string): Promise<Run | null> {
    const result = await this.pool.query(`select * from public.runs where id = $1`, [id]);
    const row = result.rows[0];
    return row ? toRun(row) : null;
  }

  async getReleaseDeclaration(id: string): Promise<ReleaseDeclaration | null> {
    const result = await this.pool.query<{
      id: string;
      agent_id: string;
      release_ref: string;
      declared_config_digest: string | null;
    }>(`select * from public.release_declarations where id = $1`, [id]);
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, agentId: row.agent_id, releaseRef: row.release_ref, declaredConfigDigest: row.declared_config_digest };
  }

  async getAgent(id: string): Promise<Agent | null> {
    const result = await this.pool.query<{ id: string; vendor_id: string; name: string; endpoint_url: string }>(
      `select * from public.agents where id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, vendorId: row.vendor_id, name: row.name, endpointUrl: row.endpoint_url };
  }

  async createObservation(input: {
    runId: string;
    requestDigest?: string | null;
    responseDigest?: string | null;
    outputArtifactRef?: string | null;
    outputArtifactContent?: string | null;
    mode: "observed" | "vendor_declared";
  }): Promise<Observation> {
    const result = await this.pool.query(
      `insert into public.observations (run_id, request_digest, response_digest, output_artifact_ref, output_artifact_content, mode)
       values ($1, $2, $3, $4, $5, $6)
       returning *`,
      [
        input.runId,
        input.requestDigest ?? null,
        input.responseDigest ?? null,
        input.outputArtifactRef ?? null,
        input.outputArtifactContent ?? null,
        input.mode,
      ],
    );
    return rowToObservation(result.rows[0]);
  }

  async listObservations(runId: string): Promise<Observation[]> {
    const result = await this.pool.query(`select * from public.observations where run_id = $1 order by occurred_at asc`, [runId]);
    return result.rows.map(rowToObservation);
  }

  async resolveRun(input: {
    runId: string;
    status: Run["status"];
    evidenceManifest: unknown;
    scoreTotal: number;
  }): Promise<Run> {
    const result = await this.pool.query(
      `update public.runs
       set status = $2, evidence_manifest = $3, score_total = $4, attempts = attempts + 1, completed_at = now()
       where id = $1
       returning *`,
      [input.runId, input.status, JSON.stringify(input.evidenceManifest), input.scoreTotal],
    );
    return toRun(result.rows[0]);
  }

  async publishClaimManifest(input: {
    runId: string;
    taskRef: string;
    releaseRef: string;
    criteriaResults: CriterionResult[];
    limitations?: string | null;
  }): Promise<ClaimManifest> {
    // Canonical digest computed over exactly the fields the public manifest exposes — never over
    // the attestation envelope (doc: "sem tx/hash circular", the envelope references the manifest
    // digest, not the other way around).
    const digest = digestOf({
      task: input.taskRef,
      release: input.releaseRef,
      criteriaResults: input.criteriaResults,
      limitations: input.limitations ?? null,
    });
    const result = await this.pool.query(
      `insert into public.claim_manifests
         (run_id, task_ref, release_ref, criteria_results, limitations, visibility, canonical_digest_sha256, published_at)
       values ($1, $2, $3, $4, $5, 'public', $6, now())
       returning *`,
      [input.runId, input.taskRef, input.releaseRef, JSON.stringify(input.criteriaResults), input.limitations ?? null, digest],
    );
    return rowToClaimManifest(result.rows[0]);
  }

  async getPublicClaimManifest(id: string): Promise<ClaimManifest | null> {
    const result = await this.pool.query(`select * from public.claim_manifests where id = $1 and visibility = 'public'`, [id]);
    const row = result.rows[0];
    return row ? rowToClaimManifest(row) : null;
  }

  async getAttestationEnvelope(claimManifestId: string): Promise<AttestationEnvelope | null> {
    const result = await this.pool.query(`select * from public.attestation_envelopes where claim_manifest_id = $1`, [claimManifestId]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      claimManifestId: row.claim_manifest_id,
      network: row.network,
      attestationAddress: row.attestation_address,
      issuerRef: row.issuer_ref,
      schemaRef: row.schema_ref,
      manifestDigest: row.manifest_digest,
      status: row.status,
    };
  }

  async recordAttestationEnvelope(input: {
    claimManifestId: string;
    attestationAddress: string;
    issuerRef: string;
    schemaRef: string;
    manifestDigest: string;
    status: AttestationEnvelope["status"];
  }): Promise<AttestationEnvelope> {
    const result = await this.pool.query(
      `insert into public.attestation_envelopes
         (claim_manifest_id, network, attestation_address, issuer_ref, schema_ref, manifest_digest, status, issued_at)
       values ($1, 'solana-devnet', $2, $3, $4, $5, $6, now())
       on conflict (claim_manifest_id) do update set
         attestation_address = excluded.attestation_address,
         issuer_ref = excluded.issuer_ref,
         schema_ref = excluded.schema_ref,
         manifest_digest = excluded.manifest_digest,
         status = excluded.status,
         issued_at = now(),
         updated_at = now()
       returning *`,
      [input.claimManifestId, input.attestationAddress, input.issuerRef, input.schemaRef, input.manifestDigest, input.status],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      claimManifestId: row.claim_manifest_id,
      network: row.network,
      attestationAddress: row.attestation_address,
      issuerRef: row.issuer_ref,
      schemaRef: row.schema_ref,
      manifestDigest: row.manifest_digest,
      status: row.status,
    };
  }

  async createEvaluationRequest(input: {
    requesterContact: string;
    requesterRole?: string | null;
    taskDescription: string;
  }): Promise<EvaluationRequest> {
    const result = await this.pool.query(
      `insert into public.evaluation_requests (requester_contact, requester_role, task_description)
       values ($1, $2, $3)
       returning *`,
      [input.requesterContact, input.requesterRole ?? null, input.taskDescription],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      requesterContact: row.requester_contact,
      requesterRole: row.requester_role,
      taskDescription: row.task_description,
      status: row.status,
    };
  }
}

function rowToObservation(row: {
  id: string;
  run_id: string;
  request_digest: string | null;
  response_digest: string | null;
  output_artifact_ref: string | null;
  output_artifact_content: string | null;
  mode: Observation["mode"];
  occurred_at: string;
}): Observation {
  return {
    id: row.id,
    runId: row.run_id,
    requestDigest: row.request_digest,
    responseDigest: row.response_digest,
    outputArtifactRef: row.output_artifact_ref,
    outputArtifactContent: row.output_artifact_content,
    mode: row.mode,
    occurredAt: row.occurred_at,
  };
}

function rowToClaimManifest(row: {
  id: string;
  run_id: string;
  task_ref: string;
  release_ref: string;
  criteria_results: CriterionResult[];
  limitations: string | null;
  visibility: ClaimManifest["visibility"];
  canonical_digest_sha256: string | null;
  published_at: string | null;
}): ClaimManifest {
  return {
    id: row.id,
    runId: row.run_id,
    taskRef: row.task_ref,
    releaseRef: row.release_ref,
    criteriaResults: row.criteria_results,
    limitations: row.limitations,
    visibility: row.visibility,
    canonicalDigestSha256: row.canonical_digest_sha256,
    publishedAt: row.published_at,
  };
}

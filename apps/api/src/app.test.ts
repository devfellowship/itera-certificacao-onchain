import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked so dispatch tests never spawn the real evaluator subprocess (15-90s each) or do a real
// DNS lookup against a fake *.invalid hostname — the route's own logic (status mapping, 404/409
// handling, response shape) is what's under test here, not the grader or the network guard
// themselves (those have their own real coverage: the grader IS services/evaluator's own test
// suite; the network guard's IP-range logic is simple enough to read, and exercising it for real
// would need a live private-IP-resolving hostname CI can't rely on).
vi.mock("./domain/grader.js", () => ({
  gradePatch: vi.fn(),
  GraderError: class GraderError extends Error {},
}));
vi.mock("./domain/network-guard.js", () => ({
  assertPublicHttpsEndpoint: vi.fn().mockResolvedValue(undefined),
  NetworkGuardError: class NetworkGuardError extends Error {},
}));

import { API_VERSION, createApp, SERVICE_NAME } from "./app.js";
import { FakeRepository } from "./domain/repository.fake.js";
import { gradePatch } from "./domain/grader.js";

const OPERATOR_KEY = "test-operator-key";
process.env.ITERA_API_OPERATOR_KEY = OPERATOR_KEY;

let server: Server;
let baseUrl: string;
let repo: FakeRepository;

// A fresh repo and a fresh listening server per test, rather than one shared server for the whole
// file, keeps each test's data isolated without needing a reset()/truncate() method on the fake.
beforeEach(async () => {
  repo = new FakeRepository();
  server = createApp(repo).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function operatorHeaders(extra: Record<string, string> = {}) {
  return { "x-operator-key": OPERATOR_KEY, "Content-Type": "application/json", ...extra };
}

describe("api routes", () => {
  it("GET / returns the service status as JSON", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.service).toBe(SERVICE_NAME);
    expect(body.status).toBe("ok");
    expect(body.version).toBe(API_VERSION);
    expect(body.routes).toContain("POST /evaluations");
  });

  it("GET /health returns a minimal ok payload", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /hello-world returns plain text", async () => {
    const res = await fetch(`${baseUrl}/hello-world`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toBe("Hello, world!");
  });

  it("unknown routes return 404", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("allows a known origin and sets the CORS header", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Origin: "https://itera-agent-credentials.devfellowship.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://itera-agent-credentials.devfellowship.com",
    );
  });

  it("does not echo back an unknown origin", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("sets standard rate-limit headers on a response", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.headers.get("ratelimit-limit")).not.toBeNull();
  });
});

describe("POST /evaluations", () => {
  const validBody = {
    idempotencyKey: "key-1",
    vendor: { displayName: "Demo Studio" },
    agent: { name: "coding-agent", endpointUrl: "https://agent.example.invalid/evaluate" },
    release: { releaseRef: "demo-release-01" },
    task: { id: "webhook-ledger", version: "1" },
  };

  it("rejects a request without the operator key", async () => {
    const res = await fetch(`${baseUrl}/evaluations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(401);
  });

  it("creates a run in pending status for a known task pack", async () => {
    const res = await fetch(`${baseUrl}/evaluations`, {
      method: "POST",
      headers: operatorHeaders(),
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(body.task).toEqual({ id: "webhook-ledger", version: "1" });
    expect(typeof body.nonce).toBe("string");
  });

  it("is idempotent on idempotencyKey", async () => {
    const first = await fetch(`${baseUrl}/evaluations`, {
      method: "POST",
      headers: operatorHeaders(),
      body: JSON.stringify(validBody),
    });
    const second = await fetch(`${baseUrl}/evaluations`, {
      method: "POST",
      headers: operatorHeaders(),
      body: JSON.stringify(validBody),
    });
    const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);
    expect(second.status).toBe(200);
    expect(secondBody.runId).toBe(firstBody.runId);
    expect(repo.runs).toHaveLength(1);
  });

  it("rejects a non-https endpoint", async () => {
    const res = await fetch(`${baseUrl}/evaluations`, {
      method: "POST",
      headers: operatorHeaders(),
      body: JSON.stringify({ ...validBody, idempotencyKey: "key-2", agent: { ...validBody.agent, endpointUrl: "http://agent.example.invalid" } }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown task pack", async () => {
    const res = await fetch(`${baseUrl}/evaluations`, {
      method: "POST",
      headers: operatorHeaders(),
      body: JSON.stringify({ ...validBody, idempotencyKey: "key-3", task: { id: "unknown-task", version: "1" } }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /evaluations/:id/dispatch", () => {
  const createRunBody = {
    idempotencyKey: "dispatch-test",
    vendor: { displayName: "Demo Studio" },
    agent: { name: "coding-agent", endpointUrl: "https://agent.example.invalid/evaluate" },
    release: { releaseRef: "demo-release-01" },
    task: { id: "webhook-ledger", version: "1" },
  };

  async function createRun(idempotencyKey = createRunBody.idempotencyKey) {
    const res = await fetch(`${baseUrl}/evaluations`, {
      method: "POST",
      headers: operatorHeaders(),
      body: JSON.stringify({ ...createRunBody, idempotencyKey }),
    });
    return (await res.json()) as { runId: string };
  }

  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // globalThis.fetch is process-wide, so a naive stub would also intercept the test's own calls
  // to the local test server (baseUrl) -- only the vendor endpoint's own URL is faked here, every
  // other call falls through to the real fetch.
  function stubVendorFetch(handler: typeof fetch) {
    globalThis.fetch = vi.fn(((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("agent.example.invalid")) return handler(input, init);
      return originalFetch(input, init);
    }) as typeof fetch);
  }

  it("404s for an unknown run", async () => {
    const res = await fetch(`${baseUrl}/evaluations/00000000-0000-0000-0000-000000000000/dispatch`, {
      method: "POST",
      headers: operatorHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it("resolves to pass when the grader returns a positive score", async () => {
    const { runId } = await createRun();
    stubVendorFetch(async () => new Response(JSON.stringify({ patch: "diff --git a/x b/x" }), { status: 200 }));
    vi.mocked(gradePatch).mockResolvedValue({
      schema_version: "0.1.0",
      evaluator_version: "0.1.0",
      scenario_id: "webhook-ledger",
      generated_at: new Date().toISOString(),
      fixture_hash: "h",
      patch_hash: "h",
      patch_scope: { changed_files: ["src/app.ts"], allowed: true },
      tests: {
        public_baseline: { total: 3, passed: 1, failed: 2 },
        public_after_patch: { total: 3, passed: 3, failed: 0 },
        hidden: { total: 5, passed: 5, failed: 0 },
      },
      score: { public_behavior: 20, hidden_behavior: 50, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5, total: 100 },
      errors: [],
    });

    const res = await fetch(`${baseUrl}/evaluations/${runId}/dispatch`, { method: "POST", headers: operatorHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pass");
  });

  it("resolves to invalid when the grader reports a scope violation, not fail", async () => {
    const { runId } = await createRun("dispatch-scope");
    stubVendorFetch(async () => new Response(JSON.stringify({ patch: "diff --git a/tests/x b/tests/x" }), { status: 200 }));
    vi.mocked(gradePatch).mockResolvedValue({
      schema_version: "0.1.0",
      evaluator_version: "0.1.0",
      scenario_id: "webhook-ledger",
      generated_at: new Date().toISOString(),
      fixture_hash: "h",
      patch_hash: "h",
      patch_scope: { changed_files: ["tests/x"], allowed: false },
      tests: {
        public_baseline: { total: 3, passed: 1, failed: 2 },
        public_after_patch: { total: 3, passed: 3, failed: 0 },
        hidden: { total: 5, passed: 5, failed: 0 },
      },
      score: { public_behavior: 20, hidden_behavior: 50, regression: 15, patch_integrity_and_scope: 0, reproducible_evidence: 5, total: 0 },
      errors: [],
    });

    const res = await fetch(`${baseUrl}/evaluations/${runId}/dispatch`, { method: "POST", headers: operatorHeaders() });
    const body = await res.json();
    expect(body.status).toBe("invalid");
  });

  it("resolves to invalid when the endpoint response has no patch field", async () => {
    const { runId } = await createRun("dispatch-no-patch");
    stubVendorFetch(async () => new Response(JSON.stringify({ oops: true }), { status: 200 }));

    const res = await fetch(`${baseUrl}/evaluations/${runId}/dispatch`, { method: "POST", headers: operatorHeaders() });
    expect(res.status).toBe(422);
    const events = await fetch(`${baseUrl}/evaluations/${runId}/events`, { headers: operatorHeaders() });
    expect((await events.json()).status).toBe("invalid");
  });

  it("resolves to infra_error when the endpoint is unreachable", async () => {
    const { runId } = await createRun("dispatch-unreachable");
    stubVendorFetch(async () => {
      throw new Error("connection refused");
    });

    const res = await fetch(`${baseUrl}/evaluations/${runId}/dispatch`, { method: "POST", headers: operatorHeaders() });
    expect(res.status).toBe(502);
  });

  it("refuses to dispatch a run that's already resolved", async () => {
    const { runId } = await createRun("dispatch-twice");
    stubVendorFetch(async () => {
      throw new Error("connection refused");
    });
    await fetch(`${baseUrl}/evaluations/${runId}/dispatch`, { method: "POST", headers: operatorHeaders() });

    const second = await fetch(`${baseUrl}/evaluations/${runId}/dispatch`, { method: "POST", headers: operatorHeaders() });
    expect(second.status).toBe(409);
  });
});

describe("POST /evaluations/:id/publish", () => {
  it("refuses to publish a run that is still pending", async () => {
    const create = await fetch(`${baseUrl}/evaluations`, {
      method: "POST",
      headers: operatorHeaders(),
      body: JSON.stringify({
        idempotencyKey: "publish-pending",
        vendor: { displayName: "Demo Studio" },
        agent: { name: "coding-agent", endpointUrl: "https://agent.example.invalid/evaluate" },
        release: { releaseRef: "demo-release-01" },
        task: { id: "webhook-ledger", version: "1" },
      }),
    });
    const { runId } = await create.json();

    const publish = await fetch(`${baseUrl}/evaluations/${runId}/publish`, {
      method: "POST",
      headers: operatorHeaders(),
      body: JSON.stringify({ criteriaResults: [] }),
    });
    expect(publish.status).toBe(409);
  });

  it("publishes a resolved run and the credential becomes publicly readable", async () => {
    const create = await fetch(`${baseUrl}/evaluations`, {
      method: "POST",
      headers: operatorHeaders(),
      body: JSON.stringify({
        idempotencyKey: "publish-resolved",
        vendor: { displayName: "Demo Studio" },
        agent: { name: "coding-agent", endpointUrl: "https://agent.example.invalid/evaluate" },
        release: { releaseRef: "demo-release-01" },
        task: { id: "webhook-ledger", version: "1" },
      }),
    });
    const { runId } = await create.json();
    const run = repo.runs.find((r) => r.id === runId)!;
    run.status = "pass"; // simulates the not-yet-built grader resolving the run

    const publish = await fetch(`${baseUrl}/evaluations/${runId}/publish`, {
      method: "POST",
      headers: operatorHeaders(),
      body: JSON.stringify({ criteriaResults: [{ requirement: "Valid event produces one credit", result: "PASS" }] }),
    });
    expect(publish.status).toBe(201);
    const { claimManifestId, canonicalDigestSha256 } = await publish.json();
    expect(typeof canonicalDigestSha256).toBe("string");

    const credential = await fetch(`${baseUrl}/credentials/${claimManifestId}`);
    expect(credential.status).toBe(200);
    const credentialBody = await credential.json();
    expect(credentialBody.registry.status).toBe("not_issued");
    expect(credentialBody.manifestDigestSha256).toBe(canonicalDigestSha256);
  });
});

describe("GET /credentials/:id", () => {
  it("returns 404 for an unknown credential", async () => {
    const res = await fetch(`${baseUrl}/credentials/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });
});

describe("GET /credentials/:id/verify", () => {
  it("reports a digest match for an untampered manifest and flags the on-chain check as unavailable", async () => {
    const vendor = await repo.findOrCreateVendor({ displayName: "Demo Studio" });
    const agent = await repo.findOrCreateAgent({ vendorId: vendor.id, name: "coding-agent", endpointUrl: "https://agent.example.invalid" });
    const release = await repo.findOrCreateReleaseDeclaration({ agentId: agent.id, releaseRef: "demo-release-01" });
    const run = await repo.createRun({
      releaseDeclarationId: release.id,
      taskPackId: "webhook-ledger",
      taskPackVersion: "1",
      nonce: "nonce-1",
      idempotencyKey: "verify-test",
    });
    const manifest = await repo.publishClaimManifest({
      runId: run.id,
      taskRef: "webhook-ledger/1",
      releaseRef: release.id,
      criteriaResults: [{ requirement: "x", result: "PASS" }],
    });

    const res = await fetch(`${baseUrl}/credentials/${manifest.id}/verify`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const digestCheck = body.checks.find((c: { id: string }) => c.id === "manifest_digest_matches");
    expect(digestCheck.status).toBe("pass");
    const onchainCheck = body.checks.find((c: { id: string }) => c.id === "attestation_owner_and_schema");
    expect(onchainCheck.status).toBe("unavailable");
  });
});

describe("POST /evaluation-requests", () => {
  it("accepts a well-formed request and does not require the operator key", async () => {
    const res = await fetch(`${baseUrl}/evaluation-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requesterContact: "buyer@example.com", taskDescription: "Validate our custom retry logic." }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("new");
  });

  it("rejects a missing taskDescription", async () => {
    const res = await fetch(`${baseUrl}/evaluation-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requesterContact: "buyer@example.com" }),
    });
    expect(res.status).toBe(400);
  });
});

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same reasoning: real issuance needs a funded devnet keypair and a live RPC round-trip (covered
// separately, for real, outside the test suite — see the commit that introduced this file).
vi.mock("./domain/solana-attestation.js", () => ({
  issueScoreAttestation: vi.fn(),
  verifyOnChain: vi.fn(),
  ITERA_CREDENTIAL_PDA: "Dh9NF2L2Ua2u4TUzKRX5u8S5DDCBLNA7aVkunteXt7A3",
  ITERA_SCORE_SCHEMA_PDA: "ABA68smXFGBtByCUKAzDaRi3SckBmmaWzKuoBbGCy79d",
}));
// Same reasoning: a real git clone+push needs a real deploy key and network access to GitHub
// (covered separately, for real, outside the test suite).
vi.mock("./domain/manifests-repo.js", () => ({
  commitMarkdownFile: vi.fn().mockResolvedValue({ commitSha: "deadbeef" }),
  ManifestsRepoError: class ManifestsRepoError extends Error {},
}));

import { API_VERSION, createApp, PRODUCT_NAME, SERVICE_NAME } from "./app.js";
import { FakeRepository } from "./domain/repository.fake.js";
import { commitMarkdownFile } from "./domain/manifests-repo.js";

let server: Server;
let baseUrl: string;
let repo: FakeRepository;

// A fresh repo and a fresh listening server per test, rather than one shared server for the whole
// file, keeps each test's data isolated without needing a reset()/truncate() method on the fake.
beforeEach(async () => {
  vi.clearAllMocks();
  repo = new FakeRepository();
  server = createApp(repo).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("api routes", () => {
  it("GET / returns the service status as JSON", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.service).toBe(SERVICE_NAME);
    expect(body.name).toBe(PRODUCT_NAME);
    expect(JSON.stringify(body)).not.toMatch(/itera/i);
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

describe("retired vendor-endpoint flow", () => {
  const retired: Array<[string, string]> = [
    ["POST", "/evaluations"],
    ["POST", "/evaluations/00000000-0000-0000-0000-000000000000/dispatch"],
    ["GET", "/evaluations/00000000-0000-0000-0000-000000000000/events"],
    ["POST", "/evaluations/00000000-0000-0000-0000-000000000000/publish"],
    ["POST", "/agent-endpoint-manifests"],
  ];

  it.each(retired)("%s %s answers 410 Gone with a pointer to the new flow", async (method, path) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ idempotencyKey: "k" }) } : {}),
    });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.code).toBe("legacy_flow_retired");
    expect(body.replacement.quote).toBe("POST /evaluations/quote");
  });

  it("creates no run, no vendor and no agent", async () => {
    await fetch(`${baseUrl}/evaluations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "retired-key",
        vendor: { displayName: "Demo Studio" },
        agent: { name: "coding-agent", endpointUrl: "https://agent.example.invalid/evaluate" },
        release: { releaseRef: "demo-release-01" },
        task: { id: "webhook-ledger", version: "1" },
      }),
    });
    expect(repo.runs).toHaveLength(0);
  });

  it("lists the retired routes on GET / and no longer advertises them as routes", async () => {
    const body = await (await fetch(`${baseUrl}/`)).json();
    expect(body.retired).toContain("POST /evaluations/:id/dispatch");
    expect(body.routes).not.toContain("POST /evaluations/:id/dispatch");
    expect(body.routes).not.toContain("POST /agent-endpoint-manifests");
    expect(body.routes).toContain("POST /evaluations");
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

  it("commits a .md file to the public manifests repo and never includes the requester's contact in it", async () => {
    const res = await fetch(`${baseUrl}/evaluation-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requesterContact: "buyer@example.com", taskDescription: "Validate our custom retry logic." }),
    });
    const body = await res.json();
    expect(body.manifestCommitError).toBeNull();
    expect(commitMarkdownFile).toHaveBeenCalledTimes(1);
    const [path, content] = vi.mocked(commitMarkdownFile).mock.calls[0]!;
    expect(path).toBe(`requests/${body.id}.md`);
    expect(path.endsWith(".md")).toBe(true);
    expect(content).not.toContain("buyer@example.com");
    expect(content).toContain("Validate our custom retry logic.");
  });

  it("still creates the request when the manifest commit fails, and reports the error", async () => {
    vi.mocked(commitMarkdownFile).mockRejectedValueOnce(new Error("push failed: authentication"));
    const res = await fetch(`${baseUrl}/evaluation-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requesterContact: "buyer@example.com", taskDescription: "x" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("new");
    expect(body.manifestCommitError).toBe("push failed: authentication");
  });
});

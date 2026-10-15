import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Tiny limits so the tests can exhaust a bucket. config.ts reads these at import time.
vi.hoisted(() => {
  process.env.ITERA_API_RATE_LIMIT_MAX = "3";
  process.env.ITERA_API_PUBLIC_RATE_LIMIT_MAX = "6";
  process.env.ITERA_SESSION_SECRET = "test-session-secret-for-rate-limit";
  delete process.env.ITERA_API_TRUST_PROXY;
});
vi.mock("../domain/solana-attestation.js", () => ({
  issueScoreAttestation: vi.fn(),
  verifyOnChain: vi.fn(),
  ITERA_CREDENTIAL_PDA: "Dh9NF2L2Ua2u4TUzKRX5u8S5DDCBLNA7aVkunteXt7A3",
  ITERA_SCORE_SCHEMA_PDA: "ABA68smXFGBtByCUKAzDaRi3SckBmmaWzKuoBbGCy79d",
}));
vi.mock("../domain/manifests-repo.js", () => ({
  commitMarkdownFile: vi.fn(),
  ManifestsRepoError: class ManifestsRepoError extends Error {},
}));

import { createApp } from "../app.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { issueSessionToken } from "./auth.js";
import { isPublicCachedRead, rateLimitKey } from "./rate-limit.js";

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  server = createApp(new FakeRepository()).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${baseUrl}${path}`, { headers });
const remaining = (res: Response) => Number(res.headers.get("ratelimit-remaining"));

describe("rate limit buckets", () => {
  it("gives two clients behind the proxy (different X-Forwarded-For) separate buckets", async () => {
    // Client A spends its whole bucket (limit 3) and is then refused.
    for (let i = 0; i < 3; i++) expect((await get("/", { "x-forwarded-for": "203.0.113.10" })).status).toBe(200);
    expect((await get("/", { "x-forwarded-for": "203.0.113.10" })).status).toBe(429);
    // Client B, same proxy connection, is untouched and has a full bucket.
    const b = await get("/", { "x-forwarded-for": "203.0.113.20" });
    expect(b.status).toBe(200);
    expect(remaining(b)).toBe(2);
  });

  it("trusts exactly one hop: a client-sent X-Forwarded-For prefix cannot pick its bucket", async () => {
    // The proxy appends the real peer last. `spoof, real` must key on `real`.
    for (let i = 0; i < 3; i++) await get("/", { "x-forwarded-for": `198.51.100.${i}, 203.0.113.30` });
    expect((await get("/", { "x-forwarded-for": "198.51.100.99, 203.0.113.30" })).status).toBe(429);
  });

  it("keeps a bucket per wallet for a valid session, whatever the IP", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const auth = { authorization: `Bearer ${issueSessionToken(wallet).token}` };
    for (let i = 0; i < 3; i++) expect((await get("/", { ...auth, "x-forwarded-for": `203.0.113.${40 + i}` })).status).toBe(200);
    expect((await get("/", { ...auth, "x-forwarded-for": "203.0.113.99" })).status).toBe(429);
    // The same IP without the session has its own (IP) bucket.
    expect((await get("/", { "x-forwarded-for": "203.0.113.99" })).status).toBe(200);
  });

  it("keeps a bucket per dfl principal, whatever the IP, apart from other principals", async () => {
    const id = `dfl:${randomUUID()}`;
    const auth = { authorization: `Bearer ${issueSessionToken(id, Date.now(), "dfl").token}` };
    for (let i = 0; i < 3; i++) expect((await get("/", { ...auth, "x-forwarded-for": `203.0.113.${110 + i}` })).status).toBe(200);
    expect((await get("/", { ...auth, "x-forwarded-for": "203.0.113.199" })).status).toBe(429);
    // Another dfl principal on the same IP has a full bucket.
    const other = { authorization: `Bearer ${issueSessionToken(`dfl:${randomUUID()}`, Date.now(), "dfl").token}` };
    expect((await get("/", { ...other, "x-forwarded-for": "203.0.113.199" })).status).toBe(200);
  });

  it("falls back to the IP bucket for a forged token", async () => {
    const forged = { authorization: "Bearer aaa.bbb.ccc" };
    for (let i = 0; i < 3; i++) await get("/", { ...forged, "x-forwarded-for": "203.0.113.50" });
    expect((await get("/", { ...forged, "x-forwarded-for": "203.0.113.50" })).status).toBe(429);
    expect((await get("/", { ...forged, "x-forwarded-for": "203.0.113.51" })).status).toBe(200);
  });

  it("never limits /health", async () => {
    for (let i = 0; i < 20; i++) expect((await get("/health", { "x-forwarded-for": "203.0.113.60" })).status).toBe(200);
    expect((await get("/health", { "x-forwarded-for": "203.0.113.60" })).headers.get("ratelimit-limit")).toBeNull();
  });

  it("uses a separate, higher limit for public cached GETs and keeps the two buckets apart", async () => {
    const h = { "x-forwarded-for": "203.0.113.70" };
    const first = await get("/public/unmounted-probe", h);
    expect(first.headers.get("ratelimit-limit")).toBe("6");
    // 4 more public reads exceed the general limit (3) but not the public one (6).
    for (let i = 0; i < 4; i++) expect((await get("/public/unmounted-probe", h)).status).toBe(404);
    // The general bucket is untouched by those reads.
    const general = await get("/", h);
    expect(general.status).toBe(200);
    expect(general.headers.get("ratelimit-limit")).toBe("3");
    expect(remaining(general)).toBe(2);
    // The public bucket has its own ceiling.
    await get("/public/unmounted-probe", h); // 6th
    expect((await get("/public/unmounted-probe", h)).status).toBe(429);
  });
});

describe("rate limit helpers", () => {
  it("classifies the public cached reads", () => {
    for (const path of ["/public/evaluations/x", "/public/evaluations/x/og.png", "/nft/abc.json", "/badge/agents/a.svg", "/b/x.svg"]) {
      expect(isPublicCachedRead({ method: "GET", path })).toBe(true);
    }
    expect(isPublicCachedRead({ method: "POST", path: "/public/evaluations/x" })).toBe(false);
    expect(isPublicCachedRead({ method: "GET", path: "/runs/1" })).toBe(false);
    expect(isPublicCachedRead({ method: "GET", path: "/publicity" })).toBe(false);
  });

  it("keys on req.principal.id when a middleware already set it, else on the session principal", () => {
    const dfl = `dfl:${randomUUID()}`;
    const wallet = Keypair.generate().publicKey.toBase58();
    const withPrincipal = (principal: { id: string; kind: "siws" | "dfl" }) =>
      ({ ip: "203.0.113.1", principal, get: () => undefined }) as unknown as Parameters<typeof rateLimitKey>[0];
    expect(rateLimitKey(withPrincipal({ id: dfl, kind: "dfl" }))).toBe(`p:${dfl}`);
    expect(rateLimitKey(withPrincipal({ id: wallet, kind: "siws" }))).toBe(`w:${wallet}`);
    const withToken = (token: string) =>
      ({ ip: "203.0.113.1", get: (h: string) => (h.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined) }) as unknown as Parameters<typeof rateLimitKey>[0];
    expect(rateLimitKey(withToken(issueSessionToken(dfl, Date.now(), "dfl").token))).toBe(`p:${dfl}`);
    expect(rateLimitKey(withToken(issueSessionToken(wallet).token))).toBe(`w:${wallet}`);
  });

  it("keys on the IP when there is no session", () => {
    const req = { ip: "203.0.113.1", get: () => undefined } as unknown as Parameters<typeof rateLimitKey>[0];
    expect(rateLimitKey(req)).toBe("ip:203.0.113.1");
  });
});

import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { getBase58Decoder } from "@solana/kit";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { optionalPrincipal, requirePrincipal } from "./middleware.js";
import { verifyPrincipalToken, verifySessionToken } from "./principal.js";
import { issueSessionToken } from "./session.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

function newAddress(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  return getBase58Decoder().decode(publicKey.export({ format: "der", type: "spki" }).subarray(12));
}

/** Signs arbitrary claims with the session secret, like a token from an older API build. */
function signClaims(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", "test-session-secret").update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

const future = () => Math.floor(Date.now() / 1000) + 3600;

describe("session token → principal", () => {
  it("reads a legacy token (no amr, base58 sub) as a siws principal", () => {
    const wallet = newAddress();
    const legacy = signClaims({ sub: wallet, iat: future() - 7200, exp: future(), iss: "itera-api" });
    expect(verifyPrincipalToken(legacy)).toEqual({ id: wallet, kind: "siws" });
    expect(verifySessionToken(legacy)).toBe(wallet);
  });

  it("issues SIWS sessions with amr=siws", () => {
    const wallet = newAddress();
    const { token } = issueSessionToken(wallet);
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    expect(claims.amr).toBe("siws");
    expect(verifyPrincipalToken(token)).toEqual({ id: wallet, kind: "siws" });
  });

  it("reads a dfl:<uuid> sub with amr=dfl as a dfl principal", () => {
    const id = `dfl:${randomUUID()}`;
    const { token } = issueSessionToken(id, Date.now(), "dfl");
    expect(verifyPrincipalToken(token)).toEqual({ id, kind: "dfl" });
    expect(verifySessionToken(token)).toBe(id);
  });

  it("rejects a garbage sub and a sub that does not match its amr", () => {
    const wallet = newAddress();
    const dflId = `dfl:${randomUUID()}`;
    for (const claims of [
      { sub: "garbage", exp: future() },
      { sub: "garbage", amr: "siws", exp: future() },
      { sub: "garbage", amr: "dfl", exp: future() },
      { sub: "dfl:not-a-uuid", amr: "dfl", exp: future() },
      { sub: `dfl:${randomUUID()}x`, amr: "dfl", exp: future() },
      { sub: dflId, exp: future() }, // a dfl id without amr is never issued
      { sub: dflId, amr: "siws", exp: future() },
      { sub: wallet, amr: "dfl", exp: future() },
      { sub: wallet, amr: "github", exp: future() },
      { sub: wallet, amr: null, exp: future() },
    ]) {
      expect(verifyPrincipalToken(signClaims(claims))).toBeNull();
      expect(verifySessionToken(signClaims(claims))).toBeNull();
    }
  });

  it("requirePrincipal sets req.principal and keeps req.wallet as its id; optionalPrincipal never rejects", async () => {
    const app = express();
    app.get("/r", requirePrincipal, (req, res) => res.json({ principal: req.principal, wallet: req.wallet }));
    app.get("/o", optionalPrincipal, (req, res) => res.json({ principal: req.principal ?? null, wallet: req.wallet ?? null }));
    const s = app.listen(0);
    await new Promise<void>((r) => s.once("listening", r));
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      const id = `dfl:${randomUUID()}`;
      const auth = { Authorization: `Bearer ${issueSessionToken(id, Date.now(), "dfl").token}` };
      expect(await (await fetch(`${base}/r`, { headers: auth })).json()).toEqual({ principal: { id, kind: "dfl" }, wallet: id });
      expect((await fetch(`${base}/r`)).status).toBe(401);
      expect(await (await fetch(`${base}/o`)).json()).toEqual({ principal: null, wallet: null });
      expect(await (await fetch(`${base}/o`, { headers: auth })).json()).toEqual({ principal: { id, kind: "dfl" }, wallet: id });
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});

describe("dfl adapter (stub)", () => {
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

  it("POST /auth/dfl/exchange answers 501 not_implemented", async () => {
    const res = await fetch(`${baseUrl}/auth/dfl/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "x" }),
    });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "not_implemented" });
  });
});

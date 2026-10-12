import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { getBase58Decoder } from "@solana/kit";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { issueSessionToken, requireWallet, resetPendingNoncesForTests, verifySessionToken } from "./auth.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

function newWallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const address = getBase58Decoder().decode(raw);
  return {
    address,
    signBase58: (message: string) => getBase58Decoder().decode(sign(null, Buffer.from(message, "utf8"), privateKey)),
    signBase64: (message: string) => sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64"),
  };
}

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  resetPendingNoncesForTests();
  server = createApp(new FakeRepository()).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Sign-In With Solana", () => {
  it("issues a session for a valid signature and /auth/me returns the wallet", async () => {
    const w = newWallet();
    const nonceRes = await post("/auth/nonce", { wallet: w.address });
    expect(nonceRes.status).toBe(200);
    const { message, nonce } = await nonceRes.json();
    expect(message).toContain(w.address);
    expect(message).toContain(nonce);

    const verifyRes = await post("/auth/verify", { wallet: w.address, signature: w.signBase58(message) });
    expect(verifyRes.status).toBe(200);
    const { token, wallet } = await verifyRes.json();
    expect(wallet).toBe(w.address);

    const me = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ wallet: w.address });
  });

  it("accepts a base64 signature", async () => {
    const w = newWallet();
    const { message } = await (await post("/auth/nonce", { wallet: w.address })).json();
    const res = await post("/auth/verify", { wallet: w.address, signature: w.signBase64(message) });
    expect(res.status).toBe(200);
  });

  it("nonces are single-use", async () => {
    const w = newWallet();
    const { message } = await (await post("/auth/nonce", { wallet: w.address })).json();
    const signature = w.signBase58(message);
    expect((await post("/auth/verify", { wallet: w.address, signature })).status).toBe(200);
    expect((await post("/auth/verify", { wallet: w.address, signature })).status).toBe(401);
  });

  it("rejects a signature from another key", async () => {
    const w = newWallet();
    const other = newWallet();
    const { message } = await (await post("/auth/nonce", { wallet: w.address })).json();
    const res = await post("/auth/verify", { wallet: w.address, signature: other.signBase58(message) });
    expect(res.status).toBe(401);
  });

  it("rejects verify without a nonce and a malformed wallet", async () => {
    const w = newWallet();
    expect((await post("/auth/verify", { wallet: w.address, signature: w.signBase58("x") })).status).toBe(401);
    expect((await post("/auth/nonce", { wallet: "not-a-wallet" })).status).toBe(400);
  });

  it("CORS preflight allows the Authorization header", async () => {
    const res = await fetch(`${baseUrl}/auth/me`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(res.headers.get("access-control-allow-headers")).toMatch(/Authorization/);
  });
});

describe("session tokens", () => {
  it("rejects expired, tampered and missing tokens", async () => {
    const w = newWallet();
    const { token } = issueSessionToken(w.address, Date.now() - 25 * 60 * 60 * 1000);
    expect(verifySessionToken(token)).toBeNull();

    const fresh = issueSessionToken(w.address).token;
    expect(verifySessionToken(fresh)).toBe(w.address);
    const [h, , s] = fresh.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: newWallet().address, exp: 9e9 })).toString("base64url")}.${s}`;
    expect(verifySessionToken(forged)).toBeNull();

    const app = express();
    app.get("/x", requireWallet, (req, res) => res.json({ wallet: req.wallet }));
    const s2 = app.listen(0);
    await new Promise<void>((r) => s2.once("listening", r));
    const url = `http://127.0.0.1:${(s2.address() as AddressInfo).port}/x`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: `Bearer ${forged}` } })).status).toBe(401);
    expect(await (await fetch(url, { headers: { Authorization: `Bearer ${fresh}` } })).json()).toEqual({ wallet: w.address });
    await new Promise<void>((r) => s2.close(() => r()));
  });
});

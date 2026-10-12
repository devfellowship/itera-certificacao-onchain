import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotAnIteraProof, type OnChainProof } from "../chain/onchain-proof.js";
import { createNftRouter } from "./nft-router.js";

const MINT = "7nE9GvcwsqzYcPUYfm5gxzCKkS1cEAyGGsc2rG7Yv1Vq";
const proof: OnChainProof = {
  nftMint: MINT,
  attestationAddress: "Attest1111111111111111111111111111111111111",
  data: { manifest_sha256: "ab".repeat(32), evidence_cid: "bafyexample", scenario_id: "webhook-ledger", score_total: 87, run_start_sig: "sig" },
  memo: {
    run_id: "run-1",
    scenario_id: "webhook-ledger",
    agent_repo: "acme/agent",
    agent_commit: "c0ffee",
    model_id: "anthropic/claude-sonnet-4.5",
    evaluator_commit: "e",
    fixture_hash: "f",
  },
  userWallet: "User111",
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(
    createNftRouter({
      readProof: async (mint) => {
        if (mint !== MINT) throw new NotAnIteraProof("mint not found");
        return proof;
      },
    }),
  );
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("NFT routes", () => {
  it("serves metadata JSON with the image URL and attributes", async () => {
    const res = await fetch(`${base}/nft/${MINT}.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { name: string; description: string; symbol: string; image: string; attributes: Array<{ trait_type: string; value: unknown }> };
    expect(body.symbol).toBe("TMA");
    expect(body.name).toMatch(/^TestMyAgent Run Result · /);
    expect(body.description).toMatch(/^TestMyAgent proof\./);
    expect(`${body.name} ${body.description} ${body.symbol}`).not.toMatch(/itera/i); // URLs keep the itera-agent-credentials* domains (DNS unchanged)
    expect(body.image).toMatch(new RegExp(`/nft/${MINT}\\.png$`));
    const attrs = Object.fromEntries(body.attributes.map((a) => [a.trait_type, a.value]));
    expect(attrs).toMatchObject({ benchmark: "webhook-ledger", score: 87, agent: "acme/agent", model: "anthropic/claude-sonnet-4.5" });
  });

  it("serves a PNG", async () => {
    const res = await fetch(`${base}/nft/${MINT}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(5_000);
  });

  it("answers 404 for a mint that is not a TestMyAgent proof", async () => {
    const res = await fetch(`${base}/nft/So11111111111111111111111111111111111111112.json`);
    expect(res.status).toBe(404);
  });
});

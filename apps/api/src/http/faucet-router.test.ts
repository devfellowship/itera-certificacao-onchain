import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { DEVNET_GENESIS_HASH, type FaucetChain } from "../chain/faucet-chain.js";
import { FakeFaucetStore } from "../domain/faucet-store.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { issueSessionToken, requireWallet } from "./auth.js";
import { faucetConfigFromEnv, looksLikeMainnet, type FaucetConfig } from "./faucet-router.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ALICE = "So11111111111111111111111111111111111111112";
const BOB = "11111111111111111111111111111111";
const SIGNER = "Signer1111111111111111111111111111111111111";

class FakeChain implements FaucetChain {
  rpcUrl = "https://api.devnet.solana.com";
  genesis = DEVNET_GENESIS_HASH;
  balances = new Map<string, number>([[SIGNER, 10_000_000_000]]);
  sent: { to: string; lamports: number }[] = [];
  fail = false;
  async genesisHash() {
    return this.genesis;
  }
  async balance(a: string) {
    return this.balances.get(a) ?? 0;
  }
  async signerAddress() {
    return SIGNER;
  }
  async transfer(to: string, lamports: number) {
    if (this.fail) throw new Error("rpc down");
    this.sent.push({ to, lamports });
    this.balances.set(to, (this.balances.get(to) ?? 0) + lamports);
    return `sig${this.sent.length}`;
  }
}

let server: Server;
let base: string;
let chain: FakeChain;
let store: FakeFaucetStore;
let config: FaucetConfig;

const post = async (wallet?: string) => {
  const res = await fetch(`${base}/faucet`, { method: "POST", headers: wallet ? { Authorization: `Bearer ${issueSessionToken(wallet).token}` } : {} });
  return { status: res.status, body: (await res.json()) as any };
};

async function start() {
  server = createApp(new FakeRepository(), { faucet: { store, chain, config, requireWallet } }).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  chain = new FakeChain();
  store = new FakeFaucetStore();
  config = { ...faucetConfigFromEnv({}), capLamports: 30_000_000 };
  await start();
});
afterEach(() => server.close());

describe("POST /faucet (U37)", () => {
  it("defaults: 0.02 SOL, 2 SOL per day, 24 h", () => {
    expect(faucetConfigFromEnv({})).toMatchObject({ enabled: true, amountLamports: 20_000_000, capLamports: 2_000_000_000, windowMs: 86_400_000 });
  });

  it("needs a session", async () => {
    expect((await post()).status).toBe(401);
  });

  it("sends 0.02 SOL once per wallet per 24 h and records the grant", async () => {
    const first = await post(ALICE);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ txSig: "sig1", lamports: 20_000_000 });
    expect(store.grants[0]).toMatchObject({ wallet: ALICE, status: "sent", txSig: "sig1" });
    chain.balances.set(ALICE, 0); // spent it
    const again = await post(ALICE);
    expect(again.status).toBe(429);
    expect(again.body.code).toBe("wallet_recent");
  });

  it("refuses a wallet that already holds 0.02 SOL", async () => {
    chain.balances.set(ALICE, 20_000_000);
    const r = await post(ALICE);
    expect(r.status).toBe(409);
    expect(chain.sent).toHaveLength(0);
  });

  it("stops at the global daily cap", async () => {
    expect((await post(ALICE)).status).toBe(200);
    const r = await post(BOB); // 0.04 > 0.03 cap
    expect(r.status).toBe(429);
    expect(r.body.code).toBe("daily_cap");
  });

  it("refuses anything but devnet", async () => {
    chain.genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    expect((await post(ALICE)).status).toBe(403);
    expect(looksLikeMainnet("https://api.mainnet-beta.solana.com")).toBe(true);
    expect(looksLikeMainnet("https://api.devnet.solana.com")).toBe(false);
  });

  it("keeps the hot signer reserve, and a failed transfer does not count", async () => {
    chain.balances.set(SIGNER, 100_000_000);
    expect((await post(ALICE)).status).toBe(503);
    expect(store.grants[0]!.status).toBe("failed");
    chain.balances.set(SIGNER, 10_000_000_000);
    chain.fail = true;
    expect((await post(ALICE)).status).toBe(502);
    chain.fail = false;
    expect((await post(ALICE)).status).toBe(200);
  });

  it("GET /faucet reports eligibility", async () => {
    const res = await fetch(`${base}/faucet`, { headers: { Authorization: `Bearer ${issueSessionToken(ALICE).token}` } });
    expect(await res.json()).toMatchObject({ cluster: "devnet", amountLamports: 20_000_000, balanceLamports: 0, eligible: true, nextAt: null });
  });
});

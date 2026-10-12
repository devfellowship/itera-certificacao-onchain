import { Router, type Request, type RequestHandler, type Response } from "express";
import { DEVNET_GENESIS_HASH, type FaucetChain } from "../chain/faucet-chain.js";
import { explorerTxUrl } from "../chain/config.js";
import type { FaucetStore } from "../domain/faucet-store.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";

/**
 * Devnet faucet (U37, plan 20261012-itera-testmyagent-ui-refactor, Tainan TG 21122): a fresh wallet
 * gets enough test SOL to pay one evaluation, so anyone can run the full flow.
 *
 *   GET  /faucet   wallet — amount, balance, eligibility (no transfer)
 *   POST /faucet   wallet — sends `amountLamports` devnet SOL from the hot signer
 *
 * Refusals: not devnet (403), wallet balance already ≥ amount (409), one grant per wallet per
 * window (429 wallet_recent), global cap per window (429 daily_cap), hot signer below amount +
 * reserve (503), faucet off (404).
 */
export interface FaucetConfig {
  enabled: boolean;
  amountLamports: number;
  windowMs: number;
  /** Total lamports per window, all wallets. */
  capLamports: number;
  /** The hot signer also pays run fees: keep at least this much on it. */
  signerReserveLamports: number;
}

const LAMPORTS = 1_000_000_000;

function solEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = Number(env[name]);
  return Math.round((Number.isFinite(v) && v > 0 ? v : fallback) * LAMPORTS);
}

export function faucetConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FaucetConfig {
  return {
    enabled: env.ITERA_FAUCET !== "off",
    amountLamports: solEnv(env, "ITERA_FAUCET_AMOUNT_SOL", 0.02),
    windowMs: 24 * 60 * 60 * 1000,
    capLamports: solEnv(env, "ITERA_FAUCET_DAILY_CAP_SOL", 2),
    signerReserveLamports: solEnv(env, "ITERA_FAUCET_SIGNER_RESERVE_SOL", 0.5),
  };
}

export interface FaucetRouterDeps {
  store: FaucetStore;
  chain: FaucetChain;
  config: FaucetConfig;
  requireWallet: RequestHandler;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** A URL that names mainnet is refused before any RPC call; the genesis hash is the real check. */
export function looksLikeMainnet(rpcUrl: string): boolean {
  return /mainnet/i.test(rpcUrl);
}

export function createFaucetRouter(deps: FaucetRouterDeps): Router {
  const router = Router();
  const { store, chain, config, requireWallet } = deps;
  let devnet: boolean | null = null;

  async function assertDevnet() {
    if (looksLikeMainnet(chain.rpcUrl)) throw new HttpError(403, "the faucet runs on devnet only");
    if (devnet === null) devnet = (await chain.genesisHash()) === DEVNET_GENESIS_HASH;
    if (!devnet) throw new HttpError(403, "the faucet runs on devnet only");
  }

  const wrap =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      try {
        if (!config.enabled) throw new HttpError(404, "the faucet is off");
        await fn(req, res);
      } catch (e) {
        if (e instanceof HttpError) res.status(e.status).json({ error: e.message, ...e.extra });
        else if (e instanceof SchemaNotReadyError) res.status(503).json({ error: e.message });
        else {
          console.error("faucet-router error", e);
          res.status(502).json({ error: "the devnet transfer failed; try again later" });
        }
      }
    };

  const walletOf = (req: Request) => {
    if (!req.wallet) throw new HttpError(401, "a valid wallet session is required");
    return req.wallet;
  };

  router.get(
    "/faucet",
    requireWallet,
    wrap(async (req, res) => {
      const wallet = walletOf(req);
      await assertDevnet();
      const [balanceLamports, last] = await Promise.all([chain.balance(wallet), store.lastGrant(wallet)]);
      const nextAt = last ? new Date(Date.parse(last.createdAt) + config.windowMs) : null;
      const waiting = nextAt !== null && nextAt.getTime() > Date.now();
      res.json({
        cluster: "devnet",
        amountLamports: config.amountLamports,
        balanceLamports,
        eligible: balanceLamports < config.amountLamports && !waiting,
        nextAt: waiting ? nextAt!.toISOString() : null,
      });
    }),
  );

  router.post(
    "/faucet",
    requireWallet,
    wrap(async (req, res) => {
      const wallet = walletOf(req);
      await assertDevnet();
      const amount = config.amountLamports;
      const balanceLamports = await chain.balance(wallet);
      if (balanceLamports >= amount) {
        throw new HttpError(409, `this wallet already has ${amount / LAMPORTS} SOL or more`, { code: "has_balance", balanceLamports });
      }
      const r = await store.reserve({ wallet, lamports: amount, windowMs: config.windowMs, capLamports: config.capLamports });
      if (!r.ok && r.reason === "wallet_recent") throw new HttpError(429, "one faucet grant per wallet every 24 hours", { code: "wallet_recent", nextAt: r.nextAt });
      if (!r.ok) throw new HttpError(429, "the faucet reached its daily limit; try again tomorrow", { code: "daily_cap" });
      try {
        const signerBalance = await chain.balance(await chain.signerAddress());
        if (signerBalance < amount + config.signerReserveLamports) {
          await store.fail(r.grant.id, "hot signer below reserve");
          throw new HttpError(503, "the faucet is empty right now; try again later", { code: "faucet_empty" });
        }
        const txSig = await chain.transfer(wallet, amount);
        await store.complete(r.grant.id, txSig);
        res.json({ txSig, lamports: amount, sol: amount / LAMPORTS, explorerUrl: explorerTxUrl(txSig) });
      } catch (e) {
        if (!(e instanceof HttpError)) await store.fail(r.grant.id, e instanceof Error ? e.message : String(e)).catch(() => undefined);
        throw e;
      }
    }),
  );

  return router;
}

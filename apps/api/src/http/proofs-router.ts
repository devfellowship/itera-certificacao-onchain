import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import {
  CHAIN,
  IPFS_GATEWAY_URL,
  PUBLIC_WEB_BASE_URL,
  explorerAddressUrl,
  explorerTxUrl,
  nftImageUrl,
  nftMetadataUri,
} from "../chain/config.js";
import { redactManifest } from "../chain/evidence.js";
import type { ProofRecord, ProofRun, ProofStore } from "../chain/proof-store.js";
import { RunStartError, submitRunStart } from "../chain/run-start.js";
import { requireWallet } from "./auth.js";

/**
 * Lane D routes (plan 20261012-itera-agent-proof-route-change-fixes):
 *   POST /runs/:id/start-signature  (owner) relay the wallet-signed run-start Memo, store run_start_sig
 *   GET  /proofs/:hash              (public) everything the proof landing page needs
 *   GET  /leaderboard?benchmark=&version=  (public) best confirmed proof per agent
 */
export interface ProofsRouterDeps {
  store: ProofStore;
  /** Injected for tests; defaults to the real devnet relay. */
  submitRunStart?: typeof submitRunStart;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

const handle =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

export function createProofsRouter(deps: ProofsRouterDeps): Router {
  const { store } = deps;
  const relay = deps.submitRunStart ?? submitRunStart;
  const router = Router();

  router.post(
    "/runs/:id/start-signature",
    requireWallet,
    handle(async (req, res) => {
      const id = String(req.params.id);
      const run = UUID_RE.test(id) ? await store.getProofRun(id) : null;
      if (!run || !run.ownerWallet) {
        res.status(404).json({ error: "run not found" });
        return;
      }
      if (run.ownerWallet !== req.wallet) {
        res.status(403).json({ error: "only the owner of the run can sign its start" });
        return;
      }
      if (run.runStartSig) {
        res.json({ runStartSig: run.runStartSig, explorerUrl: explorerTxUrl(run.runStartSig), alreadySet: true });
        return;
      }
      const wire = (req.body as { wireTransactionBase64?: unknown } | undefined)?.wireTransactionBase64;
      if (typeof wire !== "string" || wire.length === 0 || wire.length > 4096) {
        res.status(400).json({ error: "wireTransactionBase64 is required" });
        return;
      }
      try {
        const submitted = await relay(wire, run.runId, { ownerWallet: run.ownerWallet });
        await store.setRunStartSig(run.runId, submitted.signature);
        res.json({ runStartSig: submitted.signature, explorerUrl: explorerTxUrl(submitted.signature) });
      } catch (error) {
        if (!(error instanceof RunStartError)) throw error;
        const status = error.code === "send_failed" || error.code === "not_confirmed" ? 502 : error.code === "wrong_wallet" ? 403 : 400;
        res.status(status).json({ error: error.message, code: error.code });
      }
    }),
  );

  router.get(
    "/proofs/:hash",
    handle(async (req, res) => {
      res.set("Access-Control-Allow-Origin", "*");
      const hash = String(req.params.hash).toLowerCase();
      const proof = HASH_RE.test(hash) ? await store.getProofByHash(hash) : null;
      const run = proof ? await store.getProofRun(proof.runId) : null;
      if (!proof || !run) {
        res.status(404).json({ error: "proof not found" });
        return;
      }
      res.json(proofView(proof, run));
    }),
  );

  router.get(
    "/leaderboard",
    handle(async (req, res) => {
      res.set("Access-Control-Allow-Origin", "*");
      const benchmark = typeof req.query.benchmark === "string" ? req.query.benchmark.trim() : "";
      const version = typeof req.query.version === "string" && req.query.version.trim() ? req.query.version.trim() : null;
      if (!benchmark) {
        res.status(400).json({ error: "benchmark is required: GET /leaderboard?benchmark=<id>[&version=<v>]" });
        return;
      }
      // U19: user tasks (pack ids user-<task_version_id>) are never ranked here; the store query
      // excludes them too.
      const entries = benchmark.startsWith("user-") ? [] : await store.leaderboard(benchmark, version);
      res.json({
        benchmark,
        version,
        entries: entries.map((e) => ({
          ...e,
          proofUrl: `${PUBLIC_WEB_BASE_URL}/proof/${e.proofHash}`,
          nftExplorerUrl: e.nftMint ? explorerAddressUrl(e.nftMint) : null,
        })),
      });
    }),
  );

  return router;
}

interface SuiteCounts {
  total?: number;
  passed?: number;
  failed?: number;
}

export function proofView(proof: ProofRecord, run: ProofRun) {
  const manifest = run.evidenceManifest ? redactManifest(run.evidenceManifest) : null;
  const tests = (manifest?.tests ?? null) as Record<string, SuiteCounts> | null;
  const counts = (s: SuiteCounts | undefined) => (s ? { total: s.total ?? 0, passed: s.passed ?? 0, failed: s.failed ?? 0 } : null);
  const score = (manifest?.score ?? null) as Record<string, number> | null;
  const { total: _total, ...parts } = score ?? {};
  return {
    proofHash: proof.manifestSha256,
    status: proof.status,
    error: proof.error,
    runId: run.runId,
    createdAt: proof.createdAt,
    benchmark: { id: run.benchmarkId, version: run.benchmarkVersion, scenarioId: (manifest?.scenario_id as string | undefined) ?? run.benchmarkId },
    agent: {
      id: run.agentId ?? null,
      name: run.agentName ?? null,
      repo: run.agentRepo ?? null,
      commit: run.agentCommit ?? null,
      model: run.modelId ?? null,
    },
    ownerWallet: proof.ownerWallet ?? run.ownerWallet,
    // U27 anti-collusion: both wallets, the label, and whether the task can enter a leaderboard.
    taskAuthorWallet: proof.taskAuthorWallet ?? null,
    agentOwnerWallet: proof.agentOwnerWallet ?? null,
    selfEvaluated: proof.selfEvaluated ?? false,
    ranked: proof.ranked ?? true,
    runStatus: run.status,
    score: { total: run.scoreTotal ?? (score?.total ?? null), parts },
    tests: tests
      ? { publicBaseline: counts(tests.public_baseline), publicAfterPatch: counts(tests.public_after_patch), hidden: counts(tests.hidden) }
      : null,
    patchScope: manifest?.patch_scope ?? null,
    nftMint: proof.nftMint,
    attestationAddress: proof.attestationAddress,
    txSig: proof.txSig,
    runStartSig: run.runStartSig,
    evidenceCid: proof.evidenceCid,
    evidenceUrl: proof.evidenceCid ? `${IPFS_GATEWAY_URL}/${proof.evidenceCid}` : null,
    nftMetadataUri: proof.nftMint ? nftMetadataUri(proof.nftMint) : null,
    nftImageUrl: proof.nftMint ? nftImageUrl(proof.nftMint) : null,
    explorer: {
      nft: proof.nftMint ? explorerAddressUrl(proof.nftMint) : null,
      tx: proof.txSig ? explorerTxUrl(proof.txSig) : null,
      attestation: proof.attestationAddress ? explorerAddressUrl(proof.attestationAddress) : null,
      runStart: run.runStartSig ? explorerTxUrl(run.runStartSig) : null,
    },
    // Inputs for the in-browser verifier (apps/web/src/verify.ts `verifyProof`). It re-derives
    // everything from chain + IPFS; these are only the addresses to start from.
    verify: {
      nftMint: proof.nftMint,
      cluster: CHAIN.CLUSTER,
      rpcUrl: "https://api.devnet.solana.com",
      credential: CHAIN.CREDENTIAL_PDA,
      schema: CHAIN.RUN_RESULT_SCHEMA_PDA,
      ipfsGateway: IPFS_GATEWAY_URL,
    },
  };
}

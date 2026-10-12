/**
 * Build-order item 6 (Samuel's brief): the 7 checks a public verifier runs, in order, against
 * nothing but an attestation mint address (the NFT) and read-only RPC/IPFS fetches. No server,
 * no Supabase — "a página /verify não deve depender do nosso servidor pra confirmar um resultado"
 * (William, clarifying what "100% on-chain" meant).
 *
 * Browser-safe on purpose: Web Crypto (`crypto.subtle`) instead of node:crypto, no fs access.
 * Runs the same in Node (for the test script below) and in the browser (VerifyPage.tsx).
 */
import {
  deserializeAttestationData,
  fetchMaybeAttestation,
  fetchMaybeCredential,
  fetchMaybeSchema,
  findAttestationPda,
} from '@solana/attestation';
import {
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';
import { fetchMaybeMint, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

// Itera's known addresses — fixed in the frontend, per the brief's check #2 ("credential e schema
// são os endereços da Itera, fixos no código do front"). Changing these is a deploy, not a
// runtime config.
export const SAS_PROGRAM_ADDRESS = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG' as Address;
export const ITERA_CREDENTIAL_PDA = 'Dh9NF2L2Ua2u4TUzKRX5u8S5DDCBLNA7aVkunteXt7A3' as Address;
export const ITERA_RUN_RESULT_SCHEMA_PDA = '3FGWK6AsxtXje8r4Eq3rq3GPdoRd3ifx5UN9oKm4w94x' as Address;
export const DEVNET_RPC_URL = 'https://api.devnet.solana.com';

export interface CheckResult {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}

export interface VerificationReport {
  attestationMint: Address;
  overall: 'VERIFIED' | 'MISMATCH';
  checks: CheckResult[];
  /** Populated when check 4 passes — the pinned manifest JSON, for display and for the tamper demo. */
  manifest?: unknown;
  /** The on-chain manifest_sha256, when the attestation data could be read (independent of
   * whether check 4 itself passed) — lets the UI's tamper demo compare a recomputed hash
   * against the REAL on-chain value, not a re-derived approximation. */
  manifestSha256?: string;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Minimal RPC surface this module needs — satisfied by both createSolanaRpc (Node/this file's
 * own test script) and the kit-plugin-rpc client used elsewhere in the repo. */
type VerifierRpc = Rpc<Pick<SolanaRpcApi, 'getTokenLargestAccounts' | 'getTransaction' | 'getAccountInfo'>>;

export async function runVerification(rpc: VerifierRpc, attestationMint: Address): Promise<VerificationReport> {
  const checks: CheckResult[] = [];
  const fail = (id: string, label: string, detail: string) => checks.push({ id, label, status: 'fail', detail });
  const pass = (id: string, label: string, detail: string) => checks.push({ id, label, status: 'pass', detail });
  const skip = (id: string, label: string, detail: string) => checks.push({ id, label, status: 'skip', detail });

  let manifestSha256Value: string | undefined;
  const done = (manifest?: unknown): VerificationReport => ({
    attestationMint,
    overall: checks.every((c) => c.status !== 'fail') ? 'VERIFIED' : 'MISMATCH',
    checks,
    manifest,
    manifestSha256: manifestSha256Value,
  });

  // --- Check 1 + partial 7: the mint account exists, is owned by Token-2022, is the expected
  // shape (decimals 0, non-transferable, carries the attestation+schema links in its metadata).
  const mint = await fetchMaybeMint(rpc, attestationMint);
  if (!mint.exists) {
    fail('mint-exists', 'NFT mint account exists', 'No account found at this address on devnet.');
    return done();
  }
  if (mint.programAddress !== TOKEN_2022_PROGRAM_ADDRESS) {
    fail('mint-exists', 'NFT mint account exists', `Owned by ${mint.programAddress}, expected the Token-2022 program ${TOKEN_2022_PROGRAM_ADDRESS}.`);
    return done();
  }
  pass('mint-exists', 'NFT mint account exists', `Owned by ${mint.programAddress} (Token-2022).`);

  const extensions = mint.data.extensions.__option === 'Some' ? mint.data.extensions.value : [];
  const nonTransferable = extensions.some((e) => e.__kind === 'NonTransferable');
  if (!nonTransferable) {
    fail('non-transferable', 'Token is non-transferable', 'Missing the NonTransferable extension — this is not a soulbound TestMyAgent credential.');
  } else {
    pass('non-transferable', 'Token is non-transferable', 'NonTransferable extension present.');
  }

  const tokenMetadata = extensions.find((e) => e.__kind === 'TokenMetadata');
  if (!tokenMetadata || tokenMetadata.__kind !== 'TokenMetadata') {
    fail('metadata-present', 'Token metadata present', 'No TokenMetadata extension — cannot find the linked attestation/schema.');
    return done();
  }
  const attestationPda = tokenMetadata.additionalMetadata.get('attestation') as Address | undefined;
  const schemaPdaFromMetadata = tokenMetadata.additionalMetadata.get('schema') as Address | undefined;
  if (!attestationPda || !schemaPdaFromMetadata) {
    fail('metadata-present', 'Token metadata present', 'TokenMetadata is missing the attestation/schema additional fields.');
    return done();
  }
  pass('metadata-present', 'Token metadata present', `attestation=${attestationPda}, schema=${schemaPdaFromMetadata}`);

  // --- Check 2: credential and schema are Itera's known, fixed addresses.
  if (schemaPdaFromMetadata !== ITERA_RUN_RESULT_SCHEMA_PDA) {
    fail('known-schema', 'Schema is the known TestMyAgent schema', `Expected ${ITERA_RUN_RESULT_SCHEMA_PDA}, got ${schemaPdaFromMetadata}.`);
  } else {
    pass('known-schema', 'Schema is the known TestMyAgent schema', schemaPdaFromMetadata);
  }

  const attestation = await fetchMaybeAttestation(rpc, attestationPda);
  if (!attestation.exists) {
    fail('attestation-exists', 'Attestation account exists', `No account found at ${attestationPda}.`);
    return done();
  }
  if (attestation.data.credential !== ITERA_CREDENTIAL_PDA) {
    fail('known-credential', 'Credential is the known TestMyAgent credential', `Expected ${ITERA_CREDENTIAL_PDA}, got ${attestation.data.credential}.`);
  } else {
    pass('known-credential', 'Credential is the known TestMyAgent credential', attestation.data.credential);
  }

  // --- Check 3: the Credential currently has at least one authorized signer (structural check —
  // the Attestation account itself doesn't retain WHICH signer produced it, so this can't prove
  // retroactively that THIS specific attestation was signed by a then-authorized key; it proves
  // the credential is a live, actively-managed one, not an abandoned/misconfigured account).
  const credential = await fetchMaybeCredential(rpc, ITERA_CREDENTIAL_PDA);
  if (!credential.exists || credential.data.authorizedSigners.length === 0) {
    fail('has-signers', 'Credential has an authorized signer', 'No authorized signers found.');
  } else {
    pass('has-signers', 'Credential has an authorized signer', `${credential.data.authorizedSigners.length} signer(s) on file.`);
  }

  const schema = await fetchMaybeSchema(rpc, schemaPdaFromMetadata);
  if (!schema.exists) {
    fail('schema-exists', 'Schema account exists', `No account found at ${schemaPdaFromMetadata}.`);
    return done();
  }
  const data = deserializeAttestationData(schema.data, attestation.data.data) as {
    manifest_sha256: string;
    evidence_cid: string;
    scenario_id: string;
    score_total: number;
    run_start_sig: string;
  };
  manifestSha256Value = data.manifest_sha256;

  // --- Check 6: the attestation's address derives from the run-start signature — binds this
  // specific result to a specific, wallet-signed run start, not just any Memo with a matching CID.
  // v1 (a single run): nonce seed = sha256(run_start_sig).
  // v2 (a run of an evaluation, one wallet prompt): run_start_sig is the payment tx, whose Memo is
  // `itera-eval:v1:{..., run_ids:[...]}`; nonce seed = sha256(`${run_start_sig}:${run_id}`) for one
  // run id named in that Memo.
  const nonceAddress = async (seedText: string) =>
    (await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seedText))))).address;
  const pdaForSeed = async (seedText: string) =>
    (await findAttestationPda({ credential: ITERA_CREDENTIAL_PDA, schema: schemaPdaFromMetadata, nonce: await nonceAddress(seedText) }))[0];
  if ((await pdaForSeed(data.run_start_sig)) === attestationPda) {
    pass('nonce-binding', 'Attestation address derives from run_start_sig', 'Recomputed address matches.');
  } else {
    let boundRunId: string | null = null;
    try {
      const startTx = await rpc.getTransaction(data.run_start_sig as never, { maxSupportedTransactionVersion: 0, encoding: 'json' }).send();
      for (const runId of evaluationMemoRunIds(startTx)) {
        if ((await pdaForSeed(`${data.run_start_sig}:${runId}`)) === attestationPda) {
          boundRunId = runId;
          break;
        }
      }
    } catch {
      // Falls through to the failure below with the reason.
    }
    if (boundRunId) {
      pass('nonce-binding', 'Attestation address derives from run_start_sig', `Evaluation run ${boundRunId}: recomputed address matches.`);
    } else {
      fail('nonce-binding', 'Attestation address derives from run_start_sig', `No v1 or v2 (evaluation Memo) derivation gives ${attestationPda}.`);
    }
  }

  // --- Check 5: the run-start Memo transaction exists, is confirmed, and its scenario_id matches
  // this result's. (agent_commit/model_id aren't part of the on-chain schema — only in the Memo
  // and the off-chain manifest — so a full field-by-field cross-check needs the manifest too; see
  // check 4 below for that half.)
  //
  // Wrapped in try/catch on purpose: the public devnet RPC rate-limits/method-blocks
  // getTransaction much harder than basic account reads (measured 2026-10-09: HTTP 429 with
  // x-ratelimit-method-limit: 0 on the free tier, not a transient burst — see the RPC provider
  // decision in the technical decision sheet). A verifier shouldn't see the whole page crash
  // because of that; it should see "couldn't check this one" and still get results for
  // everything else.
  try {
    const runStartTx = await rpc.getTransaction(data.run_start_sig as never, { maxSupportedTransactionVersion: 0, encoding: 'json' }).send();
    if (!runStartTx) {
      fail('run-start-exists', 'Run-start transaction exists and is confirmed', `No confirmed transaction found for signature ${data.run_start_sig}.`);
    } else {
      // @solana/kit returns u64 fields as bigint, which JSON.stringify cannot serialize.
      const memoLogged = JSON.stringify(runStartTx, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).includes(data.scenario_id);
      if (!memoLogged) {
        fail('run-start-exists', 'Run-start transaction exists and is confirmed', 'Transaction found, but its Memo does not mention this scenario_id.');
      } else {
        pass('run-start-exists', 'Run-start transaction exists and is confirmed', `Confirmed, block time ${runStartTx.blockTime ?? 'unknown'}.`);
      }
    }
  } catch (error) {
    skip('run-start-exists', 'Run-start transaction exists and is confirmed', `RPC call failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // --- Check 7 (rest): exactly one holder, balance 1. Read from the mint account itself: with
  // decimals 0 and supply 1, at most one token account can hold the token, and it holds exactly 1.
  // getTokenLargestAccounts is only used to name the holder: the public devnet RPC blocks that
  // method outright (measured 2026-10-12: HTTP 429, x-ratelimit-method-limit: 0), so it can never
  // be the source of the verdict.
  if (mint.data.decimals !== 0 || mint.data.supply !== 1n) {
    fail('single-holder', 'Exactly one holder, balance 1', `Mint has decimals ${mint.data.decimals} and supply ${mint.data.supply}; expected 0 and 1.`);
  } else {
    let holder = 'holder address not available from this RPC';
    try {
      const { value: largestAccounts } = await rpc.getTokenLargestAccounts(attestationMint).send();
      if (largestAccounts[0]) holder = `held by token account ${largestAccounts[0].address}`;
    } catch {
      // Naming the holder is optional; the supply already proves the property.
    }
    pass('single-holder', 'Exactly one holder, balance 1', `Supply 1, decimals 0 — ${holder}.`);
  }

  // --- Check 4: sha256 of the pinned manifest's raw bytes matches manifest_sha256 on-chain.
  try {
    const ipfsResponse = await fetch(`https://gateway.pinata.cloud/ipfs/${data.evidence_cid}`);
    if (!ipfsResponse.ok) {
      skip('manifest-hash', 'Pinned manifest hash matches on-chain record', `IPFS fetch failed: HTTP ${ipfsResponse.status}.`);
      return done();
    }
    const manifestBytes = new Uint8Array(await ipfsResponse.arrayBuffer());
    const actualSha256 = await sha256Hex(manifestBytes);
    if (actualSha256 !== data.manifest_sha256) {
      fail('manifest-hash', 'Pinned manifest hash matches on-chain record', `Downloaded file hashes to ${actualSha256}, chain says ${data.manifest_sha256}.`);
      return done();
    }
    pass('manifest-hash', 'Pinned manifest hash matches on-chain record', 'sha256 matches exactly.');
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    // Evidence documents from the API proof path (schema itera-evidence/v1, apps/api/src/chain/
    // evidence.ts) also name the run-start signature they belong to. Older manifests do not, so
    // this check only runs when the field is present.
    const boundSig = (manifest as { run?: { run_start_sig?: unknown } } | null)?.run?.run_start_sig;
    if (typeof boundSig === 'string') {
      if (boundSig !== data.run_start_sig) {
        fail('evidence-binding', 'Evidence names the same run-start transaction', `Evidence says ${boundSig}, chain says ${data.run_start_sig}.`);
      } else {
        pass('evidence-binding', 'Evidence names the same run-start transaction', 'run_start_sig matches.');
      }
    }
    return done(manifest);
  } catch (error) {
    skip('manifest-hash', 'Pinned manifest hash matches on-chain record', `Could not fetch/parse: ${error instanceof Error ? error.message : String(error)}`);
    return done();
  }
}

/** Run ids named by an `itera-eval:v1:` Memo in a transaction (empty when there is none). */
export function evaluationMemoRunIds(tx: unknown): string[] {
  const logs = (tx as { meta?: { logMessages?: readonly string[] | null } } | null)?.meta?.logMessages ?? [];
  for (const line of logs) {
    const at = line.indexOf('itera-eval:v1:');
    if (at < 0) continue;
    // The Memo program logs `Memo (len N): "<text>"` with the text JSON-escaped.
    let text = line.slice(at + 'itera-eval:v1:'.length);
    if (text.endsWith('"')) text = text.slice(0, -1);
    try {
      const body = JSON.parse(text.includes('\\"') ? JSON.parse(`"${text}"`) : text) as { run_ids?: unknown };
      if (Array.isArray(body.run_ids)) return body.run_ids.filter((x): x is string => typeof x === 'string').map(toUuid);
    } catch {
      // Not a parsable evaluation memo.
    }
  }
  return [];
}

function toUuid(id: string): string {
  const h = id.replace(/-/g, '').toLowerCase();
  return h.length === 32 ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : id;
}

/** Convenience factory — same RPC the rest of the repo points at devnet with. */
export function createVerifierRpc(): VerifierRpc {
  return createSolanaRpc(DEVNET_RPC_URL) as VerifierRpc;
}

/**
 * Verifies the NFT of a proof. Accepts the NFT mint itself, or a proof object as returned by the
 * API's public `GET /proofs/:hash` (`{ nftMint }`). The checks run against chain + IPFS only; the
 * proof object is used for nothing but the mint address.
 */
export async function verifyProof(
  proof: string | { nftMint: string | null | undefined },
  rpc: VerifierRpc = createVerifierRpc(),
): Promise<VerificationReport> {
  const mint = typeof proof === 'string' ? proof : proof.nftMint;
  if (!mint) throw new Error('This proof has no NFT yet (status pending or failed) — nothing on chain to verify.');
  return runVerification(rpc, mint.trim() as Address);
}

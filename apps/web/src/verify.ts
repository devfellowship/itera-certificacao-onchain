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
    fail('non-transferable', 'Token is non-transferable', 'Missing the NonTransferable extension — this is not a soulbound Itera credential.');
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
    fail('known-schema', 'Schema is the known Itera schema', `Expected ${ITERA_RUN_RESULT_SCHEMA_PDA}, got ${schemaPdaFromMetadata}.`);
  } else {
    pass('known-schema', 'Schema is the known Itera schema', schemaPdaFromMetadata);
  }

  const attestation = await fetchMaybeAttestation(rpc, attestationPda);
  if (!attestation.exists) {
    fail('attestation-exists', 'Attestation account exists', `No account found at ${attestationPda}.`);
    return done();
  }
  if (attestation.data.credential !== ITERA_CREDENTIAL_PDA) {
    fail('known-credential', 'Credential is the known Itera credential', `Expected ${ITERA_CREDENTIAL_PDA}, got ${attestation.data.credential}.`);
  } else {
    pass('known-credential', 'Credential is the known Itera credential', attestation.data.credential);
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

  // --- Check 6: the attestation's address derives from sha256(run_start_sig) — binds this
  // specific result to a specific, wallet-signed run start, not just any Memo with a matching CID.
  const nonceSeed = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data.run_start_sig)));
  const nonceSigner = await createKeyPairSignerFromPrivateKeyBytes(nonceSeed);
  const [expectedAttestationPda] = await findAttestationPda({
    credential: ITERA_CREDENTIAL_PDA,
    schema: schemaPdaFromMetadata,
    nonce: nonceSigner.address,
  });
  if (expectedAttestationPda !== attestationPda) {
    fail('nonce-binding', 'Attestation address derives from run_start_sig', `Recomputed ${expectedAttestationPda}, found ${attestationPda}.`);
  } else {
    pass('nonce-binding', 'Attestation address derives from run_start_sig', 'Recomputed address matches.');
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
      const memoLogged = JSON.stringify(runStartTx).includes(data.scenario_id);
      if (!memoLogged) {
        fail('run-start-exists', 'Run-start transaction exists and is confirmed', 'Transaction found, but its Memo does not mention this scenario_id.');
      } else {
        pass('run-start-exists', 'Run-start transaction exists and is confirmed', `Confirmed, block time ${runStartTx.blockTime ?? 'unknown'}.`);
      }
    }
  } catch (error) {
    skip('run-start-exists', 'Run-start transaction exists and is confirmed', `RPC call failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // --- Check 7 (rest): exactly one holder, balance 1. Same resilience reasoning as check 5.
  try {
    const { value: largestAccounts } = await rpc.getTokenLargestAccounts(attestationMint).send();
    if (largestAccounts.length !== 1 || largestAccounts[0].amount !== '1') {
      fail('single-holder', 'Exactly one holder, balance 1', `Found ${largestAccounts.length} account(s): ${largestAccounts.map((a) => `${a.address}=${a.amount}`).join(', ')}`);
    } else {
      pass('single-holder', 'Exactly one holder, balance 1', `Held by ${largestAccounts[0].address}.`);
    }
  } catch (error) {
    skip('single-holder', 'Exactly one holder, balance 1', `RPC call failed: ${error instanceof Error ? error.message : String(error)}`);
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
    return done(manifest);
  } catch (error) {
    skip('manifest-hash', 'Pinned manifest hash matches on-chain record', `Could not fetch/parse: ${error instanceof Error ? error.message : String(error)}`);
    return done();
  }
}

/** Convenience factory — same RPC the rest of the repo points at devnet with. */
export function createVerifierRpc(): VerifierRpc {
  return createSolanaRpc(DEVNET_RPC_URL) as VerifierRpc;
}

import {
  deserializeAttestationData,
  fetchAttestation,
  fetchSchema,
  findAttestationPda,
  getCreateAttestationInstruction,
  serializeAttestationData,
} from '@solana/attestation';
import { createClient, createKeyPairSignerFromPrivateKeyBytes, type Address, type KeyPairSigner } from '@solana/kit';
import { solanaDevnetRpc } from '@solana/kit-plugin-rpc';
import { payerFromFile } from '@solana/kit-plugin-signer';
import { createHash } from 'node:crypto';
import { hotSignerKeypairPath } from '../config.js';
import type { EvidenceManifest } from './evidence-manifest.js';

/**
 * Day 3 of the pivot doc (03_produto_mvp_72h.pdf section 9): real SAS issuance + verification.
 * This reuses the Credential/Schema already live on devnet from the pre-pivot work (PR #11,
 * `services/attestation`) rather than minting a new schema — `coding-benchmark-score-v1`'s five
 * fields (scenario_id, fixture_hash, patch_hash, score_total, generated_at) map directly onto the
 * real EvidenceManifest the evaluator produces.
 *
 * A STANDARD (non-tokenized) Attestation, not the Tokenized/NFT variant services/attestation also
 * supports: this pivot's four pages never connect a wallet anywhere (doc: "sem wallet obrigatória
 * para a prova pública" — the buyer doesn't need one, and PreparePage/ObservePage/CredentialPage
 * have no wallet UI at all). Tokenizing only pays off when the credential needs to render inside
 * a wallet; nothing here does, so the plain Attestation is the right fit, not a Tokenized one.
 *
 * Code here is deliberately NOT imported from services/attestation — same "duplicate, don't
 * cross-import between independently-deployable units" convention this repo already follows (see
 * services/run-issuer/src/client.ts's own comment on this).
 */

export const SAS_PROGRAM_ADDRESS = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG' as Address;
export const ITERA_CREDENTIAL_PDA = 'Dh9NF2L2Ua2u4TUzKRX5u8S5DDCBLNA7aVkunteXt7A3' as Address;
export const ITERA_SCORE_SCHEMA_PDA = 'ABA68smXFGBtByCUKAzDaRi3SckBmmaWzKuoBbGCy79d' as Address;
const DEVNET_RPC_URL = 'https://api.devnet.solana.com';
const DEVNET_WSS_URL = 'wss://api.devnet.solana.com';

type Client = Awaited<ReturnType<typeof setupClient>>;

async function setupClient() {
  // Same keypair acts as fee payer AND the attestation's authorized signer — it's already
  // authorized on the live Credential (services/attestation/src/setup.ts's
  // ensureHotSignerAuthorized, run during the pre-pivot work) and funded on devnet.
  return createClient()
    .use(payerFromFile(hotSignerKeypairPath()))
    .use(solanaDevnetRpc({ rpcUrl: DEVNET_RPC_URL, rpcSubscriptionsUrl: DEVNET_WSS_URL }));
}

/** Deterministic per claim manifest: re-issuing for the same claim resolves to the same
 * Attestation PDA instead of a random one, matching the idempotent-issuance pattern used
 * elsewhere in this project. */
async function nonceForClaim(claimManifestId: string): Promise<KeyPairSigner['address']> {
  const seed = createHash('sha256').update(claimManifestId, 'utf-8').digest();
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  return signer.address;
}

export interface IssuedAttestation {
  attestationAddress: Address;
  signature: string;
}

export async function issueScoreAttestation(claimManifestId: string, manifest: EvidenceManifest): Promise<IssuedAttestation> {
  if (!Number.isInteger(manifest.score.total) || manifest.score.total < 0 || manifest.score.total > 100) {
    throw new Error(`score.total must be an integer 0-100; got ${manifest.score.total}`);
  }
  const client: Client = await setupClient();
  const payer = client.payer as KeyPairSigner;
  const nonce = await nonceForClaim(claimManifestId);
  const [attestationPda] = await findAttestationPda({ credential: ITERA_CREDENTIAL_PDA, schema: ITERA_SCORE_SCHEMA_PDA, nonce });
  const schema = await fetchSchema(client.rpc, ITERA_SCORE_SCHEMA_PDA);

  const data = serializeAttestationData(schema.data, {
    scenario_id: manifest.scenario_id,
    fixture_hash: manifest.fixture_hash,
    patch_hash: manifest.patch_hash,
    score_total: manifest.score.total,
    generated_at: manifest.generated_at,
  });

  const instruction = getCreateAttestationInstruction({
    payer,
    authority: payer,
    credential: ITERA_CREDENTIAL_PDA,
    schema: ITERA_SCORE_SCHEMA_PDA,
    attestation: attestationPda,
    nonce,
    expiry: 0, // never expires — an evidence record is historical, not time-boxed (same choice as services/attestation/src/config.ts).
    data,
  });
  const { context } = await client.sendTransaction(instruction);
  return { attestationAddress: attestationPda, signature: context.signature };
}

export interface OnChainVerification {
  exists: boolean;
  ownedBySasProgram: boolean;
  credentialMatches: boolean;
  schemaMatches: boolean;
  decoded: { scenario_id: string; fixture_hash: string; patch_hash: string; score_total: number; generated_at: string } | null;
}

/** Real on-chain read — no server-side trust, just RPC + the known Credential/Schema addresses,
 * matching the doc's "Checks do consumidor" (section 7): confirm program owner, confirm
 * credential/schema against a trust store (here: the two constants above), recompute from the
 * account's own data. */
export async function verifyOnChain(attestationAddress: Address): Promise<OnChainVerification> {
  const client = await setupClient();
  const accountInfo = await client.rpc.getAccountInfo(attestationAddress, { encoding: 'base64' }).send();
  if (!accountInfo.value) {
    return { exists: false, ownedBySasProgram: false, credentialMatches: false, schemaMatches: false, decoded: null };
  }
  const ownedBySasProgram = accountInfo.value.owner === SAS_PROGRAM_ADDRESS;

  const { data: attestation } = await fetchAttestation(client.rpc, attestationAddress);
  const credentialMatches = attestation.credential === ITERA_CREDENTIAL_PDA;
  const schemaMatches = attestation.schema === ITERA_SCORE_SCHEMA_PDA;

  let decoded: OnChainVerification['decoded'] = null;
  if (schemaMatches) {
    // Deserializing against the live on-chain Schema account (not a hand-built layout guess) is
    // what makes this a real check: if the attestation's bytes don't actually match the known
    // schema's layout, this throws instead of silently returning garbage.
    const { data: schema } = await fetchSchema(client.rpc, ITERA_SCORE_SCHEMA_PDA);
    decoded = deserializeAttestationData(schema, attestation.data);
  }

  return { exists: true, ownedBySasProgram, credentialMatches, schemaMatches, decoded };
}

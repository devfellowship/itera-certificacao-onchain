/**
 * Build-order item 5 (Samuel's brief): pin the evidence manifest to IPFS and derive the
 * `manifest_sha256` that gets anchored on-chain.
 *
 * Pinata is the default provider — most common in the Solana/NFT ecosystem, simple REST API via
 * a JWT bearer token. No account/key exists yet (pending a team decision, asked in
 * #chapter-web3 2026-10-09) — PINATA_JWT has no default and this module fails loud, not silently,
 * if it's missing. Swapping providers later only means rewriting `pinBytes` below; everything
 * downstream (manifest_sha256, evidence_cid, the tokenized attestation call) is provider-agnostic.
 *
 * "Pin pago, não gateway grátis" (the brief's own words) is about retrieval reliability, not
 * cost for its own sake — a free/anonymous gateway doesn't guarantee a file stays retrievable,
 * which would make a published attestation point at evidence nobody can actually fetch anymore.
 */
import { createHash } from 'node:crypto';

const PINATA_PIN_FILE_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';

export function pinataJwt(): string {
  const token = process.env.PINATA_JWT;
  if (!token) {
    throw new Error(
      'PINATA_JWT is not set. Get an API key from pinata.cloud (or swap this module for the ' +
        'team\'s chosen provider) and set it before pinning anything.',
    );
  }
  return token;
}

export interface PinnedManifest {
  /** The CID Pinata returned — this is `evidence_cid` in the run-result-v2 schema. */
  cid: string;
  /**
   * sha256 of the EXACT bytes that were pinned, hex-encoded — this is `manifest_sha256` in the
   * schema. Computed from the same buffer passed to `pinBytes`, never from re-serializing the
   * manifest object afterward: a verifier must be able to hash the bytes it downloads from IPFS
   * and get this same value, so any re-serialization step (different key order, different
   * whitespace) would make every manifest fail verification even when nothing was tampered with.
   */
  manifestSha256: string;
  sizeBytes: number;
}

/**
 * Pins raw bytes to IPFS via Pinata and returns the resulting CID alongside the sha256 of
 * those exact bytes. Callers should serialize the manifest to a canonical JSON buffer ONCE and
 * pass that same buffer here — don't re-serialize before or after this call.
 */
export async function pinBytes(bytes: Uint8Array, filename: string): Promise<PinnedManifest> {
  const manifestSha256 = createHash('sha256').update(bytes).digest('hex');

  const form = new FormData();
  form.append('file', new Blob([bytes]), filename);
  form.append('pinataMetadata', JSON.stringify({ name: filename }));

  const response = await fetch(PINATA_PIN_FILE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pinataJwt()}` },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '<no body>');
    throw new Error(`Pinata pin failed: HTTP ${response.status} — ${body.slice(0, 500)}`);
  }

  const result = (await response.json()) as { IpfsHash: string };
  return { cid: result.IpfsHash, manifestSha256, sizeBytes: bytes.length };
}

/**
 * Canonical JSON serialization for an evidence manifest — stable key order via JSON.stringify's
 * own insertion-order behavior on an object built in a fixed field order. Both the pin and the
 * sha256 in PinnedManifest come from calling `pinBytes` on this exact output; never reformat it
 * afterward.
 */
export function manifestToPinnableBytes(manifest: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest, null, 2));
}

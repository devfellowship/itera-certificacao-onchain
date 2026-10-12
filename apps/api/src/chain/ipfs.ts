import { createHash } from "node:crypto";

/**
 * IPFS pinning seam. Pinata is the only implementation today (env `PINATA_JWT`). The token is
 * optional: `pinnerFromEnv()` returns null when it is missing and `issueProof` records
 * the proof as `failed` with `ipfs not configured`. Nothing here ever invents a CID.
 */
export interface Pinner {
  /** Pins exactly `bytes` and returns the CID the provider reports. */
  pin(bytes: Uint8Array, filename: string): Promise<{ cid: string }>;
}

export class PinError extends Error {}

const PINATA_PIN_FILE_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";

export class PinataPinner implements Pinner {
  constructor(private readonly jwt: string) {}

  async pin(bytes: Uint8Array, filename: string): Promise<{ cid: string }> {
    const form = new FormData();
    form.append("file", new Blob([bytes]), filename);
    form.append("pinataMetadata", JSON.stringify({ name: filename }));
    // CIDv1 so the CID is the same one any IPFS tool computes for these raw bytes.
    form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
    const response = await fetch(PINATA_PIN_FILE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.jwt}` },
      body: form,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "<no body>");
      throw new PinError(`Pinata pin failed: HTTP ${response.status} — ${body.slice(0, 300)}`);
    }
    const result = (await response.json()) as { IpfsHash?: string };
    if (!result.IpfsHash) throw new PinError("Pinata answered without an IpfsHash");
    return { cid: result.IpfsHash };
  }
}

export function pinnerFromEnv(env: NodeJS.ProcessEnv = process.env): Pinner | null {
  return env.PINATA_JWT ? new PinataPinner(env.PINATA_JWT) : null;
}

/**
 * The exact bytes that get pinned AND hashed. Serialize ONCE; never re-serialize: a verifier
 * hashes the bytes it downloads from IPFS and must get `manifest_sha256`. Same format as
 * services/attestation/src/ipfs.ts (`JSON.stringify(manifest, null, 2)`).
 */
export function manifestBytes(manifest: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest, null, 2));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

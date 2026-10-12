// BYOK model key of a run (Tainan TG 20935: the user pays the model tokens).
// Same format as services/runner/src/run-key.ts (duplicated on purpose, like the rest of this repo;
// services/runner/src/run-key.test.ts proves that the two stay compatible).
//   v1.<iv>.<tag>.<ciphertext>   (base64url, AES-256-GCM, key = HKDF-SHA256(ITERA_RUN_KEY_SECRET))
import { createDecipheriv, createCipheriv, hkdfSync, randomBytes } from "node:crypto";

function deriveKey(secret: string): Buffer {
  if (!secret || secret.length < 32) throw new Error("ITERA_RUN_KEY_SECRET must be at least 32 characters");
  return Buffer.from(hkdfSync("sha256", secret, "itera-run-key", "v1", 32));
}

export function encryptRunKey(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptRunKey(sealed: string, secret: string): string {
  const [version, iv, tag, ct] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || ct === undefined) throw new Error("unknown run key format");
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf-8");
}

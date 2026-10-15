import { encryptRunKey } from "../../domain/run-key.js";
import { isModelApiKey } from "../../http/runs-router.js";
import type { PaymentOutcome } from "./types.js";

export type SealedModelKey = { ok: true; modelApiKeyEnc: string | null } | { ok: false; outcome: PaymentOutcome };

/**
 * The optional BYOK model key of `POST /evaluations`: absent → null; else it must look like an API
 * key and the server must hold `ITERA_RUN_KEY_SECRET`. The key is sealed (AES-256-GCM) and never
 * stored in clear. Shared by the payment adapters.
 */
export function sealModelApiKey(modelApiKey: unknown, runKeySecret: string | undefined): SealedModelKey {
  if (modelApiKey === undefined || modelApiKey === null || modelApiKey === "") return { ok: true, modelApiKeyEnc: null };
  if (!isModelApiKey(modelApiKey)) return { ok: false, outcome: { status: 400, body: { error: "modelApiKey is not a plausible API key" } } };
  if (!runKeySecret) return { ok: false, outcome: { status: 503, body: { error: "BYOK is not configured on this server (ITERA_RUN_KEY_SECRET)" } } };
  return { ok: true, modelApiKeyEnc: encryptRunKey(modelApiKey.trim(), runKeySecret) };
}

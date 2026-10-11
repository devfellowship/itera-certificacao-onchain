import { createHash } from "node:crypto";

/**
 * Deterministic JSON stringification (sorted object keys), the same shape RFC 8785 requires for
 * this purpose and what the Tainan doc's own prototype uses client-side (ux_prototipo.html's
 * `stable()`). Same input object always produces the same digest, regardless of key insertion
 * order — required so re-publishing an unchanged manifest doesn't silently mint a new digest.
 */
export function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

/** Convenience: canonical digest of an arbitrary JSON-serializable value. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}

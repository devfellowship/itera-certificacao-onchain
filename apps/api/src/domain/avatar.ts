import { createHash } from "node:crypto";
import sharp from "sharp";

/**
 * Profile pictures (U36, plan 20261012-itera-testmyagent-ui-refactor).
 *
 * An upload is PNG, JPEG or WebP, at most 2 MB. The API decodes it (the bytes decide the format,
 * never the declared content type), crops it to a centered square, resizes it to 256×256 and
 * re-encodes it as WebP. sharp drops EXIF, ICC, XMP and every other metadata block unless
 * `withMetadata()` is called, so the stored file carries pixels only.
 *
 * Storage: the public Supabase Storage bucket `avatars` of the TestMyAgent project. Object key =
 * `<wallet>/<first 16 hex of sha256(webp)>.webp` for a user, `agents/<agent id>/<hash>.webp` for an agent: the same picture gives the same key, and a new
 * picture gives a new URL (no stale CDN cache).
 */

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_SIZE = 256;
export const AVATAR_FORMATS = ["png", "jpeg", "webp"] as const;
export const AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const AVATAR_BUCKET = "avatars";

export class AvatarRejectedError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 413 | 415 = 400,
  ) {
    super(message);
  }
}

export interface ProcessedAvatar {
  bytes: Buffer;
  sha256: string;
  key: string;
}

/**
 * Decodes, validates, crops, resizes and re-encodes. Throws AvatarRejectedError.
 * `prefix` is the folder of the object key: the wallet for a user, `agents/<agent id>` for an agent.
 */
export async function processAvatar(prefix: string, input: Buffer): Promise<ProcessedAvatar> {
  if (input.length === 0) throw new AvatarRejectedError("the file is empty");
  if (input.length > AVATAR_MAX_BYTES) throw new AvatarRejectedError("the file is larger than 2 MB", 413);
  let format: string | undefined;
  let width = 0;
  let height = 0;
  try {
    const meta = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
    format = meta.format;
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  } catch {
    throw new AvatarRejectedError("the file is not a readable image", 415);
  }
  if (!format || !(AVATAR_FORMATS as readonly string[]).includes(format)) {
    throw new AvatarRejectedError("the picture must be PNG, JPEG or WebP", 415);
  }
  if (width < 16 || height < 16) throw new AvatarRejectedError("the picture must be at least 16×16 pixels");
  const bytes = await sharp(input, { limitInputPixels: 40_000_000, animated: false })
    .rotate() // apply the EXIF orientation before the metadata is dropped
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "centre" })
    .webp({ quality: 86 })
    .toBuffer();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256, key: `${prefix}/${sha256.slice(0, 16)}.webp` };
}

export interface AvatarStorage {
  /** Stores the object (upsert) and returns its public URL. */
  put(key: string, bytes: Buffer, contentType: string): Promise<string>;
  /** Best effort: removes an older object of the same wallet. */
  remove(key: string): Promise<void>;
}

/** Supabase Storage over its REST API, with the service-role key (server side only). */
export class SupabaseAvatarStorage implements AvatarStorage {
  private bucketReady: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly serviceRoleKey: string,
    private readonly bucket: string = AVATAR_BUCKET,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.serviceRoleKey}`, apikey: this.serviceRoleKey, ...extra };
  }

  /** Creates the public bucket once per process when it is absent (idempotent). */
  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      const got = await this.fetchFn(`${this.url}/storage/v1/bucket/${this.bucket}`, { headers: this.headers() });
      if (got.ok) return;
      const made = await this.fetchFn(`${this.url}/storage/v1/bucket`, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ id: this.bucket, name: this.bucket, public: true, file_size_limit: AVATAR_MAX_BYTES, allowed_mime_types: [...AVATAR_MIME_TYPES] }),
      });
      if (!made.ok && made.status !== 409) throw new Error(`storage: cannot create bucket ${this.bucket} (HTTP ${made.status})`);
    })().catch((e: unknown) => {
      this.bucketReady = null;
      throw e;
    });
    return this.bucketReady;
  }

  publicUrl(key: string): string {
    return `${this.url}/storage/v1/object/public/${this.bucket}/${key}`;
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<string> {
    await this.ensureBucket();
    const res = await this.fetchFn(`${this.url}/storage/v1/object/${this.bucket}/${key}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": contentType, "x-upsert": "true", "Cache-Control": "max-age=31536000" }),
      body: new Uint8Array(bytes),
    });
    if (!res.ok) throw new Error(`storage: upload failed (HTTP ${res.status})`);
    return this.publicUrl(key);
  }

  async remove(key: string): Promise<void> {
    await this.fetchFn(`${this.url}/storage/v1/object/${this.bucket}`, {
      method: "DELETE",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prefixes: [key] }),
    }).catch(() => undefined);
  }
}

/** In-memory storage for tests. */
export class FakeAvatarStorage implements AvatarStorage {
  objects = new Map<string, { bytes: Buffer; contentType: string }>();
  async put(key: string, bytes: Buffer, contentType: string): Promise<string> {
    this.objects.set(key, { bytes, contentType });
    return `https://storage.test/avatars/${key}`;
  }
  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

/** The configured storage, or null when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. */
export function avatarStorageFromEnv(env: NodeJS.ProcessEnv = process.env): AvatarStorage | null {
  const url = (env.SUPABASE_URL ?? "").trim().replace(/\/$/, "");
  const key = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!url || !key) return null;
  return new SupabaseAvatarStorage(url, key);
}

/** Hosts an admin may import a seed picture from (no open fetch: SSRF). */
export const AVATAR_IMPORT_HOSTS = ["brand.devfellowship.com", "github.com", "avatars.githubusercontent.com"];

/** Downloads a seed picture from an allow-listed https host (follows GitHub's redirect to its CDN). */
export async function fetchAvatarSource(sourceUrl: string, fetchFn: typeof fetch = fetch): Promise<Buffer> {
  let url = new URL(sourceUrl);
  for (let hop = 0; hop < 3; hop++) {
    if (url.protocol !== "https:" || !AVATAR_IMPORT_HOSTS.includes(url.hostname)) {
      throw new AvatarRejectedError(`the source host must be one of: ${AVATAR_IMPORT_HOSTS.join(", ")}`);
    }
    const res = await fetchFn(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (!res.ok) throw new AvatarRejectedError(`the source answered HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > AVATAR_MAX_BYTES) throw new AvatarRejectedError("the source is larger than 2 MB", 413);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > AVATAR_MAX_BYTES) throw new AvatarRejectedError("the source is larger than 2 MB", 413);
    return buf;
  }
  throw new AvatarRejectedError("too many redirects");
}

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAvatarStorage, fetchAvatarSource, processAvatar } from "../domain/avatar.js";
import { FakeCatalogStore } from "../domain/catalog-store.js";
import { issueSessionToken } from "./auth.js";
import { createCatalogRouter } from "./catalog-router.js";
import { collectWallets, enrichWithProfiles, profileEnrichment } from "./profile-enrich.js";
import { createProfileRouter } from "./profile-router.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ME = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ADMIN = "HhTf16UWj1Tku3GEt19EViXiyC9cRVTg7weSeGdHZVUS";

const png = (w = 400, h = 300, r = 20) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r, g: 120, b: 200 } } })
    .png()
    .toBuffer();

let server: Server;
let base: string;
let store: FakeCatalogStore;
let storage: FakeAvatarStorage;
let sourceFetch: typeof fetch;

const auth = (w: string) => ({ Authorization: `Bearer ${issueSessionToken(w).token}` });

async function upload(bytes: Buffer, type = "image/png", wallet = ME) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type }), "me.png");
  const res = await fetch(`${base}/me/avatar`, { method: "POST", headers: auth(wallet), body: form });
  return { status: res.status, body: (await res.json()) as any };
}

beforeEach(async () => {
  store = new FakeCatalogStore();
  storage = new FakeAvatarStorage();
  sourceFetch = (async () => new Response(new Uint8Array(await png(180, 180)), { status: 200 })) as typeof fetch;
  const app = express();
  app.use(express.json());
  app.use(profileEnrichment((w) => store.listProfiles(w)));
  app.use(createCatalogRouter(store));
  app.use(createProfileRouter({ store, storage, adminWallets: () => [ADMIN], fetchFn: (...a) => sourceFetch(...a) }));
  app.get("/rows", (_req, res) => {
    res.json({ rows: [{ id: "a", authorName: "D0ingC0des", authorWallet: ME }, { id: "b", ownerWallet: OTHER }], owner: { wallet: ME, displayName: null, handle: null } });
  });
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe("processAvatar", () => {
  it("crops to 256×256 WebP and strips metadata", async () => {
    const withExif = await sharp(await png(500, 200)).withMetadata({ exif: { IFD0: { Copyright: "secret" } } }).jpeg().toBuffer();
    const out = await processAvatar(ME, withExif);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect([meta.width, meta.height]).toEqual([256, 256]);
    expect(meta.exif).toBeUndefined();
    expect(out.key).toMatch(new RegExp(`^${ME}/[0-9a-f]{16}\\.webp$`));
  });

  it("rejects a non-image, a GIF and an oversize file", async () => {
    await expect(processAvatar(ME, Buffer.from("not an image"))).rejects.toMatchObject({ status: 415 });
    const gif = await sharp(await png(40, 40)).gif().toBuffer();
    await expect(processAvatar(ME, gif)).rejects.toMatchObject({ status: 415 });
    await expect(processAvatar(ME, Buffer.alloc(2 * 1024 * 1024 + 1))).rejects.toMatchObject({ status: 413 });
  });
});

describe("POST /me/avatar", () => {
  it("needs a session", async () => {
    const res = await fetch(`${base}/me/avatar`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("stores the picture and GET /me shows it; a new upload replaces the old object", async () => {
    const first = await upload(await png());
    expect(first.status).toBe(201);
    expect(first.body.avatarUrl).toMatch(/^https:\/\/storage\.test\/avatars\//);
    expect(storage.objects.size).toBe(1);
    const me = (await (await fetch(`${base}/me`, { headers: auth(ME) })).json()) as any;
    expect(me.avatarUrl).toBe(first.body.avatarUrl);
    const second = await upload(await png(300, 300, 220));
    expect(second.body.avatarUrl).not.toBe(first.body.avatarUrl);
    expect(storage.objects.size).toBe(1);
    const del = await fetch(`${base}/me/avatar`, { method: "DELETE", headers: auth(ME) });
    expect(((await del.json()) as any).avatarUrl).toBeNull();
    expect(storage.objects.size).toBe(0);
  });

  it("rejects a wrong type, an oversize file and a non-multipart body", async () => {
    expect((await upload(Buffer.from("GIF89a"), "image/gif")).status).toBe(415);
    expect((await upload(Buffer.from("plain"), "image/png")).status).toBe(415);
    expect((await upload(Buffer.alloc(2 * 1024 * 1024 + 10, 1))).status).toBe(413);
    const res = await fetch(`${base}/me/avatar`, { method: "POST", headers: { ...auth(ME), "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(415);
  });
});

describe("PUT /admin/profiles/:wallet", () => {
  const put = async (wallet: string, body: unknown, as = ADMIN) => {
    const res = await fetch(`${base}/admin/profiles/${wallet}`, { method: "PUT", headers: { ...auth(as), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };

  it("is admin only", async () => {
    expect((await put(OTHER, { username: "x_y_z" }, ME)).status).toBe(403);
  });

  it("seeds username, display name and a copied picture", async () => {
    const r = await put(OTHER, { username: "devfellowship", displayName: "DevFellowship", avatarSourceUrl: "https://brand.devfellowship.com/downloads/dfl/dfl-icon-180.png" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ username: "devfellowship", displayName: "DevFellowship" });
    expect(r.body.avatarUrl).toMatch(/^https:\/\/storage\.test\/avatars\//);
  });

  it("refuses a source host off the allow-list", async () => {
    expect((await put(OTHER, { avatarSourceUrl: "https://example.com/a.png" })).status).toBe(400);
    expect((await put(OTHER, { avatarSourceUrl: "http://brand.devfellowship.com/a.png" })).status).toBe(400);
  });
});

describe("profile enrichment", () => {
  it("adds <x>Profile next to wallet fields and fills profile-shaped objects", async () => {
    await store.upsertProfile(ME, { handle: "will", avatarUrl: "https://s.test/a.webp" });
    const body = (await (await fetch(`${base}/rows`)).json()) as any;
    expect(body.rows[0].authorProfile).toEqual({ wallet: ME, username: "will", displayName: null, avatarUrl: "https://s.test/a.webp" });
    expect(body.rows[0].authorName).toBe("@will");
    expect(body.rows[1].ownerProfile).toBeUndefined();
    expect(body.owner).toMatchObject({ username: "will", avatarUrl: "https://s.test/a.webp" });
  });

  it("collects wallets at any depth and skips non-addresses", () => {
    const body = { a: [{ ownerWallet: ME }, { wallet: "not-a-wallet" }], b: { c: { owner_wallet: OTHER } } };
    expect(collectWallets(body).sort()).toEqual([ME, OTHER].sort());
    enrichWithProfiles(body, new Map([[OTHER, { wallet: OTHER, username: "o", displayName: null, avatarUrl: null }]]));
    expect((body.b.c as any).owner_profile.username).toBe("o");
  });
});

describe("fetchAvatarSource", () => {
  it("follows a redirect only to an allow-listed host", async () => {
    const hops: string[] = [];
    const f = (async (u: URL | string) => {
      const url = String(u);
      hops.push(url);
      if (url.startsWith("https://github.com/")) return new Response(null, { status: 302, headers: { location: "https://evil.test/x.png" } });
      return new Response("x");
    }) as typeof fetch;
    await expect(fetchAvatarSource("https://github.com/D0ingC0des.png", f)).rejects.toMatchObject({ status: 400 });
    expect(hops).toEqual(["https://github.com/D0ingC0des.png"]);
  });
});

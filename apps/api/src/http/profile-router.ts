import { isAddress } from "@solana/kit";
import Busboy from "busboy";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import {
  AVATAR_MAX_BYTES,
  AVATAR_MIME_TYPES,
  AvatarRejectedError,
  fetchAvatarSource,
  processAvatar,
  type AvatarStorage,
} from "../domain/avatar.js";
import { isUuid, type AgentAvatarStore } from "../domain/agent-avatar-store.js";
import { HandleTakenError, type CatalogStore, type ProfilePatch } from "../domain/catalog-store.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { requireWallet } from "./auth.js";
import { profileJson, usernameProblem } from "./catalog-router.js";

/**
 * Profile pictures (U36, plan 20261012-itera-testmyagent-ui-refactor). Needs 0015_profile_avatars.sql.
 *
 *   POST /me/avatar   multipart/form-data, one file field (png | jpeg | webp, ≤ 2 MB)      wallet
 *   DELETE /me/avatar                                                                    wallet
 *   PUT  /admin/profiles/:wallet {username?, displayName?, avatarSourceUrl?}  wallet in ITERA_ADMIN_WALLETS
 *   POST /agents/:id/avatar · DELETE /agents/:id/avatar        (agent owner; same pipeline, key agents/<id>/…)
 *   PUT  /admin/agents/:id/avatar {avatarSourceUrl}                          wallet in ITERA_ADMIN_WALLETS
 *
 * The upload is decoded, cropped to a centered square, resized to 256×256 WebP without metadata
 * (domain/avatar.ts) and stored in the public `avatars` bucket. The answer is the GET /me body.
 * The admin route seeds the profiles of platform-owned and invited wallets (data, not schema): it
 * copies the picture from an allow-listed host into the bucket, never hotlinks it.
 */

export interface ProfileRouterDeps {
  store: CatalogStore;
  /** Null → 503 on the upload routes (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set). */
  storage: AvatarStorage | null;
  adminWallets?: () => string[];
  fetchFn?: typeof fetch;
  /** Agent pictures. Absent → the agent routes are not mounted. */
  agents?: AgentAvatarStore;
}

const envAdminWallets = () =>
  (process.env.ITERA_ADMIN_WALLETS ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((e: unknown) => {
      if (e instanceof SchemaNotReadyError) {
        res.status(503).json({ error: e.message });
        return;
      }
      if (e instanceof AvatarRejectedError) {
        res.status(e.status).json({ error: e.message });
        return;
      }
      if (e instanceof HandleTakenError) {
        res.status(409).json({ error: `username "${e.handle}" is taken` });
        return;
      }
      next(e);
    });
  };

/** Reads the first file part of a multipart body into memory, at most AVATAR_MAX_BYTES. */
function readUpload(req: Request): Promise<{ bytes: Buffer; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const type = req.headers["content-type"] ?? "";
    if (!type.toLowerCase().startsWith("multipart/form-data")) {
      reject(new AvatarRejectedError("send the picture as multipart/form-data (field: file)", 415));
      return;
    }
    let bb: ReturnType<typeof Busboy>;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: AVATAR_MAX_BYTES, fields: 4, parts: 6 } });
    } catch {
      reject(new AvatarRejectedError("malformed multipart body"));
      return;
    }
    let got: { bytes: Buffer; mimeType: string } | null = null;
    let failure: Error | null = null;
    bb.on("file", (_name, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("limit", () => {
        failure = new AvatarRejectedError("the file is larger than 2 MB", 413);
      });
      stream.on("end", () => {
        if (!got && !failure) got = { bytes: Buffer.concat(chunks), mimeType: info.mimeType };
      });
    });
    bb.on("error", () => reject(new AvatarRejectedError("malformed multipart body")));
    bb.on("close", () => {
      if (failure) reject(failure);
      else if (!got) reject(new AvatarRejectedError("no file in the body (field: file)"));
      else resolve(got);
    });
    req.pipe(bb);
  });
}

export function createProfileRouter(deps: ProfileRouterDeps): Router {
  const router = Router();
  const adminWallets = deps.adminWallets ?? envAdminWallets;
  const { store } = deps;

  async function storePicture(wallet: string, input: Buffer): Promise<ProfilePatch> {
    if (!deps.storage) throw new Error("storage missing");
    const pic = await processAvatar(wallet, input);
    const url = await deps.storage.put(pic.key, pic.bytes, "image/webp");
    return { avatarUrl: url, avatarKey: pic.key };
  }

  async function dropOld(oldKey: string | null, newKey: string | null | undefined) {
    if (deps.storage && oldKey && oldKey !== newKey) await deps.storage.remove(oldKey);
  }

  router.post(
    "/me/avatar",
    requireWallet,
    wrap(async (req, res) => {
      if (!deps.storage) {
        res.status(503).json({ error: "picture storage is not configured on this server" });
        return;
      }
      const wallet = req.wallet!;
      const upload = await readUpload(req);
      if (upload.mimeType && !(AVATAR_MIME_TYPES as readonly string[]).includes(upload.mimeType.toLowerCase())) {
        throw new AvatarRejectedError("the picture must be PNG, JPEG or WebP", 415);
      }
      const before = await store.getProfile(wallet);
      const patch = await storePicture(wallet, upload.bytes);
      const after = await store.upsertProfile(wallet, patch);
      await dropOld(before?.avatarKey ?? null, after.avatarKey);
      res.status(201).json(profileJson(wallet, after));
    }),
  );

  router.delete(
    "/me/avatar",
    requireWallet,
    wrap(async (req, res) => {
      const wallet = req.wallet!;
      const before = await store.getProfile(wallet);
      const after = await store.upsertProfile(wallet, { avatarUrl: null, avatarKey: null });
      await dropOld(before?.avatarKey ?? null, null);
      res.json(profileJson(wallet, after));
    }),
  );

  router.put(
    "/admin/profiles/:wallet",
    requireWallet,
    wrap(async (req, res) => {
      if (!adminWallets().includes(req.wallet!)) {
        res.status(403).json({ error: "admin only" });
        return;
      }
      const wallet = String(req.params.wallet);
      if (!isAddress(wallet)) {
        res.status(400).json({ error: "wallet must be a base58 Solana address" });
        return;
      }
      const body = (req.body ?? {}) as { username?: unknown; displayName?: unknown; avatarSourceUrl?: unknown };
      const patch: ProfilePatch = {};
      if (typeof body.username === "string") {
        const u = body.username.trim().toLowerCase();
        const problem = usernameProblem(u);
        // An admin seed may take a reserved platform name (the DFL-owned profile), never a malformed one.
        if (problem && !problem.endsWith("is reserved")) {
          res.status(400).json({ error: problem });
          return;
        }
        patch.handle = u;
      }
      if (typeof body.displayName === "string" && body.displayName.trim().length >= 1 && body.displayName.trim().length <= 60) {
        patch.displayName = body.displayName.trim();
      }
      if (typeof body.avatarSourceUrl === "string") {
        if (!deps.storage) {
          res.status(503).json({ error: "picture storage is not configured on this server" });
          return;
        }
        const src = await fetchAvatarSource(body.avatarSourceUrl, deps.fetchFn);
        Object.assign(patch, await storePicture(wallet, src));
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: "nothing to update: send username, displayName and/or avatarSourceUrl" });
        return;
      }
      const before = await store.getProfile(wallet);
      const after = await store.upsertProfile(wallet, patch);
      await dropOld(before?.avatarKey ?? null, after.avatarKey);
      res.json(profileJson(wallet, after));
    }),
  );

  // ---------------------------------------------------------------------------------------------
  // Agent pictures (Tainan TG 21086)
  const agents = deps.agents;
  if (agents) {
    const ownedAgent = async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const a = isUuid(id) ? await agents.getAgent(id) : null;
      // Another wallet's agent answers 404 as an absent one does (no existence hint).
      if (!a || a.ownerWallet !== req.wallet) {
        res.status(404).json({ error: "agent not found" });
        return null;
      }
      return { id, ...a };
    };
    const putAgentPicture = async (id: string, oldKey: string | null, input: Buffer) => {
      if (!deps.storage) throw new Error("storage missing");
      const pic = await processAvatar(`agents/${id}`, input);
      const url = await deps.storage.put(pic.key, pic.bytes, "image/webp");
      await agents.setAvatar(id, url, pic.key);
      await dropOld(oldKey, pic.key);
      return { agentId: id, avatarUrl: url };
    };

    router.patch(
      "/agents/:id/profile",
      requireWallet,
      wrap(async (req, res) => {
        const a = await ownedAgent(req, res);
        if (!a) return;
        const raw = (req.body ?? {}) as { name?: unknown };
        const name = typeof raw.name === "string" ? raw.name.trim() : "";
        if (name.length < 2 || name.length > 80) {
          res.status(400).json({ error: "agent name must be between 2 and 80 characters" });
          return;
        }
        await agents.setName(a.id, name);
        res.json({ agentId: a.id, name });
      }),
    );

    router.post(
      "/agents/:id/avatar",
      requireWallet,
      wrap(async (req, res) => {
        if (!deps.storage) {
          res.status(503).json({ error: "picture storage is not configured on this server" });
          return;
        }
        const a = await ownedAgent(req, res);
        if (!a) return;
        const upload = await readUpload(req);
        if (upload.mimeType && !(AVATAR_MIME_TYPES as readonly string[]).includes(upload.mimeType.toLowerCase())) {
          throw new AvatarRejectedError("the picture must be PNG, JPEG or WebP", 415);
        }
        res.status(201).json(await putAgentPicture(a.id, a.avatarKey, upload.bytes));
      }),
    );

    router.delete(
      "/agents/:id/avatar",
      requireWallet,
      wrap(async (req, res) => {
        const a = await ownedAgent(req, res);
        if (!a) return;
        await agents.setAvatar(a.id, null, null);
        await dropOld(a.avatarKey, null);
        res.json({ agentId: a.id, avatarUrl: null });
      }),
    );

    router.put(
      "/admin/agents/:id/avatar",
      requireWallet,
      wrap(async (req, res) => {
        if (!adminWallets().includes(req.wallet!)) {
          res.status(403).json({ error: "admin only" });
          return;
        }
        if (!deps.storage) {
          res.status(503).json({ error: "picture storage is not configured on this server" });
          return;
        }
        const id = String(req.params.id);
        const a = isUuid(id) ? await agents.getAgent(id) : null;
        if (!a) {
          res.status(404).json({ error: "agent not found" });
          return;
        }
        const src = (req.body ?? {}) as { avatarSourceUrl?: unknown };
        if (typeof src.avatarSourceUrl !== "string") {
          res.status(400).json({ error: "avatarSourceUrl is required" });
          return;
        }
        res.json(await putAgentPicture(id, a.avatarKey, await fetchAvatarSource(src.avatarSourceUrl, deps.fetchFn)));
      }),
    );
  }

  return router;
}

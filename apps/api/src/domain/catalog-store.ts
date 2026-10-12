/**
 * Catalog store (U5, plan 20261012-itera-testmyagent-ui-refactor): tasks, tags, models, profiles.
 * Tables: db/migrations/0007_catalog.sql. The router filters in TypeScript (the catalog is small);
 * the store only returns what the caller may see.
 */

import type { ModelsSyncStore, SyncedModel } from "./models-sync.js";

export const CATALOG_MIGRATION = "0007_catalog.sql";

export type TagKind = "tool" | "concept";
export type TaskKind = "itera" | "user";
export type TaskVisibility = "public" | "private";
export type TaskStatus = "draft" | "validating" | "ready" | "invalid";
export type TaskSource = "curated" | "github";

export interface Tag {
  id: string;
  name: string;
  kind: TagKind;
  sort: number;
}

export interface TaskVersionInfo {
  id: string;
  version: number;
  source: TaskSource;
  labels: string[];
  runnable: boolean;
  hiddenTestsCount: number | null;
  /** curated */
  packId: string | null;
  packVersion: string | null;
  /** github (Gate Q4: pinned commit through the GitHub App). */
  installationId: number | null;
  repoFullName: string | null;
  branch: string | null;
  commitSha: string | null;
  repoPath: string | null;
  fixtureDigest: string | null;
  hiddenDigest: string | null;
  validatedAt: string | null;
  createdAt: string;
}

export interface CatalogTask {
  id: string;
  slug: string;
  kind: TaskKind;
  ownerWallet: string | null;
  name: string;
  description: string;
  visibility: TaskVisibility;
  status: TaskStatus;
  estMinutes: number | null;
  tags: Tag[];
  /** Latest version, or null for a task with no version yet (a fresh draft). */
  latest: TaskVersionInfo | null;
  /** Distinct agents with at least one run on this task. */
  agentsRunCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModelRelease {
  id: string;
  releasedAt: string | null;
  isLatest: boolean;
}

export interface CatalogModel {
  id: string;
  label: string;
  provider: string;
  contextLength: number | null;
  promptPriceUsdPerM: number | null;
  completionPriceUsdPerM: number | null;
  supportsTools: boolean;
  /** ITERA allow-list (ITERA pays the tokens, Gate Q2). */
  enabled: boolean;
  sort: number;
  openrouterCreatedAt: string | null;
  syncedAt: string | null;
  releases: ModelRelease[];
}

export interface Profile {
  wallet: string;
  displayName: string | null;
  handle: string | null;
  /** U36 (0015): public URL of the 256×256 picture in the `avatars` bucket, or null. */
  avatarUrl: string | null;
  /** U36 (0015): storage object key of the picture (`<wallet>/<hash16>.webp`), or null. */
  avatarKey: string | null;
  /** U36 (0015): one optional line, ≤ 80 characters. */
  bio: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Fields of a profile update: undefined = keep, null = clear. */
export interface ProfilePatch {
  displayName?: string | null;
  handle?: string | null;
  avatarUrl?: string | null;
  avatarKey?: string | null;
  bio?: string | null;
}

/** U36: the public page /u/:username. Only listed agents and public tasks. */
export interface PublicUserPage {
  profile: Profile;
  agents: Array<{ id: string; slug: string | null; name: string; description: string | null; avatarUrl: string | null; createdAt: string | null }>;
  tasks: Array<{ id: string; slug: string; name: string; description: string | null }>;
}

export class HandleTakenError extends Error {
  constructor(public readonly handle: string) {
    super(`handle "${handle}" is taken`);
  }
}

export interface CatalogStore extends ModelsSyncStore {
  /** Every public task plus the caller's own tasks (never another wallet's private task). */
  listVisibleTasks(wallet: string | null): Promise<CatalogTask[]>;
  /** By uuid or slug; null when absent or not visible to the caller. */
  getVisibleTask(idOrSlug: string, wallet: string | null): Promise<CatalogTask | null>;
  listTags(): Promise<Tag[]>;
  listModels(): Promise<CatalogModel[]>;
  /** Access check (Gate Q2: ITERA pays): true = on the allow-list, false = known but disabled,
   * null = unknown model id. */
  isModelEnabled(id: string): Promise<boolean | null>;
  getProfile(wallet: string): Promise<Profile | null>;
  /** Upserts the provided fields (undefined = keep, null = clear). Throws HandleTakenError. */
  upsertProfile(wallet: string, patch: ProfilePatch): Promise<Profile>;
  /** U36: the profiles of these wallets (absent wallets are left out). One query. */
  listProfiles(wallets: string[]): Promise<Profile[]>;
  /** U36: by username (lowercase); null when absent. */
  getProfileByUsername(username: string): Promise<Profile | null>;
  /** U36: how many agents and tasks the wallet owns (all visibilities: it is the owner's own view). */
  profileStats(wallet: string): Promise<{ agents: number; tasks: number }>;
  /** U36: the public page of a username; null when no profile has it. */
  publicUser(username: string): Promise<PublicUserPage | null>;
}

export function isVisibleTo(task: Pick<CatalogTask, "visibility" | "ownerWallet">, wallet: string | null): boolean {
  return task.visibility === "public" || (wallet !== null && task.ownerWallet === wallet);
}

// ---------------------------------------------------------------------------------------------
// In-memory implementation for tests and for local development without Postgres.

export class FakeCatalogStore implements CatalogStore {
  tasks: CatalogTask[] = [];
  tags: Tag[] = [];
  models: CatalogModel[] = [];
  profiles = new Map<string, Profile>();

  async listVisibleTasks(wallet: string | null): Promise<CatalogTask[]> {
    return this.tasks.filter((t) => isVisibleTo(t, wallet));
  }

  async getVisibleTask(idOrSlug: string, wallet: string | null): Promise<CatalogTask | null> {
    const t = this.tasks.find((x) => x.id === idOrSlug || x.slug === idOrSlug);
    return t && isVisibleTo(t, wallet) ? t : null;
  }

  async listTags(): Promise<Tag[]> {
    return [...this.tags];
  }

  async listModels(): Promise<CatalogModel[]> {
    return [...this.models];
  }

  async isModelEnabled(id: string): Promise<boolean | null> {
    const m = this.models.find((x) => x.id === id);
    return m ? m.enabled : null;
  }

  async applyModelsSync(models: SyncedModel[], syncedAt: string) {
    let inserted = 0;
    let updated = 0;
    let newReleases = 0;
    for (const s of models) {
      let m = this.models.find((x) => x.id === s.id);
      if (!m) {
        m = { id: s.id, label: s.label, provider: s.provider, contextLength: null, promptPriceUsdPerM: null, completionPriceUsdPerM: null, supportsTools: true, enabled: false, sort: 100, openrouterCreatedAt: null, syncedAt: null, releases: [] };
        this.models.push(m);
        inserted += 1;
      } else updated += 1;
      Object.assign(m, {
        provider: s.provider,
        contextLength: s.contextLength,
        promptPriceUsdPerM: s.promptPriceUsdPerM,
        completionPriceUsdPerM: s.completionPriceUsdPerM,
        supportsTools: s.supportsTools,
        openrouterCreatedAt: s.createdAt,
        syncedAt,
      });
      if (s.release.id !== m.id) m.releases = m.releases.filter((r) => r.id !== m!.id);
      if (!m.releases.some((r) => r.id === s.release.id)) {
        newReleases += 1;
        m.releases.push({ id: s.release.id, releasedAt: s.release.releasedAt, isLatest: false });
      }
      m.releases = m.releases.map((r) => ({ ...r, isLatest: r.id === s.release.id }));
    }
    return { inserted, updated, newReleases };
  }

  async getProfile(wallet: string): Promise<Profile | null> {
    return this.profiles.get(wallet) ?? null;
  }

  async listProfiles(wallets: string[]): Promise<Profile[]> {
    return wallets.map((w) => this.profiles.get(w)).filter((p): p is Profile => p !== undefined);
  }

  async getProfileByUsername(username: string): Promise<Profile | null> {
    return [...this.profiles.values()].find((p) => p.handle === username) ?? null;
  }

  async profileStats(wallet: string): Promise<{ agents: number; tasks: number }> {
    return { agents: 0, tasks: this.tasks.filter((t) => t.ownerWallet === wallet).length };
  }

  async publicUser(username: string): Promise<PublicUserPage | null> {
    const profile = await this.getProfileByUsername(username);
    if (!profile) return null;
    const tasks = this.tasks.filter((t) => t.ownerWallet === profile.wallet && t.visibility === "public").map((t) => ({ id: t.id, slug: t.slug, name: t.name, description: t.description }));
    return { profile, agents: [], tasks };
  }

  async upsertProfile(wallet: string, patch: ProfilePatch): Promise<Profile> {
    if (patch.handle) {
      for (const p of this.profiles.values()) {
        if (p.wallet !== wallet && p.handle === patch.handle) throw new HandleTakenError(patch.handle);
      }
    }
    const now = new Date().toISOString();
    const prev = this.profiles.get(wallet) ?? { wallet, displayName: null, handle: null, avatarUrl: null, avatarKey: null, bio: null, createdAt: now, updatedAt: now };
    const next: Profile = {
      ...prev,
      displayName: patch.displayName === undefined ? prev.displayName : patch.displayName,
      handle: patch.handle === undefined ? prev.handle : patch.handle,
      avatarUrl: patch.avatarUrl === undefined ? prev.avatarUrl : patch.avatarUrl,
      avatarKey: patch.avatarKey === undefined ? prev.avatarKey : patch.avatarKey,
      bio: patch.bio === undefined ? prev.bio : patch.bio,
      updatedAt: now,
    };
    this.profiles.set(wallet, next);
    return next;
  }
}

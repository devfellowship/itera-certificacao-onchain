/**
 * Catalog store (U5, plan 20261012-itera-testmyagent-ui-refactor): tasks, tags, models, profiles.
 * Tables: db/migrations/0007_catalog.sql. The router filters in TypeScript (the catalog is small);
 * the store only returns what the caller may see.
 */

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
  createdAt: string | null;
  updatedAt: string | null;
}

export class HandleTakenError extends Error {
  constructor(public readonly handle: string) {
    super(`handle "${handle}" is taken`);
  }
}

export interface CatalogStore {
  /** Every public task plus the caller's own tasks (never another wallet's private task). */
  listVisibleTasks(wallet: string | null): Promise<CatalogTask[]>;
  /** By uuid or slug; null when absent or not visible to the caller. */
  getVisibleTask(idOrSlug: string, wallet: string | null): Promise<CatalogTask | null>;
  listTags(): Promise<Tag[]>;
  listModels(): Promise<CatalogModel[]>;
  getProfile(wallet: string): Promise<Profile | null>;
  /** Upserts the provided fields (undefined = keep, null = clear). Throws HandleTakenError. */
  upsertProfile(wallet: string, patch: { displayName?: string | null; handle?: string | null }): Promise<Profile>;
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

  async getProfile(wallet: string): Promise<Profile | null> {
    return this.profiles.get(wallet) ?? null;
  }

  async upsertProfile(wallet: string, patch: { displayName?: string | null; handle?: string | null }): Promise<Profile> {
    if (patch.handle) {
      for (const p of this.profiles.values()) {
        if (p.wallet !== wallet && p.handle === patch.handle) throw new HandleTakenError(patch.handle);
      }
    }
    const now = new Date().toISOString();
    const prev = this.profiles.get(wallet) ?? { wallet, displayName: null, handle: null, createdAt: now, updatedAt: now };
    const next: Profile = {
      ...prev,
      displayName: patch.displayName === undefined ? prev.displayName : patch.displayName,
      handle: patch.handle === undefined ? prev.handle : patch.handle,
      updatedAt: now,
    };
    this.profiles.set(wallet, next);
    return next;
  }
}

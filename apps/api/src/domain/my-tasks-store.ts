/**
 * Storage seam for My tasks (U19, plan 20261012-itera-testmyagent-ui-refactor). Tables: tasks,
 * task_versions, task_tags (0007_catalog) and task_validations + tasks.deleted_at +
 * task_versions.repo_private (0009_user_tasks). A user task is `kind = 'user'`, private, owned by one
 * wallet. A version is immutable: a new pinned commit is a new version. No task bytes are stored
 * (Gate Q5): only the pin, the contract and, after the gate, the digests.
 */
import { randomUUID } from "node:crypto";
import type { TaskContract } from "@itera/contracts";
import type { TaskStatus } from "./catalog-store.js";

export const MY_TASKS_MIGRATION = "0009_user_tasks.sql";

export interface UserTask {
  id: string;
  slug: string;
  ownerWallet: string;
  name: string;
  description: string;
  status: TaskStatus;
  estMinutes: number | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NewTaskVersion {
  installationId: number;
  repoFullName: string;
  branch: string;
  commitSha: string;
  repoPath: string;
  repoPrivate: boolean;
  labels: string[];
  contract: TaskContract;
  createdBy: string;
}

export interface UserTaskVersion extends NewTaskVersion {
  id: string;
  taskId: string;
  version: number;
  runnable: boolean;
  validation: unknown;
  validatedAt: string | null;
  fixtureDigest: string | null;
  hiddenDigest: string | null;
  solutionDigest: string | null;
  hiddenTestsCount: number | null;
  packId: string | null;
  createdAt: string;
}

export type ValidationStatus = "queued" | "running" | "ready" | "invalid" | "error";

export interface TaskValidation {
  id: string;
  taskId: string;
  taskVersionId: string;
  status: ValidationStatus;
  repeats: number;
  result: unknown;
  error: string | null;
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}

export interface MyTasksStore {
  createTask(input: {
    ownerWallet: string;
    slug: string;
    name: string;
    description: string;
    estMinutes: number | null;
    tags: string[];
    version: NewTaskVersion;
  }): Promise<{ task: UserTask; version: UserTaskVersion }>;
  /** A user task of this wallet that is not deleted; null otherwise (another wallet's task is null too). */
  getOwnedTask(id: string, wallet: string): Promise<UserTask | null>;
  /** Newest first. */
  listVersions(taskId: string): Promise<UserTaskVersion[]>;
  getVersion(taskId: string, version: number): Promise<UserTaskVersion | null>;
  /** Next version number; the task goes back to `draft`. */
  addVersion(taskId: string, v: NewTaskVersion): Promise<UserTaskVersion>;
  updateTask(id: string, patch: { name?: string; description?: string; estMinutes?: number | null; tags?: string[] }): Promise<UserTask>;
  softDelete(id: string): Promise<void>;
  /** Queues a gate run; an open (queued/running) one for the same version is returned instead. */
  enqueueValidation(input: { taskId: string; taskVersionId: string; requestedBy: string; repeats: number }): Promise<{ validation: TaskValidation; created: boolean }>;
  getValidation(id: string): Promise<TaskValidation | null>;
  latestValidation(taskVersionId: string): Promise<TaskValidation | null>;
}

/** The runner's pack id for a validated user version (0009 header). */
export const userPackId = (taskVersionId: string) => `user-${taskVersionId}`;

// ---------------------------------------------------------------------------------------------
// In-memory implementation for tests.

export class FakeMyTasksStore implements MyTasksStore {
  tasks: (UserTask & { deletedAt: string | null })[] = [];
  versions: UserTaskVersion[] = [];
  validations: TaskValidation[] = [];

  async createTask(input: Parameters<MyTasksStore["createTask"]>[0]) {
    const now = new Date().toISOString();
    const task = { id: randomUUID(), slug: input.slug, ownerWallet: input.ownerWallet, name: input.name, description: input.description, status: "draft" as const, estMinutes: input.estMinutes, tags: input.tags, createdAt: now, updatedAt: now, deletedAt: null };
    this.tasks.push(task);
    const version = this.newVersion(task.id, 1, input.version);
    return { task: this.view(task), version };
  }

  private view(t: UserTask & { deletedAt: string | null }): UserTask {
    const { deletedAt: _d, ...rest } = t;
    return { ...rest, tags: [...rest.tags] };
  }

  private newVersion(taskId: string, version: number, v: NewTaskVersion): UserTaskVersion {
    const row: UserTaskVersion = { ...v, id: randomUUID(), taskId, version, runnable: false, validation: null, validatedAt: null, fixtureDigest: null, hiddenDigest: null, solutionDigest: null, hiddenTestsCount: null, packId: null, createdAt: new Date().toISOString() };
    this.versions.push(row);
    return row;
  }

  async getOwnedTask(id: string, wallet: string) {
    const t = this.tasks.find((x) => x.id === id && x.ownerWallet === wallet && x.deletedAt === null);
    return t ? this.view(t) : null;
  }

  async listVersions(taskId: string) {
    return this.versions.filter((v) => v.taskId === taskId).sort((a, b) => b.version - a.version);
  }

  async getVersion(taskId: string, version: number) {
    return this.versions.find((v) => v.taskId === taskId && v.version === version) ?? null;
  }

  async addVersion(taskId: string, v: NewTaskVersion) {
    const next = Math.max(0, ...this.versions.filter((x) => x.taskId === taskId).map((x) => x.version)) + 1;
    const t = this.tasks.find((x) => x.id === taskId)!;
    t.status = "draft";
    t.updatedAt = new Date().toISOString();
    return this.newVersion(taskId, next, v);
  }

  async updateTask(id: string, patch: { name?: string; description?: string; estMinutes?: number | null; tags?: string[] }) {
    const t = this.tasks.find((x) => x.id === id)!;
    if (patch.name !== undefined) t.name = patch.name;
    if (patch.description !== undefined) t.description = patch.description;
    if (patch.estMinutes !== undefined) t.estMinutes = patch.estMinutes;
    if (patch.tags !== undefined) t.tags = [...patch.tags];
    t.updatedAt = new Date().toISOString();
    return this.view(t);
  }

  async softDelete(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (t) t.deletedAt = new Date().toISOString();
  }

  async enqueueValidation(input: { taskId: string; taskVersionId: string; requestedBy: string; repeats: number }) {
    const open = this.validations.find((v) => v.taskVersionId === input.taskVersionId && (v.status === "queued" || v.status === "running"));
    if (open) return { validation: open, created: false };
    const validation: TaskValidation = { id: randomUUID(), taskId: input.taskId, taskVersionId: input.taskVersionId, status: "queued", repeats: input.repeats, result: null, error: null, createdAt: new Date().toISOString(), claimedAt: null, completedAt: null };
    this.validations.push(validation);
    const t = this.tasks.find((x) => x.id === input.taskId);
    if (t) t.status = "validating";
    return { validation, created: true };
  }

  async getValidation(id: string) {
    return this.validations.find((v) => v.id === id) ?? null;
  }

  async latestValidation(taskVersionId: string) {
    return [...this.validations].reverse().find((v) => v.taskVersionId === taskVersionId) ?? null;
  }
}

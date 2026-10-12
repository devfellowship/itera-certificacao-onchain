/**
 * Storage seam of the public task profile (screen /tasks/:slug, U30; plan
 * 20261012-itera-testmyagent-ui-refactor, ADR-11). Read-only. The view logic is task-profile.ts.
 *
 * Only a catalog task (kind `itera`, visibility `public`) has a public page. Anything else
 * resolves to null, so the route answers the same generic 404 and never reveals a private task.
 */
import type { PublicTag } from "./store.js";

export interface PublicTaskVersionRow {
  id: string;
  version: number;
  source: "curated" | "github";
  /** task_versions.contract: the stored task.json parts (editable paths, environment, profile, ...). */
  contract: unknown;
  labels: string[];
  hiddenTestsCount: number | null;
  runnable: boolean;
  fixtureDigest: string | null;
  hiddenDigest: string | null;
  packId: string | null;
  packVersion: string | null;
  repoFullName: string | null;
  commitSha: string | null;
  repoPath: string | null;
  createdAt: string;
}

export interface PublicTaskSource {
  task: {
    id: string;
    slug: string;
    name: string;
    description: string;
    estMinutes: number | null;
    tags: PublicTag[];
    createdAt: string;
  };
  /** Every version, newest first. */
  versions: PublicTaskVersionRow[];
}

/** One finished run on a public, issued evaluation. */
export interface TaskResultRow {
  runId: string;
  status: string;
  scoreTotal: number | null;
  startedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  agentId: string;
  agentName: string;
  agentSlug: string | null;
  modelLabel: string | null;
  evaluationSlug: string | null;
  issuedAt: string | null;
  /** task_versions.version of the run; null for a legacy run without a version. */
  taskVersion: number | null;
}

export interface PublicTaskStore {
  /** By slug or uuid; null when absent, not public, or not a catalog task. */
  loadTask(key: string): Promise<PublicTaskSource | null>;
  loadResults(taskId: string): Promise<TaskResultRow[]>;
}

/** In-memory store for tests. */
export class FakePublicTaskStore implements PublicTaskStore {
  tasks: PublicTaskSource[] = [];
  results = new Map<string, TaskResultRow[]>();

  async loadTask(key: string) {
    return this.tasks.find((t) => t.task.id === key || t.task.slug === key) ?? null;
  }

  async loadResults(taskId: string) {
    return this.results.get(taskId) ?? [];
  }
}

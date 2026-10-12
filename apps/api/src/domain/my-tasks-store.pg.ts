import type { Pool, PoolClient } from "pg";
import {
  MY_TASKS_MIGRATION,
  type MyTasksStore,
  type NewTaskVersion,
  type TaskValidation,
  type UserTask,
  type UserTaskVersion,
} from "./my-tasks-store.js";
import { SchemaNotReadyError } from "./runs-store.js";

const MISSING_SCHEMA_CODES = new Set(["42P01", "42703"]); // undefined_table, undefined_column

function rethrow(e: unknown): never {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
  if (code && MISSING_SCHEMA_CODES.has(code)) throw new SchemaNotReadyError(MY_TASKS_MIGRATION, e);
  throw e;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : d instanceof Date ? d.toISOString() : d);

const TASK_SELECT = `
  select t.id, t.slug, t.owner_wallet, t.name, t.description, t.status, t.est_minutes, t.created_at, t.updated_at,
         coalesce((select array_agg(tt.tag_id order by tt.tag_id) from public.task_tags tt where tt.task_id = t.id), '{}') as tags
    from public.tasks t`;

type TaskRow = {
  id: string;
  slug: string;
  owner_wallet: string;
  name: string;
  description: string;
  status: UserTask["status"];
  est_minutes: number | null;
  created_at: Date;
  updated_at: Date;
  tags: string[];
};

const toTask = (r: TaskRow): UserTask => ({
  id: r.id,
  slug: r.slug,
  ownerWallet: r.owner_wallet,
  name: r.name,
  description: r.description,
  status: r.status,
  estMinutes: r.est_minutes,
  tags: r.tags ?? [],
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

type VersionRow = {
  id: string;
  task_id: string;
  version: number;
  gh_installation_id: string | number;
  repo_full_name: string;
  branch: string;
  commit_sha: string;
  repo_path: string;
  repo_private: boolean | null;
  labels: string[];
  contract: NewTaskVersion["contract"];
  created_by: string | null;
  runnable: boolean;
  validation: unknown;
  validated_at: Date | null;
  fixture_digest: string | null;
  hidden_digest: string | null;
  solution_digest: string | null;
  hidden_tests_count: number | null;
  pack_id: string | null;
  created_at: Date;
};

const toVersion = (r: VersionRow): UserTaskVersion => ({
  id: r.id,
  taskId: r.task_id,
  version: r.version,
  installationId: Number(r.gh_installation_id),
  repoFullName: r.repo_full_name,
  branch: r.branch,
  commitSha: r.commit_sha,
  repoPath: r.repo_path,
  repoPrivate: r.repo_private === true,
  labels: r.labels ?? [],
  contract: r.contract,
  createdBy: r.created_by ?? "",
  runnable: r.runnable,
  validation: r.validation,
  validatedAt: iso(r.validated_at),
  fixtureDigest: r.fixture_digest,
  hiddenDigest: r.hidden_digest,
  solutionDigest: r.solution_digest,
  hiddenTestsCount: r.hidden_tests_count,
  packId: r.pack_id,
  createdAt: iso(r.created_at)!,
});

type ValidationRow = {
  id: string;
  task_id: string;
  task_version_id: string;
  status: TaskValidation["status"];
  repeats: number;
  result: unknown;
  error: string | null;
  created_at: Date;
  claimed_at: Date | null;
  completed_at: Date | null;
};

const toValidation = (r: ValidationRow): TaskValidation => ({
  id: r.id,
  taskId: r.task_id,
  taskVersionId: r.task_version_id,
  status: r.status,
  repeats: r.repeats,
  result: r.result,
  error: r.error,
  createdAt: iso(r.created_at)!,
  claimedAt: iso(r.claimed_at),
  completedAt: iso(r.completed_at),
});

async function insertVersion(c: PoolClient, taskId: string, version: number, v: NewTaskVersion): Promise<UserTaskVersion> {
  const { rows } = await c.query<VersionRow>(
    `insert into public.task_versions
       (task_id, version, source, contract, labels, gh_installation_id, repo_full_name, branch, commit_sha, repo_path,
        repo_private, runnable, created_by)
     values ($1, $2, 'github', $3, $4, $5, $6, $7, $8, $9, $10, false, $11)
     returning *`,
    [taskId, version, JSON.stringify(v.contract), v.labels, v.installationId, v.repoFullName, v.branch, v.commitSha, v.repoPath, v.repoPrivate, v.createdBy],
  );
  return toVersion(rows[0]!);
}

async function setTags(c: PoolClient, taskId: string, tags: string[]): Promise<void> {
  await c.query(`delete from public.task_tags where task_id = $1`, [taskId]);
  if (tags.length > 0) {
    await c.query(`insert into public.task_tags (task_id, tag_id) select $1, unnest($2::text[]) on conflict do nothing`, [taskId, tags]);
  }
}

export class PgMyTasksStore implements MyTasksStore {
  constructor(private readonly pool: Pool) {}

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const out = await fn(c);
      await c.query("commit");
      return out;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      rethrow(e);
    } finally {
      c.release();
    }
  }

  private async taskBy(c: Pool | PoolClient, id: string): Promise<UserTask> {
    const { rows } = await c.query<TaskRow>(`${TASK_SELECT} where t.id = $1`, [id]);
    return toTask(rows[0]!);
  }

  async createTask(input: Parameters<MyTasksStore["createTask"]>[0]) {
    return this.tx(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into public.tasks (slug, kind, owner_wallet, name, description, visibility, status, est_minutes)
         values ($1, 'user', $2, $3, $4, 'private', 'draft', $5) returning id`,
        [input.slug, input.ownerWallet, input.name, input.description, input.estMinutes],
      );
      const id = rows[0]!.id;
      await setTags(c, id, input.tags);
      const version = await insertVersion(c, id, 1, input.version);
      return { task: await this.taskBy(c, id), version };
    });
  }

  async getOwnedTask(id: string, wallet: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    try {
      const { rows } = await this.pool.query<TaskRow>(
        `${TASK_SELECT} where t.id = $1::uuid and t.kind = 'user' and t.owner_wallet = $2 and t.deleted_at is null`,
        [id, wallet],
      );
      return rows[0] ? toTask(rows[0]) : null;
    } catch (e) {
      rethrow(e);
    }
  }

  async listVersions(taskId: string) {
    try {
      const { rows } = await this.pool.query<VersionRow>(`select * from public.task_versions where task_id = $1 order by version desc`, [taskId]);
      return rows.map(toVersion);
    } catch (e) {
      rethrow(e);
    }
  }

  async getVersion(taskId: string, version: number) {
    try {
      const { rows } = await this.pool.query<VersionRow>(`select * from public.task_versions where task_id = $1 and version = $2`, [taskId, version]);
      return rows[0] ? toVersion(rows[0]) : null;
    } catch (e) {
      rethrow(e);
    }
  }

  async addVersion(taskId: string, v: NewTaskVersion) {
    return this.tx(async (c) => {
      // Lock the task row: two concurrent POST /versions get consecutive numbers.
      await c.query(`select id from public.tasks where id = $1 for update`, [taskId]);
      const { rows } = await c.query<{ n: number }>(`select coalesce(max(version), 0)::int + 1 as n from public.task_versions where task_id = $1`, [taskId]);
      const version = await insertVersion(c, taskId, rows[0]!.n, v);
      await c.query(`update public.tasks set status = 'draft', updated_at = now() where id = $1`, [taskId]);
      return version;
    });
  }

  async updateTask(id: string, patch: { name?: string; description?: string; estMinutes?: number | null; tags?: string[] }) {
    return this.tx(async (c) => {
      await c.query(
        `update public.tasks
            set name = case when $2 then $3 else name end,
                description = case when $4 then $5 else description end,
                est_minutes = case when $6 then $7::int else est_minutes end,
                updated_at = now()
          where id = $1`,
        [id, patch.name !== undefined, patch.name ?? null, patch.description !== undefined, patch.description ?? null, patch.estMinutes !== undefined, patch.estMinutes ?? null],
      );
      if (patch.tags !== undefined) await setTags(c, id, patch.tags);
      return this.taskBy(c, id);
    });
  }

  async softDelete(id: string) {
    try {
      await this.pool.query(`update public.tasks set deleted_at = now(), updated_at = now() where id = $1 and deleted_at is null`, [id]);
    } catch (e) {
      rethrow(e);
    }
  }

  async enqueueValidation(input: { taskId: string; taskVersionId: string; requestedBy: string; repeats: number }) {
    return this.tx(async (c) => {
      const open = await c.query<ValidationRow>(
        `select * from public.task_validations where task_version_id = $1 and status in ('queued', 'running') limit 1`,
        [input.taskVersionId],
      );
      if (open.rows[0]) return { validation: toValidation(open.rows[0]), created: false };
      const { rows } = await c.query<ValidationRow>(
        `insert into public.task_validations (task_id, task_version_id, requested_by, repeats) values ($1, $2, $3, $4)
         on conflict do nothing returning *`,
        [input.taskId, input.taskVersionId, input.requestedBy, input.repeats],
      );
      if (!rows[0]) {
        // Lost a race with another request: return the open row it created.
        const again = await c.query<ValidationRow>(
          `select * from public.task_validations where task_version_id = $1 and status in ('queued', 'running') limit 1`,
          [input.taskVersionId],
        );
        return { validation: toValidation(again.rows[0]!), created: false };
      }
      await c.query(`update public.tasks set status = 'validating', updated_at = now() where id = $1`, [input.taskId]);
      return { validation: toValidation(rows[0]), created: true };
    });
  }

  async getValidation(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    try {
      const { rows } = await this.pool.query<ValidationRow>(`select * from public.task_validations where id = $1::uuid`, [id]);
      return rows[0] ? toValidation(rows[0]) : null;
    } catch (e) {
      rethrow(e);
    }
  }

  async latestValidation(taskVersionId: string) {
    try {
      const { rows } = await this.pool.query<ValidationRow>(
        `select * from public.task_validations where task_version_id = $1 order by created_at desc limit 1`,
        [taskVersionId],
      );
      return rows[0] ? toValidation(rows[0]) : null;
    } catch (e) {
      rethrow(e);
    }
  }
}

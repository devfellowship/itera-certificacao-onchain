import type { Pool } from 'pg';
import { isUserPack, versionIdOfPack } from './task-source.js';
import type { ClaimedValidation, UserTaskPin, UserTaskStore, ValidationOutcome } from './user-tasks.js';

export const CLAIM_VALIDATION_SQL = `
  update public.task_validations
     set status = 'running', claimed_at = now(), worker_id = $1
   where id = (
     select id from public.task_validations
      where status = 'queued'
      order by created_at
      for update skip locked
      limit 1)
  returning id, task_id, task_version_id, repeats`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PgUserTaskStore implements UserTaskStore {
  constructor(private readonly pool: Pool) {}

  async claimValidation(workerId: string): Promise<ClaimedValidation | null> {
    const claimed = await this.pool.query<{ id: string; task_id: string; task_version_id: string; repeats: number }>(CLAIM_VALIDATION_SQL, [workerId]);
    const row = claimed.rows[0];
    if (!row) return null;
    const pin = await this.pool.query<{ gh_installation_id: string; repo_full_name: string; commit_sha: string; repo_path: string }>(
      `select gh_installation_id, repo_full_name, commit_sha, repo_path from public.task_versions where id = $1 and source = 'github'`,
      [row.task_version_id],
    );
    const p = pin.rows[0];
    if (!p) {
      await this.finishValidation(row.id, workerId, { status: 'error', result: null, error: 'the task version has no GitHub pin' });
      return null;
    }
    return {
      id: row.id,
      taskId: row.task_id,
      taskVersionId: row.task_version_id,
      repeats: row.repeats,
      pin: { installationId: Number(p.gh_installation_id), repoFullName: p.repo_full_name, commitSha: p.commit_sha, repoPath: p.repo_path },
    };
  }

  async finishValidation(id: string, workerId: string, outcome: ValidationOutcome): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const updated = await client.query<{ task_id: string; task_version_id: string }>(
        `update public.task_validations
            set status = $3, result = $4, error = $5, completed_at = now()
          where id = $1 and worker_id = $2 and status = 'running'
          returning task_id, task_version_id`,
        [id, workerId, outcome.status, outcome.result === null ? null : JSON.stringify(outcome.result), outcome.error],
      );
      const row = updated.rows[0];
      if (!row) {
        await client.query('rollback');
        return;
      }
      if (outcome.status !== 'error') {
        const r = outcome.result;
        const ready = outcome.status === 'ready';
        const v = await client.query<{ repo_full_name: string; commit_sha: string; repo_path: string }>(
          `update public.task_versions
              set validation = $2, validated_at = now(), runnable = $3,
                  fixture_digest = $4, hidden_digest = $5, solution_digest = $6, hidden_tests_count = $7,
                  pack_id = case when $3 then 'user-' || id::text else null end,
                  pack_version = case when $3 then '1' else null end
            where id = $1
            returning repo_full_name, commit_sha, repo_path`,
          [
            row.task_version_id,
            JSON.stringify(r),
            ready,
            r.digests?.environment ?? null,
            r.digests?.hidden_tests ?? null,
            r.digests?.solution ?? null,
            r.checks.baseline_hidden_fails.hidden_total || null,
          ],
        );
        if (ready && v.rows[0]) {
          const pin = v.rows[0];
          await client.query(
            `insert into public.task_packs (id, version, fixture_digest, criteria_digest, evaluator_ref)
             values ($1, '1', $2, $3, $4) on conflict (id, version) do nothing`,
            [`user-${row.task_version_id}`, r.digests?.environment ?? null, r.digests?.hidden_tests ?? null, `github:${pin.repo_full_name}@${pin.commit_sha}:${pin.repo_path}`],
          );
        }
      }
      // The task status follows the gate of its LATEST version (an older ready version keeps running).
      await client.query(
        `update public.tasks t set status = $3, updated_at = now()
          where t.id = $1
            and $2::uuid = (select v.id from public.task_versions v where v.task_id = t.id order by v.version desc limit 1)`,
        [row.task_id, row.task_version_id, outcome.status === 'error' ? 'draft' : outcome.status],
      );
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async reapStaleValidations(olderThanMs: number): Promise<number> {
    const result = await this.pool.query<{ task_id: string }>(
      `update public.task_validations
          set status = 'error', error = 'runner lost the validation (worker restart or crash): validate again', completed_at = now()
        where status = 'running' and claimed_at < now() - ($1::int * interval '1 millisecond')
        returning task_id`,
      [olderThanMs],
    );
    const ids = result.rows.map((r) => r.task_id);
    if (ids.length > 0) {
      await this.pool.query(`update public.tasks set status = 'draft', updated_at = now() where id = any($1::uuid[]) and status = 'validating'`, [ids]);
    }
    return result.rowCount ?? 0;
  }

  async pinOfPack(packId: string): Promise<UserTaskPin | null> {
    if (!isUserPack(packId)) return null;
    const versionId = versionIdOfPack(packId);
    if (!UUID_RE.test(versionId)) return null;
    const { rows } = await this.pool.query<{
      gh_installation_id: string;
      repo_full_name: string;
      commit_sha: string;
      repo_path: string;
      fixture_digest: string | null;
      hidden_digest: string | null;
    }>(
      `select gh_installation_id, repo_full_name, commit_sha, repo_path, fixture_digest, hidden_digest
         from public.task_versions where id = $1::uuid and source = 'github' and runnable`,
      [versionId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      taskVersionId: versionId,
      installationId: Number(r.gh_installation_id),
      repoFullName: r.repo_full_name,
      commitSha: r.commit_sha,
      repoPath: r.repo_path,
      fixtureDigest: r.fixture_digest,
      hiddenDigest: r.hidden_digest,
    };
  }
}

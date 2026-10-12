// User tasks in the worker (U19): the validation-gate queue (task_validations, 0009_user_tasks.sql)
// and the GitHub pin of a validated user version (task pack `user-<task_version_id>`).
import type { ValidationResult } from '../../evaluator/src/validate.js';
import type { TaskPin } from './task-source.js';

export interface ClaimedValidation {
  id: string;
  taskId: string;
  taskVersionId: string;
  repeats: number;
  pin: TaskPin;
}

export type ValidationOutcome =
  | { status: 'ready' | 'invalid'; result: ValidationResult; error: null }
  /** A platform failure (GitHub unreachable, Docker down): the version is not judged. */
  | { status: 'error'; result: null; error: string };

export interface UserTaskPin extends TaskPin {
  taskVersionId: string;
  /** Digests the gate pinned (task_versions.fixture_digest / hidden_digest). */
  fixtureDigest: string | null;
  hiddenDigest: string | null;
}

export interface UserTaskStore {
  /** Claims the oldest queued validation (FOR UPDATE SKIP LOCKED) and marks it running. */
  claimValidation(workerId: string): Promise<ClaimedValidation | null>;
  /**
   * One transaction: the validation row, the version (validation jsonb, digests, hidden test count,
   * runnable, pack id when ready), the task pack row when ready, and the task status when the
   * version is the task's latest. Writes nothing when the row is no longer running under workerId.
   */
  finishValidation(id: string, workerId: string, outcome: ValidationOutcome): Promise<void>;
  /** Running validations claimed before `olderThanMs` become `error`. Returns how many. */
  reapStaleValidations(olderThanMs: number): Promise<number>;
  /** The pin of a validated user version, by its pack id. Null when unknown or not runnable. */
  pinOfPack(packId: string): Promise<UserTaskPin | null>;
}

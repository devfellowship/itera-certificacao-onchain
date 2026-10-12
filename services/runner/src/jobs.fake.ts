import type { ClaimedRun, JobStore, RunJob, RunOutcome, RunPhase } from './jobs.js';

interface FakeRun {
  job: RunJob | null;
  claimed: ClaimedRun;
  status: string;
  phase: RunPhase | null;
  workerId: string | null;
  claimedAt: number | null;
  startedAt: number;
}

/** In-memory JobStore for tests. Same semantics as PgJobStore. */
export class FakeJobStore implements JobStore {
  runs = new Map<string, FakeRun>();
  outcomes = new Map<string, RunOutcome>();
  phases: Array<{ runId: string; phase: RunPhase }> = [];

  enqueue(claimed: ClaimedRun, job: RunJob | null, startedAt = Date.now()): void {
    this.runs.set(claimed.runId, { job, claimed, status: 'queued', phase: null, workerId: null, claimedAt: null, startedAt });
  }

  async claim(workerId: string): Promise<ClaimedRun | null> {
    const next = [...this.runs.values()].filter((r) => r.status === 'queued').sort((a, b) => a.startedAt - b.startedAt)[0];
    if (!next) return null;
    Object.assign(next, { status: 'running', phase: 'preparing', workerId, claimedAt: Date.now() });
    return next.claimed;
  }

  async loadJob(run: ClaimedRun): Promise<RunJob | null> {
    return this.runs.get(run.runId)?.job ?? null;
  }

  async setPhase(runId: string, workerId: string, phase: RunPhase): Promise<void> {
    const run = this.runs.get(runId);
    if (run && run.workerId === workerId && run.status === 'running') {
      run.phase = phase;
      this.phases.push({ runId, phase });
    }
  }

  async finish(runId: string, workerId: string, outcome: RunOutcome): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.workerId !== workerId || run.status !== 'running') return;
    run.status = outcome.status;
    run.phase = outcome.phase;
    if (run.job) run.job.modelApiKeyEnc = null;
    this.outcomes.set(runId, outcome);
  }

  async reapStale(olderThanMs: number): Promise<number> {
    let n = 0;
    for (const run of this.runs.values()) {
      if (run.status === 'running' && run.claimedAt !== null && run.claimedAt < Date.now() - olderThanMs) {
        run.status = 'infra_error';
        run.phase = 'done';
        if (run.job) run.job.modelApiKeyEnc = null;
        n += 1;
      }
    }
    return n;
  }
}

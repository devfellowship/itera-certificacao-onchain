/**
 * Anti-collusion rules (U27, plan 20261012-itera-testmyagent-ui-refactor; Q7 = B, Tainan TG 20979):
 * a user can author a task and run their own agent on it. That cannot be prevented, so it must be
 * worthless. Pure functions only — no I/O. The Pg stores load the inputs; the rules live here
 * (CLAUDE.md: no DB functions for business logic).
 *
 *  1. Sealed-test rule. A task enters a ranking or a leaderboard only when its hidden tests are
 *     sealed: a curated ITERA task, or a user task whose source repo is PRIVATE. A public-repo task
 *     (anyone can read the hidden tests) and any task labelled `open-tests` runs, but is unranked.
 *  2. Self-evaluated label. The task author wallet equals the agent owner wallet, or the task repo
 *     and the agent repo come from the same GitHub account (installation account). Curated ITERA
 *     tasks have no author wallet: they are never self-evaluated.
 *  3. Task reputation. Distinct wallets that ran the task (the author excluded), finished runs, and
 *     the yes-rate of owner feedback ("the result matched reality"). The ranking weighs every
 *     per-task score by the reputation weight of the task.
 */

export const OPEN_TESTS_LABEL = "open-tests";
export const SEALED_TESTS_LABEL = "sealed-tests";

/** Distinct non-author wallets at which a user task reaches full wallet trust. */
export const REPUTATION_FULL_WALLETS = 5;

export interface TaskProvenance {
  /** `itera` (curated) | `user`; null when the run has no catalog task (legacy pack runs). */
  kind: string | null;
  /** tasks.owner_wallet — null for curated tasks. */
  authorWallet: string | null;
  /** task_versions.source: `curated` | `github`. */
  source: string | null;
  /** task_versions.repo_private (0010); null = unknown (fails closed for a user task). */
  repoPrivate: boolean | null;
  labels: string[];
  /** github_installations.account_login of the task version's installation. */
  githubAccount: string | null;
}

export interface AgentProvenance {
  ownerWallet: string | null;
  /** github_installations.account_login of the agent's installation. */
  githubAccount: string | null;
}

/** Rule 1. A task without catalog provenance (legacy curated pack) is ranked. */
export function isRankedTask(task: Pick<TaskProvenance, "kind" | "source" | "repoPrivate" | "labels"> | null): boolean {
  if (!task || task.kind === null) return true;
  if (task.labels.includes(OPEN_TESTS_LABEL)) return false;
  if (task.kind === "itera") return true;
  // A user task: sealed only when it is read from a private GitHub repo.
  return task.source === "github" && task.repoPrivate === true;
}

/** Why a task is unranked, for the API and the UI; null when ranked. */
export function unrankedReason(task: Pick<TaskProvenance, "kind" | "source" | "repoPrivate" | "labels"> | null): string | null {
  if (isRankedTask(task)) return null;
  if (task!.labels.includes(OPEN_TESTS_LABEL)) return "open-tests";
  if (task!.repoPrivate === false) return "public-repo";
  return "repo-visibility-unknown";
}

const sameAccount = (a: string | null, b: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** Rule 2. */
export function isSelfEvaluated(task: Pick<TaskProvenance, "kind" | "authorWallet" | "githubAccount"> | null, agent: AgentProvenance): boolean {
  if (!task || task.kind !== "user") return false;
  if (task.authorWallet && agent.ownerWallet && task.authorWallet === agent.ownerWallet) return true;
  return sameAccount(task.githubAccount, agent.githubAccount);
}

export interface TaskReputationInput {
  kind: string | null;
  /** Distinct wallets that finished a run on the task, the task author excluded. */
  distinctWallets: number;
  /** Finished runs on the task (every wallet). */
  runs: number;
  /** Feedback answers on runs of the task (the task author's own answers excluded). */
  feedbackYes: number;
  feedbackTotal: number;
}

export interface TaskReputation {
  distinctWallets: number;
  runs: number;
  feedbackCount: number;
  /** yes / total, null without feedback. */
  feedbackYesRate: number | null;
  /** 0–1. Multiplies a per-task score in the ranking. */
  weight: number;
  curatedByItera: boolean;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Rule 3. Curated ITERA tasks weigh 1. A user task weighs
 *   min(1, distinctWallets / 5) × (feedbackYes + 1) / (feedbackTotal + 2)
 * — wallet trust times a Laplace-smoothed yes-rate. A task only its author ran weighs 0.
 */
export function taskReputation(input: TaskReputationInput): TaskReputation {
  const curated = input.kind === null || input.kind === "itera";
  const total = Math.max(0, input.feedbackTotal);
  const yes = Math.min(Math.max(0, input.feedbackYes), total);
  const walletFactor = Math.min(1, Math.max(0, input.distinctWallets) / REPUTATION_FULL_WALLETS);
  const feedbackFactor = (yes + 1) / (total + 2);
  return {
    distinctWallets: input.distinctWallets,
    runs: input.runs,
    feedbackCount: total,
    feedbackYesRate: total === 0 ? null : round3(yes / total),
    weight: curated ? 1 : round3(walletFactor * feedbackFactor),
    curatedByItera: input.kind === "itera",
  };
}

export const FEEDBACK_NOTE_MAX = 500;
/** Run statuses that can take feedback: a finished, graded run. */
export const FEEDBACK_RUN_STATUSES = new Set(["pass", "fail", "invalid", "timeout"]);

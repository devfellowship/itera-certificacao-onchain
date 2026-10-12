/**
 * Sample repos (U37, plan 20261012-itera-testmyagent-ui-refactor, Tainan TG 21122/21126): anyone
 * can run the whole flow from ANY wallet, without installing the GitHub App. For the sample repos
 * on this allow-list only, the API reads files through the TestMyAgent installation on the
 * devfellowship org, whoever the caller is. The agent / task row stays owned by the caller's
 * wallet and is marked `source: sample`. Every other repo keeps the normal path: the installation
 * that covers it must be bound to the caller's wallet.
 *
 * Env overrides (comma-separated `owner/repo` lists):
 *   ITERA_SAMPLE_AGENT_REPOS       default devfellowship/testmyagent-demo-agent
 *   ITERA_SAMPLE_TASK_REPOS        default devfellowship/testmyagent-demo-task
 *   ITERA_SAMPLE_INSTALLATION_ID   default 170661046 (the TestMyAgent App on devfellowship)
 */
export const DEFAULT_SAMPLE_AGENT_REPOS = ["devfellowship/testmyagent-demo-agent"] as const;
export const DEFAULT_SAMPLE_TASK_REPOS = ["devfellowship/testmyagent-demo-task"] as const;
export const DEFAULT_SAMPLE_INSTALLATION_ID = 170661046;

export type SampleKind = "agent" | "task";
export type RepoSource = "github" | "sample";

export interface SampleRepos {
  /** Lower-cased `owner/repo`. */
  agents: string[];
  tasks: string[];
  installationId: number;
}

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

function list(raw: string | undefined, fallback: readonly string[]): string[] {
  const items = raw === undefined || raw.trim() === "" ? [...fallback] : raw.split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set(items.filter((r) => REPO_RE.test(r)).map((r) => r.toLowerCase()))];
}

export function sampleReposFromEnv(env: NodeJS.ProcessEnv = process.env): SampleRepos {
  const id = Number(env.ITERA_SAMPLE_INSTALLATION_ID ?? DEFAULT_SAMPLE_INSTALLATION_ID);
  return {
    agents: list(env.ITERA_SAMPLE_AGENT_REPOS, DEFAULT_SAMPLE_AGENT_REPOS),
    tasks: list(env.ITERA_SAMPLE_TASK_REPOS, DEFAULT_SAMPLE_TASK_REPOS),
    installationId: Number.isSafeInteger(id) && id > 0 ? id : DEFAULT_SAMPLE_INSTALLATION_ID,
  };
}

/** True when `repoFullName` is on the allow-list of `kind` (both lists when kind is omitted). Case-insensitive, like GitHub. */
export function isSampleRepo(cfg: SampleRepos, repoFullName: string, kind?: SampleKind): boolean {
  const r = repoFullName.toLowerCase();
  if (kind === "agent") return cfg.agents.includes(r);
  if (kind === "task") return cfg.tasks.includes(r);
  return cfg.agents.includes(r) || cfg.tasks.includes(r);
}

export class SampleRepoError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The installation id of the sample path. Refuses (403) any repo outside the allow-list: this is
 * the only gate between "any wallet" and the devfellowship installation. `coveringInstallation` is
 * what GitHub says covers the repo; when it is not the sample installation the repo is not
 * readable this way (503: a server configuration problem, not the caller's).
 */
export function sampleInstallation(cfg: SampleRepos, repoFullName: string, kind: SampleKind | undefined, coveringInstallation: number | null): number {
  if (!isSampleRepo(cfg, repoFullName, kind)) {
    throw new SampleRepoError(403, `${repoFullName} is not a TestMyAgent sample repo`);
  }
  if (coveringInstallation !== cfg.installationId) {
    throw new SampleRepoError(503, "the sample repo is not readable by the TestMyAgent GitHub App right now");
  }
  return cfg.installationId;
}

/** `source` as the API answers it: the stored value, else derived from the allow-list (rows written before 0016). */
export function repoSourceOf(stored: unknown, cfg: SampleRepos, repoFullName: string | null | undefined, kind: SampleKind): RepoSource {
  if (stored === "sample" || stored === "github") return stored;
  return repoFullName && isSampleRepo(cfg, repoFullName, kind) ? "sample" : "github";
}

import { createSign } from "node:crypto";

/**
 * Read-only GitHub App client (ADR-2, plan 20261012-itera-agent-proof-route-change-fixes).
 *
 * The App holds only `Contents: read` + `Metadata: read`. Every call here is a GET, except the
 * two token exchanges (installation access token, OAuth user code), which GitHub defines as POST.
 * No SDK dependency: an RS256 JWT is a few lines with node:crypto.
 *
 * Routes depend on the `GitHubAppApi` interface, never on this class, so tests use a fake.
 */
export interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  mode: string;
  sha: string;
  size?: number;
}

export interface InstallationRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export interface GitHubAppApi {
  /** App slug, used for the public install URL. */
  readonly slug: string;
  /** The account (user or org) the installation belongs to, or null when it does not exist. */
  getInstallationAccount(installationId: number): Promise<{ login: string } | null>;
  /** Exchanges the OAuth `code` GitHub sends after install, and checks that the user who installed
   * can see this installation. This is what stops a caller from binding someone else's
   * installation id to their wallet. */
  userCanAccessInstallation(code: string, installationId: number): Promise<boolean>;
  /** The installation of this App on the repo, or null when the App is not installed there. */
  getRepoInstallationId(repoFullName: string): Promise<number | null>;
  listInstallationRepos(installationId: number): Promise<InstallationRepo[]>;
  /** Commit SHA of `ref` (default branch when omitted). */
  resolveHead(installationId: number, repoFullName: string, ref?: string): Promise<string>;
  listTree(installationId: number, repoFullName: string, commitSha: string): Promise<{ entries: TreeEntry[]; truncated: boolean }>;
  readBlob(installationId: number, repoFullName: string, blobSha: string): Promise<Buffer>;
}

export class GitHubConfigError extends Error {}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface GitHubAppConfig {
  appId: string;
  slug: string;
  privateKeyPem: string;
  clientId: string;
  clientSecret: string;
  apiBase?: string;
}

/** Reads GITHUB_APP_* from env (Infisical /apps/itera-agent-credentials/). Throws GitHubConfigError
 * when any is missing — routes map that to 503, never a silent fallback. */
export function githubAppConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig {
  const names = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"] as const;
  const missing = names.filter((n) => !env[n]);
  if (missing.length > 0) {
    throw new GitHubConfigError(
      `GitHub App is not configured: ${missing.join(", ")} not set (Infisical /apps/itera-agent-credentials/).`,
    );
  }
  const rawKey = env.GITHUB_APP_PRIVATE_KEY!;
  // Accept the PEM itself, a PEM with literal "\n", or base64 of the PEM (env-var friendly).
  const privateKeyPem = rawKey.includes("-----BEGIN")
    ? rawKey.replace(/\\n/g, "\n")
    : Buffer.from(rawKey, "base64").toString("utf-8");
  return {
    appId: env.GITHUB_APP_ID!,
    slug: env.GITHUB_APP_SLUG!,
    privateKeyPem,
    clientId: env.GITHUB_APP_CLIENT_ID!,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET!,
  };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signAppJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat 60 s in the past absorbs clock drift; GitHub caps exp at 10 min.
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKeyPem))}`;
}

function splitFullName(fullName: string): [string, string] {
  const [owner, repo, ...rest] = fullName.split("/");
  if (!owner || !repo || rest.length > 0) throw new GitHubApiError(`invalid repo name: ${fullName}`, 400);
  return [encodeURIComponent(owner), encodeURIComponent(repo)];
}

export class GitHubAppClient implements GitHubAppApi {
  private readonly apiBase: string;
  private readonly tokenCache = new Map<number, { token: string; expiresAt: number }>();

  constructor(private readonly config: GitHubAppConfig) {
    this.apiBase = config.apiBase ?? "https://api.github.com";
  }

  get slug(): string {
    return this.config.slug;
  }

  private async request(path: string, auth: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "itera-agent-credentials-api",
        Authorization: auth,
        ...(init.headers ?? {}),
      },
    });
    return res;
  }

  private async json<T>(path: string, auth: string, init?: RequestInit): Promise<T> {
    const res = await this.request(path, auth, init);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new GitHubApiError(`GitHub ${init?.method ?? "GET"} ${path} -> ${res.status}: ${body.slice(0, 200)}`, res.status);
    }
    return (await res.json()) as T;
  }

  private appAuth(): string {
    return `Bearer ${signAppJwt(this.config.appId, this.config.privateKeyPem)}`;
  }

  private async installationAuth(installationId: number): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return `Bearer ${cached.token}`;
    const out = await this.json<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      this.appAuth(),
      { method: "POST" },
    );
    this.tokenCache.set(installationId, { token: out.token, expiresAt: Date.parse(out.expires_at) });
    return `Bearer ${out.token}`;
  }

  async getInstallationAccount(installationId: number): Promise<{ login: string } | null> {
    const res = await this.request(`/app/installations/${installationId}`, this.appAuth());
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubApiError(`GitHub GET installation -> ${res.status}`, res.status);
    const body = (await res.json()) as { account?: { login?: string } };
    return { login: body.account?.login ?? "" };
  }

  async userCanAccessInstallation(code: string, installationId: number): Promise<boolean> {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "itera-agent-credentials-api" },
      body: JSON.stringify({ client_id: this.config.clientId, client_secret: this.config.clientSecret, code }),
    });
    const tokenBody = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
    if (!tokenBody.access_token) return false;
    const auth = `Bearer ${tokenBody.access_token}`;
    for (let page = 1; page <= 10; page++) {
      const out = await this.json<{ installations: { id: number }[] }>(`/user/installations?per_page=100&page=${page}`, auth);
      if (out.installations.some((i) => i.id === installationId)) return true;
      if (out.installations.length < 100) break;
    }
    return false;
  }

  async getRepoInstallationId(repoFullName: string): Promise<number | null> {
    const [owner, repo] = splitFullName(repoFullName);
    const res = await this.request(`/repos/${owner}/${repo}/installation`, this.appAuth());
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubApiError(`GitHub GET repo installation -> ${res.status}`, res.status);
    return ((await res.json()) as { id: number }).id;
  }

  async listInstallationRepos(installationId: number): Promise<InstallationRepo[]> {
    const auth = await this.installationAuth(installationId);
    const repos: InstallationRepo[] = [];
    for (let page = 1; page <= 10; page++) {
      const out = await this.json<{ repositories: { full_name: string; private: boolean; default_branch: string }[] }>(
        `/installation/repositories?per_page=100&page=${page}`,
        auth,
      );
      repos.push(...out.repositories.map((r) => ({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch })));
      if (out.repositories.length < 100) break;
    }
    return repos;
  }

  async resolveHead(installationId: number, repoFullName: string, ref?: string): Promise<string> {
    const [owner, repo] = splitFullName(repoFullName);
    const auth = await this.installationAuth(installationId);
    let branch = ref;
    if (!branch) {
      branch = (await this.json<{ default_branch: string }>(`/repos/${owner}/${repo}`, auth)).default_branch;
    }
    const commit = await this.json<{ sha: string }>(`/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`, auth);
    return commit.sha;
  }

  async listTree(installationId: number, repoFullName: string, commitSha: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const [owner, repo] = splitFullName(repoFullName);
    const auth = await this.installationAuth(installationId);
    const out = await this.json<{ tree: TreeEntry[]; truncated: boolean }>(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`,
      auth,
    );
    return { entries: out.tree, truncated: out.truncated };
  }

  async readBlob(installationId: number, repoFullName: string, blobSha: string): Promise<Buffer> {
    const [owner, repo] = splitFullName(repoFullName);
    const auth = await this.installationAuth(installationId);
    const out = await this.json<{ content: string; encoding: string }>(`/repos/${owner}/${repo}/git/blobs/${encodeURIComponent(blobSha)}`, auth);
    return Buffer.from(out.content, out.encoding === "base64" ? "base64" : "utf-8");
  }
}

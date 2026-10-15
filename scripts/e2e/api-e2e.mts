/**
 * API end-to-end script (plan 20261012-itera-testmyagent-ui-refactor, task U23).
 *
 *   npm run e2e:api -- --base https://itera-agent-credentials-api.devfellowship.com
 *
 * Drives the whole paid flow of a deployed API with a real devnet wallet:
 *   SIWS login -> /me -> catalog -> GitHub App routes -> agent -> quote -> pay (one signed tx)
 *   -> POST /evaluations -> poll to issued -> run detail -> proof -> public profile, og.png, badge,
 *   leaderboard -> My evaluations, plus the negative checks (unpaid 402, foreign tx 402, 404, 401).
 *
 * Secrets come from the environment and are never printed or written to the report:
 *   E2E_WALLET_SECRET_B58   base58 ed25519 secret key (64 bytes) of the wallet that logs in and pays.
 *                           It must own a GitHub App installation that holds --repo, and hold ~0.01 SOL.
 * --sample (U37): a FRESH wallet generated in memory (E2E_WALLET_SECRET_B58 is not needed), funded by
 *          POST /faucet, that never touched the GitHub App: the agent comes from the sample repo.
 * Options: --no-pay stops before the payment (free steps only). --evaluation <id> re-verifies an
 *          evaluation that is already paid (no new payment): the quote and pay steps are skipped.
 * Hermetic guard (T14, .github/workflows/web3-e2e-guard.yml, local stack of the PR head):
 *   --agent-id <uuid>     use an agent that already exists and is owned by the wallet (a DB fixture);
 *                         the GitHub App steps are skipped, POST /agents is replaced by GET /agents/:id.
 *   --no-web              no web host: the link-preview and web badge-redirect checks are skipped.
 *   --ipfs-gateway <url>  IPFS gateway of the in-browser verifier step (default: the public one).
 *   --verify-strict       the verifier step fails on a SKIPPED check too (every check must pass).
 * Output: <out>/api-e2e.json and <out>/api-e2e.md (default ./e2e-report).
 * Exit code: 0 when every step passes, 1 when one fails, 2 on a usage or setup error.
 *
 * Every step records pass | fail | skip. A step that needs the output of a failed step is skipped,
 * not failed, so the report shows the first cause.
 */
import { createPrivateKey, sign as edSign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createSolanaRpc, getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { validateApiResponse } from "@itera/contracts";
import { IPFS_GATEWAY_URL, runVerification } from "../../apps/web/src/verify.ts";

// ------------------------------------------------------------------------------------------------
// Options

const DEFAULT_API = "https://itera-agent-credentials-api.devfellowship.com";
const DEFAULT_WEB = "https://itera-agent-credentials.devfellowship.com";
const DEFAULT_TREASURY = "5jRHjKwmsTZgVSAaFFKRkXBnvVx82f6yxwUtU8G1BD1d";

const { values: argv } = parseArgs({
  options: {
    base: { type: "string", default: process.env.E2E_API_BASE ?? DEFAULT_API },
    web: { type: "string", default: process.env.E2E_WEB_BASE ?? DEFAULT_WEB },
    rpc: { type: "string", default: process.env.E2E_RPC_URL ?? process.env.ITERA_SOLANA_RPC_URL ?? "https://api.devnet.solana.com" },
    repo: { type: "string", default: "devfellowship/testmyagent-demo-agent" },
    "installation-id": { type: "string", default: "170661046" },
    task: { type: "string", default: "" },
    treasury: { type: "string", default: DEFAULT_TREASURY },
    "base-fee-usd": { type: "string", default: "0.10" },
    "poll-timeout-min": { type: "string", default: "25" },
    out: { type: "string", default: "e2e-report" },
    "no-pay": { type: "boolean", default: false },
    sample: { type: "boolean", default: false },
    evaluation: { type: "string", default: "" },
    "agent-id": { type: "string", default: "" },
    "no-web": { type: "boolean", default: false },
    "ipfs-gateway": { type: "string", default: "" },
    "verify-strict": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (argv.help) {
  console.log("usage: npm run e2e:api -- [--base <api>] [--web <web>] [--rpc <devnet rpc>] [--repo owner/name] [--task <slug>] [--out dir] [--no-pay] [--evaluation <id>]");
  process.exit(0);
}

const API = argv.base!.replace(/\/+$/, "");
const WEB = argv.web!.replace(/\/+$/, "");
const REPO = argv.repo!;
const TREASURY = argv.treasury!;
const BASE_FEE_USD = Number(argv["base-fee-usd"]);
const POLL_TIMEOUT_MS = Number(argv["poll-timeout-min"]) * 60_000;
const OUT_DIR = argv.out!;

const SAMPLE = argv.sample === true;
const AGENT_ID = argv["agent-id"]!.trim();
const NO_WEB = argv["no-web"] === true;
if (AGENT_ID && SAMPLE) {
  console.error("--agent-id and --sample exclude each other.");
  process.exit(2);
}
const secretB58 = SAMPLE ? "" : process.env.E2E_WALLET_SECRET_B58;
if (!SAMPLE && !secretB58) {
  console.error("E2E_WALLET_SECRET_B58 is required (base58 secret key of the wallet that logs in and pays).");
  process.exit(2);
}

// ------------------------------------------------------------------------------------------------
// Wallet helpers (SIWS signs with node:crypto; the payment tx is signed with web3.js v1 because the
// API builds it with @solana/pay)

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

interface Wallet {
  keypair: Keypair;
  address: string;
  signMessage(message: string): string;
}

function walletFromSecretBytes(secret: Uint8Array): Wallet {
  const keypair = Keypair.fromSecretKey(secret);
  const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(secret.subarray(0, 32))]), format: "der", type: "pkcs8" });
  return {
    keypair,
    address: keypair.publicKey.toBase58(),
    signMessage: (message) => getBase58Decoder().decode(edSign(null, Buffer.from(message, "utf8"), key)),
  };
}

// --sample: a fresh in-memory wallet; its secret is never printed or written.
const wallet = SAMPLE ? walletFromSecretBytes(Keypair.generate().secretKey) : walletFromSecretBytes(Uint8Array.from(getBase58Encoder().encode(secretB58!)));
/** A throwaway wallet that never holds funds: it proves one wallet cannot read another's data. */
const stranger = walletFromSecretBytes(Keypair.generate().secretKey);

// ------------------------------------------------------------------------------------------------
// HTTP

interface Res {
  status: number;
  headers: Headers;
  json: any;
  text: string;
  bytes: Buffer;
}

async function http(method: string, path: string, opts: { token?: string; body?: unknown; base?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const url = path.startsWith("http") ? path : `${opts.base ?? API}${path}`;
  const headers: Record<string, string> = { accept: "*/*", ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  let res: Response | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
    res = await fetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: "manual", signal: AbortSignal.timeout(60_000) });
    if (res.status === 429) {
      // The API allows 300 requests per 15 min per IP (one full run uses ~150): wait for the window.
      const reset = Number(res.headers.get("ratelimit-reset") ?? res.headers.get("retry-after") ?? 30);
      const waitS = Math.min(Math.max(reset, 1) + 1, 910);
      console.log(`     ... 429 from ${new URL(url).host}; waiting ${waitS} s for the rate-limit window`);
      await sleep(waitS * 1000);
      continue;
    }
    if (res.status !== 502 && res.status !== 503 && res.status !== 504) break;
    await sleep(2_000 * (attempt + 1));
  }
  const bytes = Buffer.from(await res!.arrayBuffer());
  const text = bytes.toString("utf8");
  let json: any = null;
  if ((res!.headers.get("content-type") ?? "").includes("json")) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res!.status, headers: res!.headers, json, text, bytes };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(w: Wallet): Promise<{ token: string; expiresAt: string; nonceMessage: string }> {
  const n = await http("POST", "/auth/nonce", { body: { wallet: w.address } });
  must(n.status === 200 && typeof n.json?.message === "string", `POST /auth/nonce -> ${n.status}`);
  const v = await http("POST", "/auth/verify", { body: { wallet: w.address, signature: w.signMessage(n.json.message) } });
  must(v.status === 200 && typeof v.json?.token === "string", `POST /auth/verify -> ${v.status} ${v.text.slice(0, 120)}`);
  return { token: v.json.token, expiresAt: v.json.expiresAt, nonceMessage: n.json.message };
}

// ------------------------------------------------------------------------------------------------
// Step runner

type Status = "pass" | "fail" | "skip";
interface StepResult {
  id: string;
  group: string;
  name: string;
  status: Status;
  ms: number;
  detail: string;
  facts: Record<string, unknown>;
  error?: string;
}

class Skip extends Error {}
class Assertion extends Error {}

function must(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Assertion(message);
}
function skip(reason: string): never {
  throw new Skip(reason);
}

const results: StepResult[] = [];
let stepNo = 0;

async function step(group: string, name: string, fn: (facts: Record<string, unknown>) => Promise<string | void>): Promise<void> {
  const id = `S${String(++stepNo).padStart(2, "0")}`;
  const facts: Record<string, unknown> = {};
  const t0 = Date.now();
  let status: Status = "pass";
  let detail = "";
  let error: string | undefined;
  try {
    detail = (await fn(facts)) ?? "";
  } catch (e) {
    if (e instanceof Skip) {
      status = "skip";
      detail = e.message;
    } else {
      status = "fail";
      error = e instanceof Error ? e.message : String(e);
    }
  }
  const r: StepResult = { id, group, name, status, ms: Date.now() - t0, detail, facts, ...(error ? { error } : {}) };
  results.push(r);
  const mark = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "SKIP";
  console.log(`${mark} ${id} [${group}] ${name}${detail ? ` - ${detail}` : ""}${error ? `\n     ${error}` : ""}`);
}

// ------------------------------------------------------------------------------------------------
// State shared between steps

const S: {
  token?: string;
  strangerToken?: string;
  me?: any;
  task?: any;
  taskDetail?: any;
  model?: string;
  agent?: any;
  quote?: any;
  txSig?: string;
  evaluationId?: string;
  runIds?: string[];
  evaluation?: any;
  run?: any;
  slug?: string;
  hash?: string;
  balanceBefore?: number;
  balanceAfter?: number;
  feeLamports?: number;
} = {};

const conn = new Connection(argv.rpc!, "confirmed");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH_LEAK_RE = /(^|[\s'"(])\/(tmp|var\/folders|private\/var|workspace|app|root|home)\//;
const approx = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const need = <T,>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null) skip(`needs ${what} from an earlier step`);
  return v;
};

// ------------------------------------------------------------------------------------------------
// Steps

async function main(): Promise<void> {
  console.log(`API ${API}\nWEB ${WEB}\nwallet ${wallet.address}\nrepo ${REPO}\n`);

  // -- 1. Service ------------------------------------------------------------------------------
  let routes: string[] = [];
  await step("service", "GET /health and GET / (service document)", async (f) => {
    const h = await http("GET", "/health");
    must(h.status === 200 && h.json?.status === "ok", `/health -> ${h.status}`);
    const r = await http("GET", "/");
    must(r.status === 200 && r.json?.service === "testmyagent-api", `/ -> ${r.status}`);
    routes = r.json.routes ?? [];
    f.version = r.json.version;
    f.routeCount = routes.length;
    return `version ${r.json.version}, ${routes.length} routes`;
  });

  // -- 2. SIWS login -------------------------------------------------------------------------------
  await step("auth", "SIWS login: nonce, signMessage, verify, session token", async (f) => {
    const s = await login(wallet);
    S.token = s.token;
    must(s.nonceMessage.includes(wallet.address) && /Nonce: [0-9a-f]{32}/.test(s.nonceMessage), "sign-in message lacks wallet or nonce");
    must(Date.parse(s.expiresAt) > Date.now() + 3600_000, "session expires in less than 1 h");
    f.tokenPrefix = `${s.token.slice(0, 8)}...`;
    f.expiresAt = s.expiresAt;
    return `token ${s.token.slice(0, 8)}..., expires ${s.expiresAt}`;
  });
  await step("auth", "GET /auth/me returns the signed-in wallet", async () => {
    const r = await http("GET", "/auth/me", { token: need(S.token, "a session") });
    must(r.status === 200 && r.json?.wallet === wallet.address, `/auth/me -> ${r.status} ${r.text.slice(0, 100)}`);
  });
  await step("auth", "negative: a nonce is single-use and a wrong signature is rejected (401)", async () => {
    const n = await http("POST", "/auth/nonce", { body: { wallet: wallet.address } });
    const bad = await http("POST", "/auth/verify", { body: { wallet: wallet.address, signature: stranger.signMessage(n.json.message) } });
    must(bad.status === 401, `wrong signature -> ${bad.status}`);
    const replay = await http("POST", "/auth/verify", { body: { wallet: wallet.address, signature: wallet.signMessage(n.json.message) } });
    must(replay.status === 401, `replayed nonce -> ${replay.status}`);
  });

  // -- 3. Profile ----------------------------------------------------------------------------------
  await step("profile", "GET /me then PATCH /me then GET /me (displayName round-trips, then restored)", async (f) => {
    const token = need(S.token, "a session");
    const before = await http("GET", "/me", { token });
    must(before.status === 200 && before.json?.wallet === wallet.address, `GET /me -> ${before.status}`);
    S.me = before.json;
    const mark = `E2E ${new Date().toISOString().slice(0, 19)}Z`;
    const patched = await http("PATCH", "/me", { token, body: { displayName: mark } });
    must(patched.status === 200 && patched.json?.displayName === mark, `PATCH /me -> ${patched.status} ${patched.text.slice(0, 120)}`);
    const after = await http("GET", "/me", { token });
    must(after.json?.displayName === mark, `GET /me after PATCH shows ${JSON.stringify(after.json?.displayName)}`);
    const bad = await http("PATCH", "/me", { token, body: { displayName: "" , handle: "Not Valid!" } });
    must(bad.status === 400, `PATCH /me with an invalid handle -> ${bad.status}`);
    const restore = await http("PATCH", "/me", { token, body: { displayName: before.json.displayName ?? null } });
    must(restore.status === 200, `restore PATCH -> ${restore.status}`);
    f.meKeys = Object.keys(before.json);
    return `keys ${Object.keys(before.json).join(",")}`;
  });
  await step("profile", "negative: GET /me and PATCH /me without a session answer 401", async () => {
    const a = await http("GET", "/me");
    const b = await http("PATCH", "/me", { body: { displayName: "x" } });
    must(a.status === 401 && b.status === 401, `GET ${a.status}, PATCH ${b.status}`);
  });

  // -- 4. Catalog ------------------------------------------------------------------------------------
  await step("catalog", "GET /tasks lists runnable curated tasks; the chosen task has a detail page", async (f) => {
    const r = await http("GET", "/tasks", { token: S.token });
    must(r.status === 200 && Array.isArray(r.json?.tasks) && r.json.tasks.length > 0, `/tasks -> ${r.status}`);
    const tasks: any[] = r.json.tasks;
    for (const t of tasks) must(t.id && t.slug && t.name && Array.isArray(t.tags), `task row lacks id/slug/name/tags: ${JSON.stringify(t).slice(0, 100)}`);
    const runnable = tasks.filter((t) => t.runnable);
    must(runnable.length > 0, "no runnable task");
    const chosen = argv.task ? tasks.find((t) => t.slug === argv.task || t.id === argv.task) : runnable.find((t) => t.kind === "itera") ?? runnable[0];
    must(chosen, `task ${argv.task} not found`);
    must(chosen.runnable, `task ${chosen.slug} is not runnable`);
    S.task = chosen;
    const d = await http("GET", `/tasks/${chosen.slug}`, { token: S.token });
    must(d.status === 200 && d.json?.task?.id === chosen.id, `/tasks/${chosen.slug} -> ${d.status}`);
    S.taskDetail = d.json.task;
    const mine = await http("GET", "/tasks?source=mine", { token: S.token });
    must(mine.status === 200 && mine.json.tasks.every((t: any) => t.mine === true), "source=mine returned a task that is not mine");
    const nope = await http("GET", "/tasks/this-task-does-not-exist-e2e");
    must(nope.status === 404, `unknown task -> ${nope.status}`);
    f.total = tasks.length;
    f.runnable = runnable.length;
    f.counts = r.json.counts;
    f.chosen = chosen.slug;
    return `${tasks.length} tasks, ${runnable.length} runnable, chosen ${chosen.slug}`;
  });
  await step("catalog", "GET /tags (tool and concept kinds, counts)", async (f) => {
    const r = await http("GET", "/tags");
    must(r.status === 200 && r.json.tags.length > 0, `/tags -> ${r.status}`);
    const kinds = new Set(r.json.tags.map((t: any) => t.kind));
    must(kinds.has("tool") && kinds.has("concept"), `kinds ${[...kinds].join(",")}`);
    must(r.json.tags.every((t: any) => Number.isInteger(t.count)), "a tag lacks an integer count");
    const tool = await http("GET", "/tags?kind=tool");
    must(tool.json.tags.every((t: any) => t.kind === "tool"), "kind filter leaks");
    f.tags = r.json.tags.length;
    return `${r.json.tags.length} tags`;
  });
  await step("catalog", "GET /models (DB-backed, releases) and the per-task cost estimate", async (f) => {
    const r = await http("GET", "/models");
    must(r.status === 200 && r.json.source === "db" && r.json.models.length > 0, `/models -> ${r.status} source=${r.json?.source}`);
    must(r.json.models.every((m: any) => m.id && Array.isArray(m.releases)), "a model lacks releases");
    must(r.json.syncedAt && Date.now() - Date.parse(r.json.syncedAt) < 24 * 3600_000, `models.syncedAt is stale: ${r.json.syncedAt}`);
    S.model = r.json.default;
    f.models = r.json.models.length;
    f.default = r.json.default;
    f.syncedAt = r.json.syncedAt;
    const v = need(S.taskDetail?.latestVersion, "a task version");
    const est = await http("GET", `/models/${encodeURIComponent(S.model!)}/estimate?task=${encodeURIComponent(v.packId)}&version=${encodeURIComponent(v.packVersion)}`);
    must(est.status === 200 && typeof est.json.estimatedCostUsd === "number", `estimate -> ${est.status} ${est.text.slice(0, 120)}`);
    f.estimate = { basis: est.json.basis, estimatedCostUsd: est.json.estimatedCostUsd };
    const access = await http("GET", `/models/${S.model}/access`);
    must(access.status === 200 && access.json.accessible === true, `access -> ${access.status}`);
    return `${r.json.models.length} models, default ${S.model}, estimate $${est.json.estimatedCostUsd} (${est.json.basis})`;
  });

  // -- 4b. Faucet (--sample): the fresh wallet gets test SOL ----------------------------------------
  if (SAMPLE) {
    await step("faucet", "POST /faucet funds the fresh wallet; a second call is refused", async (f) => {
      const token = need(S.token, "a session");
      const g = await http("POST", "/faucet", { token });
      must(g.status === 200 && typeof g.json?.txSig === "string", `POST /faucet -> ${g.status} ${g.text.slice(0, 160)}`);
      f.txSig = g.json.txSig;
      f.lamports = g.json.lamports;
      const deadline = Date.now() + 60_000;
      let bal = 0;
      while ((bal = await conn.getBalance(wallet.keypair.publicKey, "confirmed")) < g.json.lamports) {
        must(Date.now() < deadline, `balance ${bal} after 60 s`);
        await sleep(2_000);
      }
      const again = await http("POST", "/faucet", { token });
      must(again.status === 409 || again.status === 429, `second POST /faucet -> ${again.status}`);
      f.secondCall = again.status;
      return `${g.json.sol} SOL, tx ${g.json.txSig.slice(0, 8)}…, second call ${again.status}`;
    });
  }

  // -- 5. GitHub routes (App installation owned by the wallet; --sample: none, the sample repo) ------------
  const [owner, repoName] = REPO.split("/");
  await step("github", SAMPLE ? `no installation on this wallet; GET /github/sample-repos lists ${REPO}` : `GET /github/installations and /github/repos include ${REPO}`, async (f) => {
    if (AGENT_ID) skip("--agent-id: the agent is a fixture; the GitHub App is not used");
    const token = need(S.token, "a session");
    const i = await http("GET", "/github/installations", { token });
    must(i.status === 200, `/github/installations -> ${i.status}`);
    if (SAMPLE) {
      must(i.json.installations.length === 0, "the fresh wallet has an installation");
      const sr = await http("GET", "/github/sample-repos");
      must(sr.status === 200 && sr.json.agents.includes(REPO.toLowerCase()), `${REPO} is not a sample agent repo`);
      f.installations = 0;
      return "0 installations; sample repo listed";
    }
    must(i.json.installations.some((x: any) => String(x.installationId) === argv["installation-id"]), `installation ${argv["installation-id"]} is not bound to this wallet`);
    const r = await http("GET", "/github/repos", { token });
    must(r.status === 200 && r.json.repos.some((x: any) => x.fullName === REPO || x.full_name === REPO), `${REPO} is not in /github/repos (${r.json?.repos?.map((x: any) => x.fullName ?? x.full_name).join(",")})`);
    f.installations = i.json.installations.length;
    f.repos = r.json.repos.length;
  });
  let defaultBranch = "main";
  let headSha = "";
  await step("github", "GET branches (default first) and commits (HEAD first, <= 20)", async (f) => {
    if (AGENT_ID) skip("--agent-id: the agent is a fixture; the GitHub App is not used");
    const token = need(S.token, "a session");
    const b = await http("GET", `/github/repos/${owner}/${repoName}/branches`, { token });
    must(b.status === 200 && b.json.branches.length > 0, `branches -> ${b.status} ${b.text.slice(0, 120)}`);
    must(b.json.branches[0].isDefault === true, "the default branch is not first");
    defaultBranch = b.json.defaultBranch;
    const c = await http("GET", `/github/repos/${owner}/${repoName}/commits?branch=${encodeURIComponent(defaultBranch)}&limit=20`, { token });
    must(c.status === 200 && c.json.commits.length > 0 && c.json.commits.length <= 20, `commits -> ${c.status}`);
    must(c.json.commits[0].isHead === true && c.json.commits[0].sha === c.json.headSha, "first commit is not HEAD");
    headSha = c.json.headSha;
    const bad = await http("GET", `/github/repos/${owner}/${repoName}/commits?branch=${encodeURIComponent("../x")}`, { token });
    must(bad.status === 400, `invalid branch -> ${bad.status}`);
    f.branches = b.json.branches.map((x: any) => x.name);
    f.head = headSha.slice(0, 7);
    return `${b.json.branches.length} branches, HEAD ${headSha.slice(0, 7)}`;
  });
  await step("github", "GET agent-candidates and POST /agents/validate (ok, summary, files)", async (f) => {
    if (AGENT_ID) skip("--agent-id: the agent is a fixture; the GitHub App is not used");
    const token = need(S.token, "a session");
    const c = await http("GET", `/github/repos/${owner}/${repoName}/agent-candidates`, { token });
    must(c.status === 200 && c.json.candidates.length > 0, `agent-candidates -> ${c.status}`);
    const agentPath = c.json.candidates[0].path ?? ".";
    f.agentPath = agentPath;
    const v = await http("POST", "/agents/validate", { token, body: { repoFullName: REPO, agentPath, branch: defaultBranch, commit: headSha || undefined, ...(SAMPLE ? { source: "sample" } : {}) } });
    must(v.status === 200 && v.json.ok === true && v.json.files.length > 0, `validate -> ${v.status} ${v.text.slice(0, 160)}`);
    must(v.json.commit === (headSha || v.json.commit) && typeof v.json.summary === "string", "validate lacks commit or summary");
    f.summary = v.json.summary;
    const foreign = await http("POST", "/agents/validate", { token, body: { repoFullName: "devfellowship/not-bound-to-this-wallet" } });
    must(foreign.status >= 400 && foreign.status < 500, `validate on an unbound repo -> ${foreign.status}`);
    return v.json.summary;
  });

  // -- 6. Agent -------------------------------------------------------------------------------------------
  if (AGENT_ID) {
    await step("agent", `GET /agents/:id of the fixture agent ${AGENT_ID.slice(0, 8)}..., GET /agents, another wallet gets 404`, async (f) => {
      const token = need(S.token, "a session");
      const one = await http("GET", `/agents/${AGENT_ID}`, { token });
      must(one.status === 200 && one.json?.agent?.id === AGENT_ID, `GET /agents/${AGENT_ID} -> ${one.status} ${one.text.slice(0, 200)}`);
      must(one.json.agent.ownerWallet === wallet.address, "the fixture agent is not owned by the wallet");
      S.agent = one.json.agent;
      const list = await http("GET", "/agents", { token });
      must(list.status === 200 && list.json.agents.some((a: any) => a.id === AGENT_ID), "agent missing from GET /agents");
      const other = await http("GET", `/agents/${AGENT_ID}`, { token: S.strangerToken ?? (S.strangerToken = (await login(stranger)).token) });
      must(other.status === 404, `another wallet reads the agent -> ${other.status}`);
      f.agentId = AGENT_ID;
      f.slug = S.agent.slug;
      f.model = S.agent.model;
      return `agent ${AGENT_ID} slug ${S.agent.slug ?? "-"} model ${S.agent.model}`;
    });
  }
  await step("agent", "POST /agents (upsert on repo and path), GET /agents/:id, GET /agents", async (f) => {
    if (AGENT_ID) skip("--agent-id: the agent is a fixture; POST /agents needs the GitHub App");
    const token = need(S.token, "a session");
    const model = need(S.model, "a model");
    const src = SAMPLE ? { source: "sample" } : {};
    const created = await http("POST", "/agents", { token, body: { repoFullName: REPO, agentPath: ".", branch: defaultBranch, model, visibility: "listed", name: "testmyagent-demo-agent", description: "Demo agent kept by the API e2e script.", ...src } });
    must(created.status === 201 && UUID_RE.test(created.json?.agent?.id ?? ""), `POST /agents -> ${created.status} ${created.text.slice(0, 200)}`);
    if (SAMPLE) must(created.json.agent.source === "sample" && created.json.agent.ownerWallet === wallet.address, "the sample agent is not source sample / owned by the fresh wallet");
    S.agent = created.json.agent;
    must(created.json.pinned?.commitSha, "no pinned commit");
    const again = await http("POST", "/agents", { token, body: { repoFullName: REPO, agentPath: ".", branch: defaultBranch, model, visibility: "listed", name: "testmyagent-demo-agent", ...src } });
    must(again.status === 201 && again.json.agent.id === S.agent.id, "POST /agents is not idempotent on repo + path");
    const one = await http("GET", `/agents/${S.agent.id}`, { token });
    must(one.status === 200 && one.json.agent.id === S.agent.id, `GET /agents/:id -> ${one.status}`);
    const list = await http("GET", "/agents", { token });
    must(list.status === 200 && list.json.agents.some((a: any) => a.id === S.agent.id), "agent missing from GET /agents");
    const other = await http("GET", `/agents/${S.agent.id}`, { token: S.strangerToken ?? (S.strangerToken = (await login(stranger)).token) });
    must(other.status === 404, `another wallet reads the agent -> ${other.status}`);
    f.agentId = S.agent.id;
    f.slug = S.agent.slug;
    f.pinned = created.json.pinned;
    return `agent ${S.agent.id} slug ${S.agent.slug ?? "-"} pinned ${created.json.pinned.shortSha}`;
  });
  await step("agent", "GET /agents/:idOrSlug/profile (owner view), my-results, and the ranking", async (f) => {
    const token = need(S.token, "a session");
    const agent = need(S.agent, "an agent");
    const key = agent.slug ?? agent.id;
    const p = await http("GET", `/agents/${key}/profile`, { token });
    must(p.status === 200 && p.json?.agent, `profile -> ${p.status} ${p.text.slice(0, 120)}`);
    f.profileKeys = Object.keys(p.json);
    must(p.json.price && typeof p.json.price.usdPerRun === "number", "profile lacks price");
    const mr = await http("GET", `/agents/${key}/my-results`, { token });
    must(mr.status === 200, `my-results -> ${mr.status}`);
    const rk = await http("GET", `/agents/ranking?scope=all&taskIds=${S.task?.id ?? ""}`, { token });
    must(rk.status === 200 && Array.isArray(rk.json.rows ?? rk.json.agents ?? rk.json.ranking), `ranking -> ${rk.status} ${rk.text.slice(0, 160)}`);
    const unauth = await http("GET", "/agents/ranking");
    must(unauth.status === 401, `ranking without a session -> ${unauth.status}`);
    f.rankingKeys = Object.keys(rk.json);
  });
  await step("agent", "negative: unknown agent profile answers 404", async () => {
    const a = await http("GET", "/agents/no-such-agent-e2e-xyz/profile");
    const b = await http("GET", `/agents/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}/profile`);
    must(a.status === 404 && b.status === 404, `slug ${a.status}, uuid ${b.status}`);
  });

  // -- 7. Quote ---------------------------------------------------------------------------------------------
  await step("quote", "negative: POST /evaluations/quote without a session answers 401", async () => {
    const r = await http("POST", "/evaluations/quote", { body: { agentId: "x", taskIds: ["x"] } });
    must(r.status === 401, `-> ${r.status}`);
  });
  await step("quote", `POST /evaluations/quote: recipient is the treasury ${TREASURY.slice(0, 6)}..., price itemized (estimate + US$${BASE_FEE_USD.toFixed(2)} per run)`, async (f) => {
    const token = need(S.token, "a session");
    const agent = need(S.agent, "an agent");
    const task = need(S.task, "a task");
    const q = await http("POST", "/evaluations/quote", { token, body: { agentId: agent.id, taskIds: [task.id] } });
    must(q.status === 201, `quote -> ${q.status} ${q.text.slice(0, 200)}`);
    const j = q.json;
    S.quote = j;
    must(j.treasury === TREASURY, `treasury ${j.treasury} is not the new treasury`);
    must(typeof j.transferUrl === "string" && j.transferUrl.startsWith(`solana:${TREASURY}`), `transferUrl does not point at the treasury: ${String(j.transferUrl).slice(0, 80)}`);
    must(j.taskCount === 1 && j.tasks.length === 1, "taskCount");
    must(approx(j.baseFeeUsd, BASE_FEE_USD * j.taskCount), `baseFeeUsd ${j.baseFeeUsd} != ${BASE_FEE_USD} x ${j.taskCount}`);
    must(j.modelCostEstimateUsd >= 0, "modelCostEstimateUsd < 0");
    const perTask = j.tasks[0];
    must(approx(perTask.baseFeeUsd, BASE_FEE_USD), `task baseFeeUsd ${perTask.baseFeeUsd}`);
    // priceUsd = estimate + base fee, rounded up to the cent.
    const raw = perTask.modelCostEstimateUsd + perTask.baseFeeUsd;
    must(perTask.priceUsd >= raw - 1e-9 && perTask.priceUsd < raw + 0.01 + 1e-9, `task priceUsd ${perTask.priceUsd} is not ceil-to-cent of ${raw}`);
    must(approx(j.totalUsd, perTask.priceUsd, 1e-4), `totalUsd ${j.totalUsd} != task priceUsd ${perTask.priceUsd}`);
    must(approx(j.amountUsd, j.totalUsd, 1e-6), "amountUsd != totalUsd");
    must(j.solUsd > 1 && j.solUsd < 10_000 && ["pyth", "coingecko"].includes(j.priceSource), `rate ${j.solUsd} source ${j.priceSource}`);
    const expectLamports = Math.ceil((j.totalUsd / j.solUsd) * 1e9);
    must(Math.abs(j.totalLamports - expectLamports) <= 1, `totalLamports ${j.totalLamports} != ceil(usd/rate) ${expectLamports}`);
    must(j.amountLamports === j.totalLamports, "amountLamports != totalLamports");
    const ttl = Date.parse(j.expiresAt) - Date.now();
    must(ttl > 30_000 && ttl <= 125_000, `quote window ${Math.round(ttl / 1000)} s is outside (30, 125]`);
    must(j.memo?.startsWith("itera-eval:v1:") || typeof j.memo === "string", "no memo");
    must(UUID_RE.test(j.evaluationId) && j.runIds.length === 1, "planned ids");
    f.treasury = j.treasury;
    f.priceSource = j.priceSource;
    f.solUsd = j.solUsd;
    f.itemization = { modelCostEstimateUsd: j.modelCostEstimateUsd, baseFeeUsd: j.baseFeeUsd, totalUsd: j.totalUsd, totalLamports: j.totalLamports, sol: j.sol, estimateBasis: perTask.estimateBasis };
    return `$${j.modelCostEstimateUsd} estimate + $${j.baseFeeUsd} fee = $${j.totalUsd} = ${j.sol} SOL @ ${j.solUsd} (${j.priceSource})`;
  });
  await step("quote", "negative: a quote of another wallet cannot be turned into a payment tx (404) or paid for it (403)", async () => {
    const q = need(S.quote, "a quote");
    S.strangerToken ??= (await login(stranger)).token;
    const tx = await http("POST", `/evaluations/quote/${q.reference}/transaction`, { token: S.strangerToken, body: {} });
    must(tx.status === 404, `transaction for another wallet's quote -> ${tx.status}`);
    const pay = await http("POST", "/evaluations", { token: S.strangerToken, body: { reference: q.reference } });
    must(pay.status === 403, `POST /evaluations with another wallet's quote -> ${pay.status}`);
  });
  await step("quote", "negative: unpaid quote answers 402 payment_not_found", async () => {
    const q = need(S.quote, "a quote");
    const r = await http("POST", "/evaluations", { token: S.token, body: { reference: q.reference } });
    must(r.status === 402 && r.json?.code === "payment_not_found", `-> ${r.status} ${r.text.slice(0, 160)}`);
  });
  await step("quote", "negative: a confirmed transaction of another wallet does not pay the quote (402)", async () => {
    const q = need(S.quote, "a quote");
    // Any confirmed transaction signed by a wallet other than ours: the treasury's history first,
    // then the Pyth SOL/USD push account (its updates are signed by Pyth's publishers).
    let foreign: string | null = null;
    for (const address of [TREASURY, "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"]) {
      const sigs = await conn.getSignaturesForAddress(new PublicKey(address), { limit: 40 });
      for (const s of sigs) {
        if (s.err) continue;
        // Some transactions use a version this RPC client does not decode: try the next one.
        const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
        const payer = tx?.transaction.message.staticAccountKeys?.[0]?.toBase58();
        if (payer && payer !== wallet.address) {
          foreign = s.signature;
          break;
        }
      }
      if (foreign) break;
    }
    if (!foreign) skip("no confirmed treasury transaction from another wallet to replay");
    const r = await http("POST", "/evaluations", { token: S.token, body: { reference: q.reference, txSig: foreign } });
    // 402 (not this quote) or 409 (that tx already paid another quote): both refuse the replay.
    must(r.status === 402 || r.status === 409, `foreign txSig -> ${r.status} ${r.text.slice(0, 160)}`);
  });

  // -- 8. Pay ---------------------------------------------------------------------------------------------------
  await step("pay", "POST /evaluations/quote/:reference/transaction builds one tx; it transfers the quoted lamports to the treasury", async (f) => {
    const q = need(S.quote, "a quote");
    if (argv["no-pay"]) skip("--no-pay");
    if (argv.evaluation) skip("--evaluation: re-verifying a paid evaluation");
    S.balanceBefore = await conn.getBalance(wallet.keypair.publicKey, "confirmed");
    must(S.balanceBefore >= q.totalLamports + 20_000, `wallet holds ${S.balanceBefore} lamports, needs ${q.totalLamports} + fees: fund it first`);
    f.balanceBeforeLamports = S.balanceBefore;
    if (Date.parse(q.expiresAt) - Date.now() < 15_000) {
      const fresh = await http("POST", "/evaluations/quote", { token: S.token, body: { agentId: S.agent.id, taskIds: [S.task.id] } });
      must(fresh.status === 201, "re-quote failed");
      S.quote = fresh.json;
      f.requoted = true;
    }
    const quote = S.quote;
    const r = await http("POST", `/evaluations/quote/${quote.reference}/transaction`, { token: S.token, body: { account: wallet.address } });
    must(r.status === 200 && typeof r.json?.transaction === "string", `transaction -> ${r.status} ${r.text.slice(0, 160)}`);
    const tx = Transaction.from(Buffer.from(r.json.transaction, "base64"));
    must(tx.feePayer?.toBase58() === wallet.address, "fee payer is not the wallet");
    const transfers = tx.instructions.filter((ix) => ix.programId.equals(SystemProgram.programId));
    must(transfers.length === 1, `expected one system instruction, found ${transfers.length}`);
    const ix = transfers[0]!;
    must(ix.data.readUInt32LE(0) === 2, "system instruction is not a transfer");
    const lamports = Number(ix.data.readBigUInt64LE(4));
    must(ix.keys[1]!.pubkey.toBase58() === TREASURY, `transfer recipient ${ix.keys[1]!.pubkey.toBase58()}`);
    must(lamports === quote.totalLamports, `transfer ${lamports} lamports != quote ${quote.totalLamports}`);
    must(ix.keys.some((k) => k.pubkey.toBase58() === quote.reference), "the Solana Pay reference is not in the transfer");
    must(tx.instructions.some((i) => i.programId.toBase58() === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), "no Memo instruction");
    tx.partialSign(wallet.keypair);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
    S.txSig = sig;
    const deadline = Date.now() + 60_000;
    for (;;) {
      const st = (await conn.getSignatureStatuses([sig])).value[0];
      if (st?.err) throw new Assertion(`payment tx failed on chain: ${JSON.stringify(st.err)}`);
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) break;
      must(Date.now() < deadline, "payment tx not confirmed in 60 s");
      await sleep(1_000);
    }
    f.txSig = sig;
    f.lamports = lamports;
    return `tx ${sig.slice(0, 12)}... ${lamports} lamports -> treasury`;
  });

  // -- 9. Evaluation ----------------------------------------------------------------------------------------------
  if (argv.evaluation) {
    await step("evaluation", `resume: load the paid evaluation ${argv.evaluation}`, async (f) => {
      const r = await http("GET", `/evaluations/${argv.evaluation}`, { token: S.token });
      must(r.status === 200, `GET /evaluations/${argv.evaluation} -> ${r.status} (is it owned by this wallet?)`);
      S.evaluationId = r.json.id;
      S.runIds = r.json.tasks.map((t: any) => t.runId);
      S.txSig = r.json.fee.txSig;
      S.feeLamports = r.json.fee.lamports;
      f.runIds = S.runIds;
      f.txSig = S.txSig;
      return `evaluation ${S.evaluationId}, fee ${S.feeLamports} lamports`;
    });
  }
  await step("evaluation", "POST /evaluations with the reference and txSig answers 202 and queues the run", async (f) => {
    if (argv.evaluation) skip("--evaluation: already paid");
    const q = need(S.quote, "a quote");
    const txSig = need(S.txSig, "a payment");
    const r = await http("POST", "/evaluations", { token: S.token, body: { reference: q.reference, txSig } });
    must(r.status === 202, `POST /evaluations -> ${r.status} ${r.text.slice(0, 200)}`);
    must(UUID_RE.test(r.json.evaluationId) && r.json.runs.length === 1, "evaluation id or runs");
    must(r.json.evaluationId === q.evaluationId, "evaluation id differs from the quote's planned id");
    S.evaluationId = r.json.evaluationId;
    S.runIds = r.json.runs.map((x: any) => x.runId);
    S.feeLamports = q.totalLamports;
    f.evaluationId = S.evaluationId;
    f.runIds = S.runIds;
    return `evaluation ${S.evaluationId}`;
  });
  await step("evaluation", "idempotency: the same reference or the same txSig returns the same evaluation (200)", async () => {
    if (argv.evaluation) skip("--evaluation: the quote of the payment is not available");
    const q = need(S.quote, "a quote");
    const id = need(S.evaluationId, "an evaluation");
    const a = await http("POST", "/evaluations", { token: S.token, body: { reference: q.reference, txSig: S.txSig } });
    const b = await http("POST", "/evaluations", { token: S.token, body: { txSig: S.txSig } });
    must(a.status === 200 && a.json.evaluationId === id, `same reference -> ${a.status}`);
    must(b.status === 200 && b.json.evaluationId === id, `same txSig -> ${b.status}`);
  });
  await step("evaluation", "negative: another wallet cannot read the evaluation (404) and no session answers 401", async () => {
    const id = need(S.evaluationId, "an evaluation");
    S.strangerToken ??= (await login(stranger)).token;
    const a = await http("GET", `/evaluations/${id}`, { token: S.strangerToken });
    const b = await http("GET", `/evaluations/${id}`);
    const c = await http("GET", "/evaluations");
    must(a.status === 404, `stranger -> ${a.status}`);
    must(b.status === 401 && c.status === 401, `no session -> ${b.status}, ${c.status}`);
  });
  await step("evaluation", "poll GET /evaluations/:id queued -> running -> issuing -> issued (schema-valid on every poll)", async (f) => {
    const id = need(S.evaluationId, "an evaluation");
    const seen: string[] = [];
    const t0 = Date.now();
    let last: any = null;
    for (;;) {
      const r = await http("GET", `/evaluations/${id}`, { token: S.token });
      must(r.status === 200, `poll -> ${r.status}`);
      const v = validateApiResponse("evaluationView", r.json);
      must(v.ok, `evaluationView schema: ${v.ok ? "" : v.errors.slice(0, 3).join("; ")}`);
      last = r.json;
      if (seen[seen.length - 1] !== r.json.uiState) {
        seen.push(r.json.uiState);
        console.log(`     ... uiState ${r.json.uiState} (status ${r.json.status}) after ${Math.round((Date.now() - t0) / 1000)} s`);
      }
      if (["issued", "error", "cancelled"].includes(r.json.uiState)) break;
      must(Date.now() - t0 < POLL_TIMEOUT_MS, `not issued after ${Math.round(POLL_TIMEOUT_MS / 60000)} min; last uiState ${r.json.uiState}`);
      await sleep(5_000);
    }
    S.evaluation = last;
    f.states = seen;
    f.seconds = Math.round((Date.now() - t0) / 1000);
    f.status = last.status;
    f.counts = last.counts;
    f.taskStates = last.tasks.map((t: any) => ({ slug: t.slug ?? t.name, status: t.status, outcome: t.outcome, score: t.score }));
    must(last.uiState === "issued", `ended in uiState ${last.uiState} (status ${last.status}); tasks ${JSON.stringify(f.taskStates)}`);
    must(seen[0] === "queued" || seen[0] === "running" || seen[0] === "issuing" || seen[0] === "issued", `first state ${seen[0]}`);
    must(/^[0-9a-f]{64}$/.test(last.manifestSha256 ?? ""), "manifestSha256 missing on an issued evaluation");
    must(last.proofs.length === 1 && last.proofs.every((p: any) => p.status === "confirmed"), `proofs ${JSON.stringify(last.proofs)}`);
    S.slug = last.slug;
    S.hash = last.manifestSha256;
    return `states ${seen.join(" -> ")} in ${f.seconds} s, slug ${last.slug}`;
  });

  // -- 10. Run detail -----------------------------------------------------------------------------------------------------
  await step("run", "GET /runs/:id: result, evidence, no tmp paths, schema-valid (runDetail)", async (f) => {
    const runId = need(S.runIds?.[0], "a run");
    need(S.evaluation, "a finished evaluation");
    const r = await http("GET", `/runs/${runId}`);
    must(r.status === 200, `/runs/${runId} -> ${r.status}`);
    S.run = r.json;
    const v = validateApiResponse("runDetail", r.json);
    must(v.ok, `runDetail schema: ${v.ok ? "" : v.errors.slice(0, 4).join("; ")}`);
    must(["pass", "fail", "invalid"].includes(r.json.status), `run status ${r.json.status}`);
    must(r.json.result.state === "completed" && r.json.result.scored === true, `result ${JSON.stringify(r.json.result)}`);
    must(r.json.ownerWallet === wallet.address, "run owner is not the wallet");
    must(r.json.tests && r.json.tests.hidden.total > 0, "no hidden tests counted (zero tests must never pass)");
    must(Object.keys(r.json.tests.hidden).sort().join() === "failed,passed,total", "hidden tests expose more than counts");
    must(r.json.score.parts && Object.keys(r.json.score.parts).length === 5, "score has no five parts");
    must(r.json.evidence && r.json.evidence.executorProfile && r.json.evidence.environmentDigest, `evidence ${JSON.stringify(r.json.evidence)}`);
    must(!PATH_LEAK_RE.test(JSON.stringify(r.json)), `a server path leaks in the run detail: ${(JSON.stringify(r.json).match(PATH_LEAK_RE) ?? [""])[0]}`);
    must(!JSON.stringify(r.json).includes("hidden/"), "a hidden test path leaks");
    must(r.json.proof?.status === "confirmed" && r.json.proof.nftMint && r.json.proof.txSig, `proof ${JSON.stringify(r.json.proof)}`);
    must(typeof r.json.modelCostUsd === "number" || r.json.modelCostUsd === null, "modelCostUsd");
    f.status = r.json.status;
    f.scoreTotal = r.json.scoreTotal;
    f.hidden = r.json.tests.hidden;
    f.public = { total: r.json.tests.public.total, passed: r.json.tests.public.passed };
    f.modelCostUsd = r.json.modelCostUsd;
    f.actionsCount = r.json.actionsCount;
    f.executorProfile = r.json.evidence.executorProfile;
    return `${r.json.status} score ${r.json.scoreTotal}, hidden ${r.json.tests.hidden.passed}/${r.json.tests.hidden.total}, cost $${r.json.modelCostUsd}`;
  });
  await step("run", "ADR-5 outcome rule: PASS only when every hidden test passed and the patch scope is clean", async (f) => {
    const run = need(S.run, "a run");
    const h = run.tests.hidden;
    f.status = run.status;
    f.hidden = h;
    f.scopeAllowed = run.patchScope?.allowed;
    if (run.status === "pass") {
      must(h.failed === 0 && h.passed === h.total, `status is pass but ${h.failed} of ${h.total} hidden tests failed (score ${run.scoreTotal}); services/runner/src/outcome.ts finalStatus() passes any score_total > 0`);
      must(run.patchScope?.allowed === true, "status is pass but the patch scope is not allowed");
    } else if (run.status === "fail") {
      must(h.failed > 0 || run.patchScope?.changedFiles?.length === 0, "status is fail but no hidden test failed");
    }
    return `${run.status}, hidden ${h.passed}/${h.total}`;
  });
  await step("run", "GET /runs/:id/actions (when the route exists): ordered tool calls, no paths", async (f) => {
    const runId = need(S.runIds?.[0], "a run");
    const r = await http("GET", `/runs/${runId}/actions`, { token: S.token });
    if (r.status === 404 && !routes.some((x) => x.includes("/runs/:id/actions"))) skip("route not deployed on this API (not in GET / routes)");
    must(r.status === 200, `/runs/:id/actions -> ${r.status} ${r.text.slice(0, 120)}`);
    const list: any[] = r.json.actions ?? r.json;
    must(Array.isArray(list), "no actions array");
    must(!PATH_LEAK_RE.test(JSON.stringify(list)), "a server path leaks in actions");
    f.actions = list.length;
    f.actionsCount = S.run?.actionsCount;
    if (S.run?.actionsCount !== undefined) must(list.length === S.run.actionsCount || list.length > 0, "action count mismatch");
    return `${list.length} actions`;
  });

  // -- 11. Proof ---------------------------------------------------------------------------------------------------------------
  await step("proof", "GET /proofs/:hash and the NFT mint exists on devnet", async (f) => {
    const run = need(S.run, "a run");
    const hash = run.proof.proofHash;
    const p = await http("GET", `/proofs/${hash}`);
    must(p.status === 200 && p.json.proofHash === hash && p.json.status === "confirmed", `proofs -> ${p.status} ${p.text.slice(0, 120)}`);
    must(p.json.runId === run.runId, "proof is for another run");
    const mint = await conn.getAccountInfo(new PublicKey(run.proof.nftMint), "confirmed");
    must(mint, `NFT mint ${run.proof.nftMint} not found on devnet`);
    const sig = await conn.getSignatureStatuses([run.proof.txSig], { searchTransactionHistory: true });
    must(sig.value[0] && !sig.value[0].err, "attestation tx not found or failed");
    const none = await http("GET", `/proofs/${"0".repeat(64)}`);
    must(none.status === 404, `unknown proof -> ${none.status}`);
    f.proofHash = hash;
    f.nftMint = run.proof.nftMint;
    f.attestationTx = run.proof.txSig;
    f.proofKeys = Object.keys(p.json);
    return `proof ${hash.slice(0, 12)}..., mint ${run.proof.nftMint.slice(0, 8)}...`;
  });
  await step("proof", `verify: apps/web/src/verify.ts on the NFT mint (chain + IPFS only) says VERIFIED${argv["verify-strict"] ? ", every check passes" : ""}`, async (f) => {
    const run = need(S.run, "a run");
    const mint = need(run.proof?.nftMint as string | undefined, "an NFT mint");
    const gateway = argv["ipfs-gateway"] || IPFS_GATEWAY_URL;
    const report = await runVerification(createSolanaRpc(argv.rpc!) as never, mint as never, { ipfsGatewayUrl: gateway });
    f.checks = report.checks.map((c) => ({ id: c.id, status: c.status, detail: c.detail.slice(0, 160) }));
    f.gateway = gateway;
    const failed = report.checks.filter((c) => c.status === "fail");
    must(report.overall === "VERIFIED" && failed.length === 0, `${report.overall}: ${failed.map((c) => `${c.id} (${c.detail})`).join("; ")}`);
    must(report.manifestSha256 === S.hash, `on-chain manifest_sha256 ${report.manifestSha256} != evaluation hash ${S.hash}`);
    const skipped = report.checks.filter((c) => c.status === "skip");
    if (argv["verify-strict"]) must(skipped.length === 0, `skipped checks: ${skipped.map((c) => `${c.id} (${c.detail})`).join("; ")}`);
    for (const id of ["mint-exists", "non-transferable", "known-schema", "known-credential", "nonce-binding", "single-holder"]) {
      must(report.checks.some((c) => c.id === id && c.status === "pass"), `check ${id} did not pass`);
    }
    return `${report.overall}: ${report.checks.filter((c) => c.status === "pass").length} pass, ${skipped.length} skip`;
  });
  await step("proof", "GET /leaderboard?benchmark= lists the agent (best run per agent) with a proof link", async (f) => {
    const run = need(S.run, "a run");
    const r = await http("GET", `/leaderboard?benchmark=${encodeURIComponent(run.benchmark.id)}&version=${encodeURIComponent(run.benchmark.version ?? "")}`);
    must(r.status === 200 && Array.isArray(r.json.entries), `leaderboard -> ${r.status}`);
    // One row per agent: its best score (an earlier run with the same score keeps the row).
    const hit = r.json.entries.find((e: any) => e.agentId === run.agentId);
    must(hit, `the agent is not in the leaderboard (${r.json.entries.length} entries)`);
    must(hit.scoreTotal >= run.scoreTotal, `leaderboard score ${hit.scoreTotal} < run score ${run.scoreTotal}`);
    must(/^[0-9a-f]{64}$/.test(hit.proofHash) && hit.proofUrl?.endsWith(`/proof/${hit.proofHash}`), "leaderboard row lacks a proof link");
    f.row = { rank: hit.rank, scoreTotal: hit.scoreTotal, runId: hit.runId };
    f.entries = r.json.entries.length;
    const noBench = await http("GET", "/leaderboard");
    must(noBench.status === 400, `leaderboard without benchmark -> ${noBench.status}`);
  });

  // -- 12. Public profile --------------------------------------------------------------------------------------------------------------
  await step("public", "GET /public/evaluations/:slug and /:hash answer 200 logged out, with the same content", async (f) => {
    const slug = need(S.slug, "a slug");
    const hash = need(S.hash, "a manifest hash");
    const a = await http("GET", `/public/evaluations/${slug}`);
    const b = await http("GET", `/public/evaluations/${hash}`);
    must(a.status === 200 && b.status === 200, `slug ${a.status}, hash ${b.status}`);
    must(a.json.slug === b.json.slug && a.json.hash === b.json.hash, "slug and hash profiles differ");
    must(a.json.hash === hash, "profile hash differs from the evaluation manifest hash");
    must(Array.isArray(a.json.tasks) && a.json.tasks.length === 1, "profile tasks");
    must(!PATH_LEAK_RE.test(a.text), "a server path leaks in the public profile");
    f.keys = Object.keys(a.json);
    f.score = a.json.score;
    f.counts = a.json.counts;
    const manifest = await http("GET", `/public/evaluations/${slug}/manifest.json`);
    must(manifest.status === 200, `manifest.json -> ${manifest.status}`);
    const unknown = await http("GET", "/public/evaluations/no-such-evaluation-e2e");
    must(unknown.status === 404, `unknown public evaluation -> ${unknown.status}`);
    return `score ${a.json.score}, ${JSON.stringify(a.json.counts)}`;
  });
  await step("public", "GET .../og.png is a 1200x630 PNG", async (f) => {
    const slug = need(S.slug, "a slug");
    for (const base of [API]) {
      const path = `/public/evaluations/${slug}/og.png`;
      const r = await http("GET", path, { base });
      must(r.status === 200 && (r.headers.get("content-type") ?? "").startsWith("image/png"), `${path} -> ${r.status} ${r.headers.get("content-type")}`);
      must(r.bytes.subarray(1, 4).toString() === "PNG", "not a PNG");
      const w = r.bytes.readUInt32BE(16);
      const h = r.bytes.readUInt32BE(20);
      must(w === 1200 && h === 630, `size ${w}x${h}`);
      f[base === API ? "apiSize" : "webSize"] = `${w}x${h}`;
      f[base === API ? "apiBytes" : "webBytes"] = r.bytes.length;
    }
  });
  await step("public", "link preview: the web host serves /e/:slug HTML with og:title, og:image and twitter:card to a crawler", async (f) => {
    if (NO_WEB) skip("--no-web: no web host in this run");
    const slug = need(S.slug, "a slug");
    const r = await http("GET", `/e/${slug}`, { base: WEB, headers: { "user-agent": "Twitterbot/1.0" } });
    must(r.status === 200 && (r.headers.get("content-type") ?? "").includes("text/html"), `/e/${slug} -> ${r.status}`);
    for (const tag of ["og:title", "og:image", "twitter:card"]) must(r.text.includes(tag), `missing ${tag}`);
    must(/twitter:card"\s+content="summary_large_image"/.test(r.text), "twitter:card is not summary_large_image");
    const image = /property="og:image"\s+content="([^"]+)"/.exec(r.text)?.[1];
    must(image, "no og:image content");
    const img = await http("GET", image!.replace(/&amp;/g, "&"));
    must(img.status === 200 && (img.headers.get("content-type") ?? "").startsWith("image/png"), `og:image ${image} -> ${img.status}`);
    f.ogImage = image;
  });
  await step("public", "badges: /b/:slug.svg on the API and on the web host, /badge/agents/:slug.svg", async (f) => {
    const slug = need(S.slug, "a slug");
    const agentKey = need(S.agent?.slug, "an agent slug");
    for (const [base, path] of [
      [API, `/b/${slug}.svg`],
      [API, `/badge/evaluations/${slug}.svg`],
      [API, `/badge/agents/${agentKey}.svg`],
    ] as const) {
      const r = await http("GET", path, { base });
      must(r.status === 200 && (r.headers.get("content-type") ?? "").startsWith("image/svg+xml") && r.text.includes("<svg"), `${base === API ? "api" : "web"}${path} -> ${r.status} ${r.headers.get("content-type")}`);
      must(!/<script/i.test(r.text), "badge contains a script");
    }
    // The web host answers /b/:slug.svg with a 302 to the API (README badges embed the web URL).
    if (!NO_WEB) {
      const hop = await http("GET", `/b/${slug}.svg`, { base: WEB });
      must(hop.status === 302 && String(hop.headers.get("location")).startsWith(`${API}/b/${slug}.svg`), `web /b/ -> ${hop.status} ${hop.headers.get("location")}`);
    }
    const none = await http("GET", "/b/no-such-badge-e2e.svg");
    must(none.status === 404 || (none.status === 200 && none.text.includes("not found")), `unknown badge -> ${none.status}`);
  });
  await step("public", "an agent with issued evidence has a public profile (200 logged out)", async (f) => {
    need(S.evaluation, "an issued evaluation");
    const key = need(S.agent?.slug, "an agent slug");
    const r = await http("GET", `/agents/${key}/profile`);
    must(r.status === 200, `public agent profile -> ${r.status}`);
    f.keys = Object.keys(r.json);
  });

  // -- 13. My evaluations (positive control for U13) --------------------------------------------------------------------------------------------
  await step("my-evaluations", "GET /evaluations?scope=mine shows the evaluation (positive control); totals match the payments", async (f) => {
    const id = need(S.evaluationId, "an evaluation");
    const r = await http("GET", "/evaluations?scope=mine", { token: S.token });
    must(r.status === 200, `-> ${r.status}`);
    const v = validateApiResponse("evaluationList", r.json);
    must(v.ok, `evaluationList schema: ${v.ok ? "" : v.errors.slice(0, 3).join("; ")}`);
    const row = r.json.evaluations.find((e: any) => e.id === id);
    must(row, `evaluation ${id} is not in the list of ${r.json.evaluations.length}`);
    must(row.agent.isMine === true && row.status === "issued", `row ${JSON.stringify({ isMine: row.agent.isMine, status: row.status })}`);
    must(row.share.kind === "link" && row.share.url.endsWith(`/e/${S.slug}`), `share ${JSON.stringify(row.share)}`);
    must(row.feeLamports === S.feeLamports, `feeLamports ${row.feeLamports} != paid ${S.feeLamports}`);
    const sum = r.json.evaluations.reduce((a: number, e: any) => a + e.feeLamports, 0);
    must(r.json.totals.spentLamports === sum, `spentLamports ${r.json.totals.spentLamports} != sum of rows ${sum}`);
    const mine = await http("GET", "/evaluations?scope=my_agents", { token: S.token });
    const others = await http("GET", "/evaluations?scope=others", { token: S.token });
    must(mine.json.evaluations.some((e: any) => e.id === id) && !others.json.evaluations.some((e: any) => e.id === id), "scope split");
    const strangerList = await http("GET", "/evaluations?scope=all", { token: S.strangerToken });
    must(!strangerList.json.evaluations.some((e: any) => e.id === id), "another wallet sees the evaluation in its list");
    const badScope = await http("GET", "/evaluations?scope=bogus", { token: S.token });
    must(badScope.status === 400, `bad scope -> ${badScope.status}`);
    f.rows = r.json.evaluations.length;
    f.totals = r.json.totals;
    return `${r.json.evaluations.length} rows, spent ${r.json.totals.spentSol} SOL`;
  });
  await step("my-evaluations", "wallet balance fell by the fee plus the network fee only", async (f) => {
    const fee = need(S.feeLamports, "a paid fee");
    const before = need(S.balanceBefore, "a balance before paying");
    S.balanceAfter = await conn.getBalance(wallet.keypair.publicKey, "confirmed");
    const spent = before - S.balanceAfter;
    must(spent >= fee && spent <= fee + 50_000, `balance fell by ${spent} lamports for a ${fee} fee`);
    f.balanceAfterLamports = S.balanceAfter;
    f.spentLamports = spent;
    f.networkFeeLamports = spent - fee;
    return `spent ${spent} lamports (fee ${fee} + network ${spent - fee}); balance ${S.balanceAfter}`;
  });
}

// ------------------------------------------------------------------------------------------------
// Report

function report(startedAt: string): { json: unknown; md: string } {
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const r of results) counts[r.status]++;
  const json = {
    script: "scripts/e2e/api-e2e.mts",
    plan: "20261012-itera-testmyagent-ui-refactor",
    task: "U23",
    startedAt,
    finishedAt: new Date().toISOString(),
    api: API,
    web: WEB,
    wallet: wallet.address,
    repo: REPO,
    evaluation: { id: S.evaluationId ?? null, slug: S.slug ?? null, manifestSha256: S.hash ?? null, txSig: S.txSig ?? null, shareUrl: S.slug ? `${WEB}/e/${S.slug}` : null },
    counts,
    ok: counts.fail === 0 && counts.pass > 0,
    steps: results,
  };
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines: string[] = [];
  lines.push(`# API end-to-end report (U23)`, "");
  lines.push(`- API: ${API}`, `- Web: ${WEB}`, `- Wallet: \`${wallet.address}\``, `- Repo: \`${REPO}\``, `- Started: ${startedAt}`, `- Result: **${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip**`);
  if (S.slug) lines.push(`- Evaluation: \`${S.evaluationId}\` - public profile ${WEB}/e/${S.slug}`);
  if (S.txSig) lines.push(`- Payment tx: \`${S.txSig}\` ([explorer](https://explorer.solana.com/tx/${S.txSig}?cluster=devnet))`);
  lines.push("", "| # | Group | Step | Result | Time | Detail |", "|---|---|---|---|---|---|");
  for (const r of results) {
    lines.push(`| ${r.id} | ${r.group} | ${esc(r.name)} | ${r.status.toUpperCase()} | ${(r.ms / 1000).toFixed(1)} s | ${esc(r.error ?? r.detail)} |`);
  }
  lines.push("", "## Facts", "");
  for (const r of results) {
    if (Object.keys(r.facts).length === 0) continue;
    lines.push(`### ${r.id} ${r.name}`, "", "```json", JSON.stringify(r.facts, null, 2), "```", "");
  }
  return { json, md: lines.join("\n") };
}

const startedAt = new Date().toISOString();
let crashed: unknown = null;
try {
  await main();
} catch (e) {
  crashed = e;
  console.error("e2e crashed:", e);
}
mkdirSync(OUT_DIR, { recursive: true });
const { json, md } = report(startedAt);
writeFileSync(join(OUT_DIR, "api-e2e.json"), JSON.stringify(json, null, 2));
writeFileSync(join(OUT_DIR, "api-e2e.md"), md);
const c = (json as { counts: { pass: number; fail: number; skip: number } }).counts;
console.log(`\n${c.pass} pass, ${c.fail} fail, ${c.skip} skip -> ${join(OUT_DIR, "api-e2e.json")}, ${join(OUT_DIR, "api-e2e.md")}`);
process.exit(crashed || c.fail > 0 || c.pass === 0 ? 1 : 0);

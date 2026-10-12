/**
 * Browser end-to-end script (plan 20261012-itera-testmyagent-ui-refactor, task U25).
 *
 *   npm run e2e:browser -- --base https://itera-agent-credentials.devfellowship.com
 *
 * Drives the deployed web app in a real Chrome (Playwright) with the demo wallet:
 *   landing -> connect (SIWS) -> /agents (ranking, Task Filter modal) -> /agents/new (GitHub connected,
 *   repo / branch / commit / path, validate) -> agent detail + badge -> select tasks + itemized quote
 *   -> pay with ONE wallet signature -> /evaluations/:id (states, per-call log) -> issued
 *   -> public profile /e/:slug (Verify -> VERIFIED) -> owner feedback -> My evaluations -> My tasks
 *   -> task editor Environment card -> public task page /tasks/:slug.
 *
 * Wallet: no Phantom extension. A Wallet Standard test wallet is injected into the page
 * (`addInitScript`); the page sees only the public key. Every signature (SIWS message, payment
 * transaction) runs in THIS Node process through an exposed binding, so the secret key never enters
 * the page. This is the fallback the plan accepts for "Browser e2e with a wallet" (no skill automates
 * a wallet extension).
 *
 * Every page step asserts the three "verified in prod" conditions and takes a screenshot:
 *   1. MOUNT       #root is non-empty and the page's own root element is visible
 *   2. NO ERRORS   zero `pageerror` events during the step (listener armed before the first goto)
 *   3. CONTROL     a positive-data assertion (a selector that exists only when data rendered, with a minimum count)
 *
 * Secrets come from the environment and are never printed or written to the report:
 *   E2E_WALLET_SECRET_B58   base58 secret key (64 bytes) of the demo wallet. Alias: DEMO_WALLET_SECRET_B58.
 *                           It must own a GitHub App installation that holds --repo, and hold ~0.01 SOL on devnet.
 * Options:
 *   --base <web>          web origin (default production)
 *   --api <api>           API origin, for read-only cross-checks (default production)
 *   --rpc <url>           devnet RPC for the payment cross-check
 *   --repo <owner/name>   agent repo to register (default devfellowship/testmyagent-demo-agent)
 *   --task <slug>         the task to pay for (default tsk_webhook_dup)
 *   --out <dir>           report directory (default ./e2e-report)
 *   --no-pay              stop before the payment (free steps only; pay-dependent steps are skipped)
 *   --agent <id>          reuse a registered agent instead of registering a new one
 *   --agent-name <name>   name of the agent the Add agent step registers (default "Browser e2e demo agent")
 *   --evaluation <slug>   re-check an evaluation that is already issued (public slug or id); skips registration and payment
 *   --chrome <path>       Chrome binary (default /usr/bin/google-chrome when it exists, else Playwright's Chromium)
 *   --max-wait-min <n>    wait for the evaluation to be issued (default 15)
 * Output: <out>/browser-e2e.json, <out>/browser-e2e.html (screenshots inline) and <out>/shots/*.jpg.
 * Exit code: 0 when every non-skipped step passes, 1 when one fails, 2 on a usage or setup error.
 *
 * The MCP demo task (tsk_helpdesk_refunds) has a step that stays skipped until its images on GHCR are
 * public: it runs when an anonymous pull of ghcr.io/devfellowship/itera-mcp-helpdesk succeeds.
 */
import { createPrivateKey, sign as edSign } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { getBase58Encoder } from "@solana/kit";
import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import { chromium, type BrowserContext, type Page } from "playwright";

// ------------------------------------------------------------------------------------------------
// Options

const DEFAULT_WEB = "https://itera-agent-credentials.devfellowship.com";
const DEFAULT_API = "https://itera-agent-credentials-api.devfellowship.com";
const DEFAULT_TREASURY = "5jRHjKwmsTZgVSAaFFKRkXBnvVx82f6yxwUtU8G1BD1d";
const WALLET_NAME = "TMA Test Wallet";

const { values: argv } = parseArgs({
  options: {
    base: { type: "string", default: process.env.E2E_WEB_BASE ?? DEFAULT_WEB },
    api: { type: "string", default: process.env.E2E_API_BASE ?? DEFAULT_API },
    rpc: { type: "string", default: process.env.E2E_RPC_URL ?? "https://api.devnet.solana.com" },
    repo: { type: "string", default: "devfellowship/testmyagent-demo-agent" },
    task: { type: "string", default: "tsk_webhook_dup" },
    treasury: { type: "string", default: DEFAULT_TREASURY },
    out: { type: "string", default: "e2e-report" },
    "no-pay": { type: "boolean", default: false },
    evaluation: { type: "string", default: "" },
    agent: { type: "string", default: "" },
    "agent-name": { type: "string", default: "Browser e2e demo agent" },
    chrome: { type: "string", default: "" },
    "max-wait-min": { type: "string", default: "15" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (argv.help) {
  console.log("usage: npm run e2e:browser -- [--base <web>] [--api <api>] [--rpc <devnet rpc>] [--repo owner/name] [--task <slug>] [--out dir] [--no-pay] [--evaluation <slug>] [--chrome path] [--max-wait-min n]");
  process.exit(0);
}

const WEB = argv.base!.replace(/\/+$/, "");
const API = argv.api!.replace(/\/+$/, "");
const REPO = argv.repo!;
const TASK = argv.task!;
const TREASURY = argv.treasury!;
const OUT = argv.out!;
const SHOTS = join(OUT, "shots");
const MAX_WAIT_MS = Number(argv["max-wait-min"]) * 60_000;
const NO_PAY = argv["no-pay"]!;
const PRE_EVALUATION = argv.evaluation!;
const PRE_AGENT = argv.agent!;

const secretB58 = process.env.E2E_WALLET_SECRET_B58 ?? process.env.DEMO_WALLET_SECRET_B58;
delete process.env.E2E_WALLET_SECRET_B58;
delete process.env.DEMO_WALLET_SECRET_B58;
if (!secretB58) {
  console.error("E2E_WALLET_SECRET_B58 (or DEMO_WALLET_SECRET_B58) is required: base58 secret key of the demo wallet.");
  process.exit(2);
}

// ------------------------------------------------------------------------------------------------
// Wallet (Node side). The page never sees the secret.

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const secretBytes = Uint8Array.from(getBase58Encoder().encode(secretB58));
const keypair = Keypair.fromSecretKey(secretBytes);
const PUB = keypair.publicKey.toBase58();
const edKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(secretBytes.subarray(0, 32))]), format: "der", type: "pkcs8" });

const signCalls = { message: 0, transaction: 0 };

function signMessageB64(b64: string): string {
  signCalls.message++;
  return edSign(null, Buffer.from(b64, "base64"), edKey).toString("base64");
}

function signTransactionB64(b64: string): string {
  signCalls.transaction++;
  const bytes = Buffer.from(b64, "base64");
  try {
    const tx = Transaction.from(bytes);
    tx.partialSign(keypair);
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  } catch {
    const vtx = VersionedTransaction.deserialize(bytes);
    vtx.sign([keypair]);
    return Buffer.from(vtx.serialize()).toString("base64");
  }
}

/**
 * Init script (plain JavaScript, kept as a string so the TypeScript loader cannot inject helpers into it).
 * It runs in the page before any app script and registers a Wallet Standard wallet that calls back
 * into Node (`window.__tmaSign`) to sign.
 */
function walletInitScript(pub: string, name: string): string {
  return `(() => {
  const pub = ${JSON.stringify(pub)};
  const name = ${JSON.stringify(name)};
  const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58dec = (s) => {
    const bytes = [0];
    for (const c of s) {
      let carry = ALPH.indexOf(c);
      for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
      while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    for (const c of s) { if (c === '1') bytes.push(0); else break; }
    return new Uint8Array(bytes.reverse());
  };
  const chains = ['solana:devnet', 'solana:mainnet', 'solana:testnet'];
  const account = { address: pub, publicKey: b58dec(pub), chains, features: ['solana:signMessage', 'solana:signTransaction'], label: 'TMA test', icon: undefined };
  const wallet = {
    version: '1.0.0',
    name,
    icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#3fd17f"/></svg>'),
    chains,
    get accounts() { return window.__tmaConnected ? [account] : []; },
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { window.__tmaConnected = true; return { accounts: [account] }; } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { window.__tmaConnected = false; } },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: async (...inputs) => Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: unb64(await window.__tmaSign('message', b64(i.message))) }))),
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs) => Promise.all(inputs.map(async (i) => ({ signedTransaction: unb64(await window.__tmaSign('tx', b64(i.transaction))) }))),
      },
    },
  };
  const register = ({ register }) => register(wallet);
  window.addEventListener('wallet-standard:app-ready', (e) => register(e.detail));
  try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register })); } catch (e) {}
})();`;
}

// ------------------------------------------------------------------------------------------------
// Step runner and the three page assertions

type Status = "pass" | "fail" | "skip";
interface StepResult {
  id: string;
  group: string;
  name: string;
  status: Status;
  ms: number;
  detail: string;
  url?: string;
  shot?: string;
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const results: StepResult[] = [];
let stepNo = 0;
const pageErrors: { at: number; step: string; message: string }[] = [];
let currentStep = "";
let page: Page;

interface StepCtx {
  facts: Record<string, unknown>;
  /** Mount + no pageerror + positive control, then a screenshot. `control` is a selector, `min` its minimum count. */
  verify(shot: string, root: string, control: string, min: number): Promise<void>;
  shot?: string;
}

async function step(group: string, name: string, fn: (c: StepCtx) => Promise<string | void>): Promise<void> {
  const id = `S${String(++stepNo).padStart(2, "0")}`;
  const t0 = Date.now();
  const errorsBefore = pageErrors.length;
  currentStep = id;
  const ctx: StepCtx = {
    facts: {},
    async verify(shot, root, control, min) {
      // 1. MOUNT: the SPA root has content and the page's root element is visible.
      await page.locator(root).first().waitFor({ state: "visible", timeout: 45_000 });
      const rootLen = await page.evaluate(() => (document.querySelector("#root")?.innerHTML.length ?? 0));
      must(rootLen > 200, `#root is (nearly) empty: ${rootLen} bytes of HTML`);
      // 3. CONTROL: positive data (waits for the data to load).
      await page
        .waitForFunction(([sel, n]) => document.querySelectorAll(sel as string).length >= (n as number), [control, min] as const, { timeout: 45_000 })
        .catch(async () => {
          const have = await page.locator(control).count();
          throw new Assertion(`control "${control}" has ${have} element(s), need >= ${min}`);
        });
      await sleep(400);
      const file = join(SHOTS, `${id}-${shot}.jpg`);
      await page.screenshot({ path: file, fullPage: true, type: "jpeg", quality: 62 });
      ctx.shot = `shots/${id}-${shot}.jpg`;
      // 2. NO ERRORS: zero pageerror events since the step started.
      const errs = pageErrors.slice(errorsBefore);
      must(errs.length === 0, `${errs.length} pageerror event(s): ${errs[0]?.message.slice(0, 200)}`);
    },
  };
  let status: Status = "pass";
  let detail = "";
  let error: string | undefined;
  try {
    detail = (await fn(ctx)) ?? "";
  } catch (e) {
    if (e instanceof Skip) {
      status = "skip";
      detail = e.message;
    } else {
      status = "fail";
      error = e instanceof Error ? e.message : String(e);
      if (!ctx.shot && page) {
        try {
          const file = join(SHOTS, `${id}-failure.jpg`);
          await page.screenshot({ path: file, fullPage: true, type: "jpeg", quality: 55 });
          ctx.shot = `shots/${id}-failure.jpg`;
        } catch {
          // the page may be gone
        }
      }
    }
  }
  let url: string | undefined;
  try {
    url = page?.url();
  } catch {
    url = undefined;
  }
  const r: StepResult = { id, group, name, status, ms: Date.now() - t0, detail, url, shot: ctx.shot, facts: ctx.facts, ...(error ? { error } : {}) };
  results.push(r);
  const mark = status === "pass" ? "PASS" : status === "skip" ? "SKIP" : "FAIL";
  log(`${mark} ${id} [${group}] ${name}${detail ? " - " + detail : ""}${error ? "\n     " + error : ""}`);
}

// ------------------------------------------------------------------------------------------------
// Shared state between steps

const state: {
  agentId?: string;
  agentName?: string;
  evaluationId?: string;
  evaluationSlug?: string;
  profileUrl?: string;
  txSig?: string;
  paid: boolean;
  postBody?: { reference?: string; txSig?: string };
} = { paid: false };

async function json(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(30_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

interface CatalogTask {
  id: string;
  slug: string;
  name: string;
  runnable: boolean;
}
/** Task Filter rows carry the task UUID; the options name tasks by slug. */
async function catalogTask(slug: string): Promise<CatalogTask> {
  const r = await json("/tasks");
  must(r.status === 200, `GET /tasks -> ${r.status}`);
  const list: CatalogTask[] = r.body?.tasks ?? r.body;
  const t = list.find((x) => x.slug === slug || x.id === slug);
  must(t, `task ${slug} is not in the catalog`);
  must(t.runnable, `task ${slug} is not runnable`);
  return t;
}

async function selectOption(p: Page, triggerSelector: string, optionText: string | RegExp): Promise<void> {
  await p.locator(triggerSelector).click();
  await p.getByRole("option").filter({ hasText: optionText }).first().click();
}

/** Anonymous pull check of the MCP demo image: the token endpoint answers, then the manifest is readable. */
async function ghcrPublic(image: string): Promise<boolean> {
  try {
    const t = await fetch(`https://ghcr.io/token?scope=repository:${image}:pull`, { signal: AbortSignal.timeout(15_000) });
    if (!t.ok) return false;
    const { token } = (await t.json()) as { token?: string };
    if (!token) return false;
    const tags = await fetch(`https://ghcr.io/v2/${image}/tags/list`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!tags.ok) return false;
    const { tags: list } = (await tags.json()) as { tags?: string[] };
    if (!Array.isArray(list) || list.length === 0) return false;
    const m = await fetch(`https://ghcr.io/v2/${image}/manifests/${list[list.length - 1]}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    return m.ok;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------
// Pay + watch, reused by the webhook-ledger run and the MCP task run

async function payAndWatch(c: StepCtx, taskSlug: string): Promise<void> {
  // quote step already ran for the webhook task; for another task the caller navigates first.
  const pay = page.getByTestId("pay-and-start");
  await pay.waitFor({ state: "visible", timeout: 30_000 });
  must(await pay.isEnabled(), "Pay and start is disabled");
  const txBefore = signCalls.transaction;
  const reqPromise = page.waitForRequest((r) => r.method() === "POST" && /\/evaluations$/.test(new URL(r.url()).pathname), { timeout: 240_000 });
  await pay.click();
  // After a reload the wallet is not connected (autoConnect is off): the first press connects it and asks
  // for a second press ("Connect your wallet to pay."). This is the designed behaviour, so press again.
  const err = page.getByTestId("pay-error");
  if (await err.waitFor({ state: "visible", timeout: 6_000 }).then(() => true, () => false)) {
    const msg = (await err.innerText()).trim();
    must(/connect your wallet/i.test(msg), `pay error before the wallet prompt: ${msg}`);
    c.facts.walletConnectedOnFirstPress = msg;
    await page.waitForFunction(() => document.querySelector('[data-testid="pay-and-start"]') && !(document.querySelector('[data-testid="pay-and-start"]') as HTMLButtonElement).disabled, null, { timeout: 15_000 });
    await sleep(1500);
    await pay.click();
  }
  const req = await reqPromise;
  state.postBody = req.postDataJSON() as { reference?: string; txSig?: string };
  state.txSig = state.postBody?.txSig;
  c.facts.txSig = state.txSig;
  c.facts.walletSignaturesForPayment = signCalls.transaction - txBefore;
  await page.waitForURL(/\/evaluations\/[0-9a-f-]{36}/, { timeout: 120_000 });
  state.evaluationId = page.url().match(/\/evaluations\/([0-9a-f-]{36})/)![1];
  state.paid = true;
  must(signCalls.transaction - txBefore === 1, `payment needed ${signCalls.transaction - txBefore} transaction signatures, expected exactly 1`);
  c.facts.taskSlug = taskSlug;
}

async function rpcCheckPayment(txSig: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(argv.rpc!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [txSig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }] }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await res.json()) as any;
    if (j.result) {
      const keys: string[] = j.result.transaction.message.accountKeys.map((k: any) => (typeof k === "string" ? k : k.pubkey));
      const ti = keys.indexOf(TREASURY);
      must(j.result.meta.err == null, "payment tx failed on chain");
      must(ti >= 0, "treasury is not an account of the payment tx");
      const lamports = j.result.meta.postBalances[ti] - j.result.meta.preBalances[ti];
      must(lamports > 0, "treasury balance did not increase");
      must(keys[0] === PUB, "fee payer is not the demo wallet");
      return `${lamports} lamports to treasury, fee payer = demo wallet`;
    }
    await sleep(2000);
  }
  throw new Assertion("payment tx not found on devnet RPC");
}

// ------------------------------------------------------------------------------------------------
// Main

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const chromePath = argv.chrome || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
  const browser = await chromium.launch({ executablePath: chromePath, args: ["--no-sandbox"] });
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.exposeFunction("__tmaSign", (kind: string, b64: string) => (kind === "message" ? signMessageB64(b64) : signTransactionB64(b64)));
  await context.addInitScript({ content: walletInitScript(PUB, WALLET_NAME) });
  page = await context.newPage();
  // Armed before the first goto.
  page.on("pageerror", (e) => pageErrors.push({ at: Date.now(), step: currentStep, message: String(e) }));
  // API calls that answered 4xx/5xx are listed in the console (expected 4xx exist, e.g. the quote refresh).
  page.on("response", (r) => {
    if (r.status() >= 400 && r.url().startsWith(API)) log(`     http ${r.status()} ${r.request().method()} ${r.url().replace(API, "")}`);
  });
  page.on("dialog", (d) => void d.dismiss().catch(() => undefined));
  const startedAt = new Date();

  // ---- 1. Landing ---------------------------------------------------------------------------------
  await step("landing", "Landing renders (sections, CTAs)", async (c) => {
    await page.goto(WEB + "/", { waitUntil: "domcontentloaded" });
    await c.verify("landing", '[data-testid="landing-page"]', "section", 8);
    must((await page.getByTestId("landing-hero-cta").count()) === 1, "hero CTA missing");
    must((await page.getByTestId("landing-connect").count()) === 1, "connect CTA missing");
    return `${await page.locator("section").count()} sections`;
  });

  // ---- 2. Connect (SIWS) --------------------------------------------------------------------------
  await step("connect", "Connect wallet and sign in (SIWS)", async (c) => {
    const msgBefore = signCalls.message;
    await page.getByTestId("landing-hero-cta").click();
    await page.getByText(WALLET_NAME).first().click();
    await page.waitForURL(/\/agents(\?|$)/, { timeout: 60_000 });
    const session = await page.evaluate(() => localStorage.getItem("tma.session"));
    must(session, "no tma.session after sign-in");
    const parsed = JSON.parse(session);
    must(parsed.wallet === PUB, `session wallet ${parsed.wallet} is not the demo wallet`);
    c.facts.sessionWallet = parsed.wallet;
    c.facts.messageSignatures = signCalls.message - msgBefore;
    must(signCalls.message - msgBefore === 1, `SIWS needed ${signCalls.message - msgBefore} message signatures, expected 1`);
    await c.verify("connected", '[data-testid="agents-page"]', '[data-testid="app-nav"]', 1);
    return `wallet ${PUB.slice(0, 6)}...${PUB.slice(-4)} signed in with one message signature`;
  });

  // ---- 3. Agents: ranking + Task Filter modal ------------------------------------------------------
  await step("agents", "Agents ranking renders, scores sorted", async (c) => {
    await c.verify("agents", '[data-testid="agents-page"]', '[data-testid="agents-table-row"]', 1);
    const scores = (await page.getByTestId("agent-score").allInnerTexts()).map(Number).filter((n) => Number.isFinite(n));
    must(scores.length >= 1, "no agent has a score");
    for (let i = 1; i < scores.length; i++) must(scores[i - 1] >= scores[i], `ranking not sorted by score: ${scores.join(", ")}`);
    c.facts.rows = await page.getByTestId("agents-table-row").count();
    c.facts.scores = scores.slice(0, 8);
    return `${c.facts.rows} agents, scores ${scores.slice(0, 5).join(" >= ")}`;
  });

  await step("agents", "Task Filter modal: pick a task, ranking re-sorts on it", async (c) => {
    await page.getByTestId("tasks-filter-button").click();
    await page.getByTestId("task-filter-modal").waitFor({ timeout: 20_000 });
    await c.verify("task-filter-modal", '[data-testid="task-filter-modal"]', '[data-testid="task-filter-row"]', 1);
    const rows = await page.getByTestId("task-filter-row").count();
    const task = await catalogTask(TASK);
    const row = page.locator(`[data-testid="task-filter-row"][data-task-id="${task.id}"]`);
    must((await row.count()) === 1, `task ${TASK} (${task.id}) has no row in the Task Filter`);
    c.facts.taskRows = rows;
    c.facts.pickedTask = `${task.slug} (${task.name})`;
    await row.click();
    must((await row.getAttribute("aria-checked")) === "true", "row did not toggle on");
    must(/^1\b/.test((await page.getByTestId("task-filter-count").innerText()).trim()) || /1/.test(await page.getByTestId("task-filter-count").innerText()), "filter count did not show 1 selected");
    await page.getByTestId("task-filter-apply").click();
    await page.getByTestId("ranked-on").waitFor({ timeout: 30_000 });
    await c.verify("ranked-on-task", '[data-testid="ranked-on"]', '[data-testid="agents-table-row"]', 1);
    must(/tasks=/.test(page.url()), "the selection is not in the URL");
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    return `${rows} tasks in the catalog; ranked on ${c.facts.pickedTask}`;
  });

  // ---- 4. Add agent --------------------------------------------------------------------------------
  if (PRE_EVALUATION || PRE_AGENT) {
    await step("add-agent", "Add agent", async () => skip(PRE_AGENT ? `--agent given: reusing agent ${PRE_AGENT}` : "--evaluation given: registration and payment are skipped"));
    if (PRE_AGENT) state.agentId = PRE_AGENT;
  } else {
    await step("add-agent", "Add agent: GitHub connected, repo / branch / commit / path, validate", async (c) => {
      await page.goto(WEB + "/agents/new", { waitUntil: "domcontentloaded" });
      await page.getByTestId("github-connected").waitFor({ timeout: 45_000 });
      await selectOption(page, "#ta-repo", REPO);
      await page.getByTestId("validation-ok").waitFor({ timeout: 90_000 });
      const branch = (await page.locator("#ta-branch").innerText()).trim();
      must(branch.length > 0 && !/no branches|loading/i.test(branch), `branch select shows "${branch}"`);
      // Pinned commit: wait until the list is loaded, open it, choose the first (latest) entry.
      await page.waitForFunction(() => !(document.querySelector("#ta-commit") as HTMLButtonElement | null)?.disabled, null, { timeout: 45_000 });
      await page.locator("#ta-commit").click();
      const commitOptions = await page.getByRole("option").count();
      must(commitOptions >= 1, "no commits to pin");
      await page.getByRole("option").first().click();
      await page.getByTestId("validation-ok").waitFor({ timeout: 90_000 });
      const validation = (await page.getByTestId("validation-ok").innerText()).replace(/\s+/g, " ");
      c.facts.repo = REPO;
      c.facts.branch = branch;
      c.facts.commitOptions = commitOptions;
      c.facts.path = await page.locator("#ta-path").inputValue();
      c.facts.validation = validation;
      await page.locator("#ta-name").fill(argv["agent-name"]!);
      state.agentName = argv["agent-name"]!;
      await c.verify("add-agent", '[data-testid="add-agent-page"]', '[data-testid="validation-ok"]', 1);
      await page.getByTestId("continue-to-tasks").click();
      await page.waitForURL(/\/agents\/[^/]+\/evaluate/, { timeout: 60_000 });
      state.agentId = decodeURIComponent(page.url().match(/\/agents\/([^/?]+)\/evaluate/)![1]);
      c.facts.agentId = state.agentId;
      return `${REPO}@${branch}, ${commitOptions} commits, ${validation}`;
    });
  }

  // ---- 5. Agent detail + badge ----------------------------------------------------------------------
  await step("agent", "Agent detail /agents/:id renders", async (c) => {
    if (!state.agentId) skip("no agent registered in this run");
    await page.goto(`${WEB}/agents/${encodeURIComponent(state.agentId)}`, { waitUntil: "domcontentloaded" });
    await c.verify("agent-detail", '[data-testid="agent-detail"]', '[data-testid="agent-name"]', 1);
    must(((await page.getByTestId("agent-name").innerText()) || "").trim().length > 0, "agent name is empty");
    must((await page.getByTestId("choose-tasks").count()) === 1, "Choose tasks button missing");
    c.facts.hasBadge = (await page.getByTestId("badge-card").count()) > 0;
    return `badge card ${c.facts.hasBadge ? "present" : "absent (agent has no evaluation yet)"}`;
  });

  // ---- 6. Select tasks + quote -----------------------------------------------------------------------
  await step("quote", "Choose tasks and get an itemized quote", async (c) => {
    if (!state.agentId) skip("no agent registered in this run");
    const task = await catalogTask(TASK);
    await page.getByTestId("choose-tasks").click();
    await page.waitForURL(/\/agents\/[^/]+\/evaluate/, { timeout: 30_000 });
    // Select exactly the paid task: deselect everything, then tick it.
    await page.getByTestId("task-filter-inline").waitFor({ timeout: 45_000 });
    await page.getByTestId("task-filter-row").first().waitFor({ timeout: 45_000 });
    const rows = page.getByTestId("task-filter-row");
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const r = rows.nth(i);
      if ((await r.getAttribute("aria-checked")) === "true" && (await r.getAttribute("data-task-id")) !== task.id) await r.click();
    }
    const target = page.locator(`[data-testid="task-filter-row"][data-task-id="${task.id}"]`);
    must((await target.count()) === 1, `task ${TASK} is not in the run list`);
    if ((await target.getAttribute("aria-checked")) !== "true") await target.click();
    await page.getByTestId("quote-validity").waitFor({ timeout: 45_000 });
    await c.verify("quote", '[data-testid="select-tasks-page"]', '[data-testid="summary-total"]', 1);
    const summary = (await page.getByTestId("evaluation-summary").innerText()).replace(/\s+/g, " ");
    const fee = (await page.getByTestId("summary-fee").innerText()).replace(/\s+/g, " ");
    const total = (await page.getByTestId("summary-total").innerText()).replace(/\s+/g, " ");
    c.facts.summary = summary;
    c.facts.fee = fee;
    c.facts.total = total;
    must(/US\$0\.\d\d/.test(fee) && /[x×]/i.test(fee), `fee row is not itemized: "${fee}"`);
    must(/SOL/.test(total), `total has no SOL amount: "${total}"`);
    return `fee "${fee}", total "${total}"`;
  });

  // ---- 7. Pay with ONE signature ----------------------------------------------------------------------
  await step("pay", "Pay and start with one wallet signature", async (c) => {
    if (!state.agentId) skip("no agent registered in this run");
    if (NO_PAY) skip("--no-pay");
    await payAndWatch(c, TASK);
    c.facts.evaluationId = state.evaluationId;
    c.facts.rpc = await rpcCheckPayment(state.txSig!);
    return `evaluation ${state.evaluationId}, ${c.facts.rpc}, wallet signed ${c.facts.walletSignaturesForPayment} transaction`;
  });

  // ---- 8. Running evaluation --------------------------------------------------------------------------
  await step("evaluation", "Running evaluation: states move to issued, per-call log", async (c) => {
    if (!state.paid && !PRE_EVALUATION) skip("no payment in this run");
    if (PRE_EVALUATION && !state.paid) {
      const r = await json(`/public/evaluations/${encodeURIComponent(PRE_EVALUATION)}`);
      must(r.status === 200, `public evaluation ${PRE_EVALUATION} -> ${r.status}`);
      state.evaluationSlug = r.body?.slug ?? PRE_EVALUATION;
      state.evaluationId = r.body?.id ?? r.body?.evaluationId;
      skip("pre-existing evaluation: the live run is not replayed");
    }
    const seen: string[] = [];
    const until = Date.now() + MAX_WAIT_MS;
    let shots = 0;
    let finalState = "";
    for (;;) {
      const root = page.getByTestId("running-evaluation-page");
      const ui = await root.getAttribute("data-ui-state").catch(() => null);
      const stages = await page
        .locator('[data-testid^="stage-"]')
        .evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.testid!.slice(6)}:${(e as HTMLElement).dataset.state}`).join(" "))
        .catch(() => "");
      const key = `${ui}`;
      if (ui && !seen.includes(key)) {
        seen.push(key);
        log(`     evaluation state: ${ui} ${stages}`);
        if (ui !== "issued") {
          const file = join(SHOTS, `evaluation-${String(++shots).padStart(2, "0")}-${ui}.jpg`);
          await page.screenshot({ path: file, fullPage: true, type: "jpeg", quality: 55 });
        }
      }
      if (ui === "issued" || ui === "cancelled" || ui === "failed") {
        finalState = ui;
        break;
      }
      if (Date.now() > until) throw new Assertion(`evaluation not issued after ${argv["max-wait-min"]} min (last state ${ui})`);
      await sleep(2500);
    }
    c.facts.states = seen;
    must(finalState === "issued", `evaluation ended ${finalState}, states ${seen.join(" > ")}`);
    must(seen.includes("running") || seen.includes("queued"), `never saw queued/running (saw ${seen.join(" > ")})`);
    await c.verify("evaluation-issued", '[data-testid="running-evaluation-page"]', '[data-testid="event-row"]', 2);
    const events = await page.getByTestId("event-row").allInnerTexts();
    c.facts.eventRows = events.length;
    c.facts.firstEvents = events.slice(0, 6).map((e) => e.replace(/\s+/g, " "));
    const callLines = events.filter((e) => /call|agent|artifact|test|grade|proof|issued/i.test(e)).length;
    must(callLines >= 1, "the event log has no call / agent / grading lines");
    c.facts.runCosts = await page.getByTestId("run-cost").allInnerTexts().catch(() => []);
    must((await page.getByTestId("issued-banner").count()) === 1, "issued banner missing");
    const link = page.getByTestId("view-profile");
    must((await link.count()) === 1, "View public profile link missing");
    state.profileUrl = new URL((await link.getAttribute("href")) ?? "", WEB).toString();
    state.evaluationSlug = state.profileUrl.split("/e/")[1];
    c.facts.profile = state.profileUrl;
    return `states ${seen.join(" > ")}, ${events.length} log rows, profile ${state.profileUrl}`;
  });

  // ---- 9. Public profile + Verify ----------------------------------------------------------------------
  await step("profile", "Public profile /e/:slug: Verify in browser -> VERIFIED", async (c) => {
    if (!state.evaluationSlug) skip("no issued evaluation");
    await page.goto(`${WEB}/e/${state.evaluationSlug}`, { waitUntil: "domcontentloaded" });
    await c.verify("profile", '[data-testid="public-profile"]', '[data-testid="task-card"]', 1);
    const btn = page.getByTestId("verify-button");
    await btn.waitFor({ timeout: 90_000 });
    await btn.click();
    await page.getByTestId("verify-result").waitFor({ timeout: 120_000 });
    const result = (await page.getByTestId("verify-result").innerText()).replace(/\s+/g, " ");
    must(/^VERIFIED/.test(result), `verify result: ${result}`);
    c.facts.verify = result;
    const file = join(SHOTS, `${(results.length + 1).toString().padStart(2, "0")}-profile-verified.jpg`);
    await page.screenshot({ path: file, fullPage: true, type: "jpeg", quality: 62 });
    c.shot = `shots/${file.split("/").pop()}`;
    const errs = pageErrors.filter((e) => e.step === currentStep);
    must(errs.length === 0, `${errs.length} pageerror(s) during verify: ${errs[0]?.message.slice(0, 160)}`);
    return result;
  });

  await step("profile", "Owner feedback prompt on the public profile", async (c) => {
    if (!state.evaluationSlug) skip("no issued evaluation");
    const prompt = page.getByTestId("feedback-prompt").first();
    await prompt.waitFor({ timeout: 45_000 });
    await c.verify("feedback-prompt", '[data-testid="public-profile"]', '[data-testid="feedback-prompt"]', 1);
    await prompt.getByRole("button", { name: "Yes", exact: true }).click();
    await prompt.getByRole("button", { name: "Send" }).click();
    await page.getByTestId("feedback-done").first().waitFor({ timeout: 30_000 });
    const txt = (await page.getByTestId("feedback-done").first().innerText()).replace(/\s+/g, " ");
    must(/matched reality/.test(txt), `unexpected feedback text: ${txt}`);
    return txt;
  });

  // ---- 10. My evaluations -------------------------------------------------------------------------------
  await step("my-evaluations", "My evaluations lists the evaluation (positive row)", async (c) => {
    await page.goto(WEB + "/evaluations", { waitUntil: "domcontentloaded" });
    await c.verify("my-evaluations", '[data-testid="my-evaluations"]', '[data-testid="evaluations-table-row"]', 1);
    const rows = await page.getByTestId("evaluations-table-row").allInnerTexts();
    c.facts.rows = rows.length;
    const issued = await page.getByTestId("status-issued").count();
    must(issued >= 1, "no issued evaluation in the list");
    const pass = rows.some((r) => /PASS/.test(r));
    must(pass, "no row with a PASS outcome (positive row)");
    c.facts.spent = (await page.getByTestId("evaluations-spent").innerText().catch(() => "")).replace(/\s+/g, " ");
    return `${rows.length} rows, ${issued} issued, spent "${c.facts.spent}"`;
  });

  // ---- 11. My tasks ---------------------------------------------------------------------------------------
  await step("my-tasks", "My tasks (/tasks): the demo task is Ready", async (c) => {
    await page.goto(WEB + "/tasks", { waitUntil: "domcontentloaded" });
    await c.verify("my-tasks", '[data-testid="my-tasks"]', '[data-testid="tasks-table-row"]', 1);
    const ready = await page.getByTestId("task-status-ready").count();
    must(ready >= 1, "no Ready task in My tasks");
    const rows = await page.getByTestId("tasks-table-row").allInnerTexts();
    c.facts.rows = rows.length;
    return `${rows.length} tasks, ${ready} Ready`;
  });

  await step("my-tasks", "Task editor: Environment card renders", async (c) => {
    // The editor of the Ready task of My tasks (the demo task); a task the wallet owns is editable.
    await page.goto(WEB + "/tasks", { waitUntil: "domcontentloaded" });
    await page.getByTestId("tasks-table-row").first().waitFor({ timeout: 45_000 });
    const readyRow = page.locator('[data-testid="tasks-table-row"]:has([data-testid="task-status-ready"])').first();
    must((await readyRow.count()) >= 1, "no Ready task row in My tasks");
    // A row click opens the editor (the "Rank agents" link of a Ready row stops the click).
    await readyRow.locator("span").first().click();
    await page.waitForURL(/\/tasks\/[^/]+\/edit/, { timeout: 30_000 });
    await c.verify("task-editor", '[data-testid="task-editor"]', '[data-testid="environment-slot"]', 1);
    const env = (await page.getByTestId("environment-slot").first().innerText()).replace(/\s+/g, " ").slice(0, 160);
    c.facts.environment = env;
    return env;
  });

  // ---- 12. Public task page -------------------------------------------------------------------------------
  await step("task-page", `Public task page /tasks/${TASK}`, async (c) => {
    await page.goto(`${WEB}/tasks/${TASK}`, { waitUntil: "domcontentloaded" });
    await c.verify("task-page", '[data-testid="task-profile"]', '[data-testid="task-title"]', 1);
    must(((await page.getByTestId("task-title").innerText()) || "").trim().length > 0, "task title is empty");
    return (await page.getByTestId("task-title").innerText()).trim();
  });

  // ---- 13. Agent detail + badge after the evaluation --------------------------------------------------------
  await step("agent", "Agent detail shows the badge and the latest attestation after the run", async (c) => {
    if (!state.agentId || !state.paid) skip("no paid run in this session");
    await page.goto(`${WEB}/agents/${encodeURIComponent(state.agentId)}`, { waitUntil: "domcontentloaded" });
    await c.verify("agent-detail-after", '[data-testid="agent-detail"]', '[data-testid="badge-card"]', 1);
    const img = page.getByTestId("badge-img");
    await img.waitFor({ timeout: 30_000 });
    const ok = await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0);
    must(ok, "badge image did not load");
    must(/!\[|\]\(/.test(await page.getByTestId("badge-snippet").innerText()), "badge Markdown snippet is empty");
    return "badge image loaded, Markdown snippet present";
  });

  // ---- 14. MCP task (pending GHCR public) --------------------------------------------------------------------
  const mcpImage = "devfellowship/itera-mcp-helpdesk";
  const mcpPublic = await ghcrPublic(mcpImage);
  await step("mcp", mcpPublic ? "MCP task run (GHCR image is public)" : "MCP task run - pending GHCR public", async (c) => {
    const image = mcpImage;
    const pub = mcpPublic;
    c.facts.ghcrAnonymousPull = pub;
    if (!pub) skip(`anonymous pull of ghcr.io/${image} fails (images still private)`);
    if (!state.agentId || NO_PAY) skip("images are public, but this run does not pay (no agent or --no-pay)");
    await page.goto(`${WEB}/agents/${encodeURIComponent(state.agentId)}/evaluate?tasks=tsk_helpdesk_refunds`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("quote-validity").waitFor({ timeout: 45_000 });
    await payAndWatch(c, "tsk_helpdesk_refunds");
    await page.getByTestId("issued-banner").waitFor({ timeout: MAX_WAIT_MS });
    await c.verify("mcp-run", '[data-testid="running-evaluation-page"]', '[data-testid="event-row"]', 1);
    return `MCP evaluation ${state.evaluationId} issued`;
  });

  await browser.close();
  finish(startedAt);
}

// ------------------------------------------------------------------------------------------------
// Report

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function finish(startedAt: Date): void {
  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  const summary = { web: WEB, wallet: `${PUB.slice(0, 4)}...${PUB.slice(-4)}`, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), pass, fail, skip: skipped, pageErrors: pageErrors.length, signatures: signCalls, evaluationId: state.evaluationId, profile: state.profileUrl, txSig: state.txSig };
  writeFileSync(join(OUT, "browser-e2e.json"), JSON.stringify({ summary, steps: results, pageErrors }, null, 2));
  // The HTML report embeds the screenshots, so it is one file to upload.
  const rows = results
    .map((r) => {
      const img = r.shot ? `<details><summary>screenshot</summary><img alt="${esc(r.id)}" src="data:image/jpeg;base64,${require_b64(join(OUT, r.shot))}"></details>` : "";
      const facts = Object.keys(r.facts).length ? `<pre>${esc(JSON.stringify(r.facts, null, 1))}</pre>` : "";
      return `<tr class="${r.status}"><td>${r.id}</td><td>${esc(r.group)}</td><td>${esc(r.name)}</td><td class="st">${r.status.toUpperCase()}</td><td>${(r.ms / 1000).toFixed(1)} s</td><td>${esc(r.detail)}${r.error ? `<div class="err">${esc(r.error)}</div>` : ""}${r.url ? `<div class="u">${esc(r.url)}</div>` : ""}${facts}${img}</td></tr>`;
    })
    .join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TestMyAgent browser e2e</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;background:#0b0f0d;color:#e6ece8}
h1{font-size:20px;margin:0 0 4px}.sub{color:#8fa097;margin-bottom:16px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #22302a;padding:8px 10px;text-align:left;vertical-align:top}
th{color:#8fa097;font-weight:600;font-size:12px;text-transform:uppercase}
tr.pass .st{color:#3fd17f;font-weight:700}tr.fail .st{color:#ff6b6b;font-weight:700}tr.skip .st{color:#e0b341;font-weight:700}
.err{color:#ff9b9b;margin-top:4px}.u{color:#8fa097;font:12px ui-monospace,monospace;margin-top:4px;word-break:break-all}
pre{background:#121a16;padding:8px;border-radius:6px;overflow:auto;font-size:12px;max-width:900px}
details img{max-width:100%;width:900px;border:1px solid #22302a;border-radius:6px;margin-top:6px}
summary{cursor:pointer;color:#3fd17f}
</style></head><body>
<h1>TestMyAgent browser e2e</h1>
<div class="sub">${esc(WEB)} &middot; wallet ${esc(summary.wallet)} &middot; ${esc(summary.startedAt)} &middot; <b>${pass} pass</b>, <b>${fail} fail</b>, ${skipped} skipped &middot; pageerror events: ${pageErrors.length} &middot; wallet signatures: ${signCalls.message} message, ${signCalls.transaction} transaction${state.profileUrl ? ` &middot; <a style="color:#3fd17f" href="${esc(state.profileUrl)}">evaluation profile</a>` : ""}</div>
<table><thead><tr><th>#</th><th>Group</th><th>Step</th><th>Result</th><th>Time</th><th>Detail</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>`;
  writeFileSync(join(OUT, "browser-e2e.html"), html);
  console.log(`\n${pass} pass, ${fail} fail, ${skipped} skipped. Report: ${join(OUT, "browser-e2e.html")}`);
  process.exit(fail > 0 ? 1 : 0);
}

import { readFileSync } from "node:fs";
function require_b64(path: string): string {
  return readFileSync(path).toString("base64");
}

main().catch((e) => {
  console.error("setup error:", e instanceof Error ? e.message : e);
  process.exit(2);
});

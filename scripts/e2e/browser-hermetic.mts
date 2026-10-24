/**
 * Hermetic browser e2e of the web3 UI (apps/web), for the `web3 e2e guard` workflow.
 *
 *   npx tsx scripts/e2e/browser-hermetic.mts --web http://127.0.0.1:4173 --api http://127.0.0.1:3000 \
 *     --rpc http://127.0.0.1:8899 --rpc-ws ws://127.0.0.1:8900 --ipfs-gateway http://127.0.0.1:18080/ipfs \
 *     --agent-id <uuid> --task tsk_webhook_dup --treasury <base58> --out e2e-report
 *
 * It drives the web app of THIS commit in a real Chrome, against the job's own stack (API, runner
 * worker with the stub model, Postgres, solana-test-validator with the SAS program, IPFS stub):
 *   landing -> connect (SIWS) -> agent detail -> choose task + quote -> pay with ONE wallet signature
 *   -> /evaluations/:id moves to issued -> /e/:slug shows the score -> Verify -> VERIFIED
 *   -> My evaluations -> Agents ranking -> public task page.
 *
 * Hermetic by construction:
 *   - --web and --api must be loopback origins. The script refuses any other origin.
 *   - apps/web has the devnet RPC and the Pinata gateway fixed in its code. Playwright routes them to
 *     --rpc / --rpc-ws / --ipfs-gateway. The app code is not changed.
 *   - A request to a production host of the app is aborted and counted. One such request fails the run.
 *
 * Wallet: the test wallet of scripts/e2e/lib/test-wallet.mts (Wallet Standard, injected with
 * addInitScript; every signature runs in this Node process). The key is E2E_WALLET_SECRET_B58: the
 * throwaway key that scripts/e2e/hermetic/keys.mjs generates in the job. It holds only SOL airdropped
 * by the job's own validator. The secret is never printed or written.
 *
 * Every page step asserts the three "verified in prod" conditions:
 *   1. MOUNT       #root is non-empty and the page's own root element is visible
 *   2. NO ERRORS   zero `pageerror` events (the listener is armed before the first goto)
 *   3. CONTROL     a positive-data assertion (a selector that exists only when data rendered)
 *
 * Output: <out>/browser-hermetic.json, <out>/browser-hermetic.md (step summary) and <out>/shots/*.jpg.
 * Exit code: 0 when every step passes, 1 when one fails, 2 on a usage or setup error.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { getBase58Encoder } from "@solana/kit";
import { chromium, type BrowserContext, type Page, type Route } from "playwright";
import { createTestWallet } from "./lib/test-wallet.mts";

// ------------------------------------------------------------------------------------------------
// Options

const WALLET_NAME = "TMA Test Wallet";
/** Fixed in apps/web (src/wallet.tsx, src/verify.ts). Routed to the job's validator. */
const APP_RPC = /^https:\/\/api\.devnet\.solana\.com(\/|$)/;
const APP_RPC_WS = /^wss:\/\/api\.devnet\.solana\.com(\/|$)/;
/** Fixed in apps/web (src/verify.ts IPFS_GATEWAY_URL). Routed to the job's IPFS stub. */
const APP_IPFS = /^https:\/\/gateway\.pinata\.cloud\/ipfs\//;
/** Production hosts of the app. The hermetic run must never reach them. */
const PROD_HOSTS = /^https?:\/\/([a-z0-9-]+\.)*(itera-agent-credentials(-api)?|testmyagent)\.devfellowship\.com(\/|$)/i;

const { values: argv } = parseArgs({
  options: {
    web: { type: "string", default: "http://127.0.0.1:4173" },
    api: { type: "string", default: "http://127.0.0.1:3000" },
    rpc: { type: "string", default: "http://127.0.0.1:8899" },
    "rpc-ws": { type: "string", default: "ws://127.0.0.1:8900" },
    "ipfs-gateway": { type: "string", default: "http://127.0.0.1:18080/ipfs" },
    "agent-id": { type: "string", default: "" },
    task: { type: "string", default: "tsk_webhook_dup" },
    treasury: { type: "string", default: "" },
    out: { type: "string", default: "e2e-report" },
    chrome: { type: "string", default: "" },
    "max-wait-min": { type: "string", default: "15" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (argv.help) {
  console.log("usage: tsx scripts/e2e/browser-hermetic.mts --agent-id <uuid> --treasury <base58> [--web url] [--api url] [--rpc url] [--rpc-ws url] [--ipfs-gateway url] [--task slug] [--out dir] [--chrome path] [--max-wait-min n]");
  process.exit(0);
}

function usage(message: string): never {
  console.error(message);
  process.exit(2);
}

function loopback(name: string, value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    usage(`--${name} is not a URL: ${value}`);
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) usage(`--${name} must be a loopback origin (hermetic run only), got ${u.hostname}`);
  return value.replace(/\/+$/, "");
}

const WEB = loopback("web", argv.web!);
const API = loopback("api", argv.api!);
const RPC = loopback("rpc", argv.rpc!);
const RPC_WS = loopback("rpc-ws", argv["rpc-ws"]!);
const IPFS = loopback("ipfs-gateway", argv["ipfs-gateway"]!);
const AGENT_ID = argv["agent-id"]!;
const TASK = argv.task!;
const TREASURY = argv.treasury!;
const OUT = argv.out!;
const SHOTS = join(OUT, "shots");
const MAX_WAIT_MS = Number(argv["max-wait-min"]) * 60_000;
if (!AGENT_ID) usage("--agent-id is required (the DB fixture agent of scripts/e2e/hermetic/db-seed.sql)");
if (!TREASURY) usage("--treasury is required (the job's treasury address)");

const secretB58 = process.env.E2E_WALLET_SECRET_B58;
delete process.env.E2E_WALLET_SECRET_B58;
if (!secretB58) usage("E2E_WALLET_SECRET_B58 is required: the throwaway wallet key that scripts/e2e/hermetic/keys.mjs generates.");
const wallet = createTestWallet(Uint8Array.from(getBase58Encoder().encode(secretB58)));
const PUB = wallet.pub;
const signCalls = wallet.signCalls;

// ------------------------------------------------------------------------------------------------
// Step runner and the three page assertions

type Status = "pass" | "fail";
interface StepResult {
  id: string;
  name: string;
  status: Status;
  ms: number;
  detail: string;
  url?: string;
  shot?: string;
  error?: string;
}
class Assertion extends Error {}
function must(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Assertion(message);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const results: StepResult[] = [];
const pageErrors: { step: string; message: string }[] = [];
const prodRequests: string[] = [];
const routed = { rpc: 0, rpcWs: 0, ipfs: 0 };
let stepNo = 0;
let currentStep = "";
let page: Page;
let failed = false;

interface StepCtx {
  /** MOUNT + CONTROL, a screenshot, then NO ERRORS for the step. `control` is a selector, `min` its minimum count. */
  verify(shot: string, root: string, control: string, min: number): Promise<void>;
}

async function step(name: string, fn: (c: StepCtx) => Promise<string>): Promise<void> {
  const id = `S${String(++stepNo).padStart(2, "0")}`;
  const t0 = Date.now();
  const errorsBefore = pageErrors.length;
  currentStep = id;
  let shot: string | undefined;
  const ctx: StepCtx = {
    async verify(name, root, control, min) {
      // 1. MOUNT: the SPA root has content and the page's root element is visible.
      await page.locator(root).first().waitFor({ state: "visible", timeout: 45_000 });
      const rootLen = await page.evaluate(() => document.querySelector("#root")?.innerHTML.length ?? 0);
      must(rootLen > 200, `#root is (nearly) empty: ${rootLen} bytes of HTML`);
      // 3. CONTROL: positive data (waits for the data to load).
      await page
        .waitForFunction(([sel, n]) => document.querySelectorAll(sel as string).length >= (n as number), [control, min] as const, { timeout: 45_000 })
        .catch(async () => {
          throw new Assertion(`control "${control}" has ${await page.locator(control).count()} element(s), need >= ${min}`);
        });
      await sleep(300);
      shot = `shots/${id}-${name}.jpg`;
      await page.screenshot({ path: join(OUT, shot), fullPage: true, type: "jpeg", quality: 60 });
      // 2. NO ERRORS: zero pageerror events since the step started.
      const errs = pageErrors.slice(errorsBefore);
      must(errs.length === 0, `${errs.length} pageerror event(s): ${errs[0]?.message.slice(0, 300)}`);
    },
  };
  let status: Status = "pass";
  let detail = "";
  let error: string | undefined;
  if (failed) {
    // A later step depends on the earlier ones (session, payment, evaluation): stop at the first failure.
    status = "fail";
    error = "not run: an earlier step failed";
  } else {
    try {
      detail = await fn(ctx);
      const errs = pageErrors.slice(errorsBefore);
      must(errs.length === 0, `${errs.length} pageerror event(s): ${errs[0]?.message.slice(0, 300)}`);
    } catch (e) {
      status = "fail";
      error = e instanceof Error ? e.message : String(e);
      try {
        shot = `shots/${id}-failure.jpg`;
        await page.screenshot({ path: join(OUT, shot), fullPage: true, type: "jpeg", quality: 55 });
      } catch {
        shot = undefined;
      }
    }
  }
  if (status === "fail") failed = true;
  let url: string | undefined;
  try {
    url = page?.url();
  } catch {
    url = undefined;
  }
  results.push({ id, name, status, ms: Date.now() - t0, detail, url, shot, ...(error ? { error } : {}) });
  log(`${status === "pass" ? "PASS" : "FAIL"} ${id} ${name}${detail ? " - " + detail : ""}${error ? "\n     " + error : ""}`);
}

// ------------------------------------------------------------------------------------------------
// Routing: the app's fixed devnet RPC and IPFS gateway go to the job's stack.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
};

async function forward(route: Route, target: string): Promise<void> {
  const req = route.request();
  if (req.method() === "OPTIONS") {
    await route.fulfill({ status: 204, headers: CORS });
    return;
  }
  const response = await route.fetch({ url: target, maxRedirects: 0 });
  await route.fulfill({ response, headers: { ...response.headers(), ...CORS } });
}

async function installRoutes(context: BrowserContext): Promise<void> {
  await context.route(PROD_HOSTS, async (route) => {
    prodRequests.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort("blockedbyclient");
  });
  await context.route(APP_RPC, async (route) => {
    routed.rpc++;
    const u = new URL(route.request().url());
    await forward(route, RPC + u.pathname.replace(/^\/$/, "") + u.search);
  });
  await context.route(APP_IPFS, async (route) => {
    routed.ipfs++;
    const u = new URL(route.request().url());
    await forward(route, IPFS + u.pathname.replace(/^\/ipfs/, "") + u.search);
  });
  // The web3.js Connection opens a WebSocket only for subscriptions. Bridge it to the validator so
  // that no socket reaches the real devnet.
  await context.routeWebSocket(APP_RPC_WS, (ws) => {
    routed.rpcWs++;
    const upstream = new WebSocket(RPC_WS);
    const pending: string[] = [];
    upstream.addEventListener("open", () => {
      for (const m of pending.splice(0)) upstream.send(m);
    });
    upstream.addEventListener("message", (e) => ws.send(typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer)));
    upstream.addEventListener("close", () => ws.close());
    ws.onMessage((m) => {
      const s = typeof m === "string" ? m : m.toString();
      if (upstream.readyState === WebSocket.OPEN) upstream.send(s);
      else pending.push(s);
    });
    ws.onClose(() => upstream.close());
  });
}

// ------------------------------------------------------------------------------------------------
// Helpers

const state: { evaluationId?: string; evaluationSlug?: string; txSig?: string; score?: number; verify?: string } = {};

async function apiJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(30_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function catalogTaskId(slug: string): Promise<string> {
  const r = await apiJson("/tasks");
  must(r.status === 200, `GET /tasks -> ${r.status}`);
  const list: { id: string; slug: string; runnable: boolean }[] = r.body?.tasks ?? r.body;
  const t = list.find((x) => x.slug === slug || x.id === slug);
  must(t, `task ${slug} is not in the catalog`);
  must(t.runnable, `task ${slug} is not runnable`);
  return t.id;
}

/** The payment transaction on the job's validator: treasury credited, fee payer = the test wallet. */
async function rpcCheckPayment(txSig: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(RPC, {
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
      must(keys[0] === PUB, "fee payer is not the test wallet");
      return `${lamports} lamports to the treasury`;
    }
    await sleep(1500);
  }
  throw new Assertion("payment tx not found on the local validator");
}

// ------------------------------------------------------------------------------------------------
// Main

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const chromePath = argv.chrome || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
  const browser = await chromium.launch({ executablePath: chromePath, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installRoutes(context);
  await context.exposeFunction("__tmaSign", (kind: string, b64: string) => wallet.sign(kind, b64));
  await context.addInitScript({ content: wallet.initScript(WALLET_NAME) });
  page = await context.newPage();
  // Armed before the first goto.
  page.on("pageerror", (e) => pageErrors.push({ step: currentStep, message: String(e) }));
  page.on("response", (r) => {
    if (r.status() >= 400 && r.url().startsWith(API)) log(`     http ${r.status()} ${r.request().method()} ${r.url().replace(API, "")}`);
  });
  page.on("dialog", (d) => void d.dismiss().catch(() => undefined));
  const startedAt = new Date();

  await step("Landing renders (sections, CTAs)", async (c) => {
    await page.goto(WEB + "/", { waitUntil: "domcontentloaded" });
    await c.verify("landing", '[data-testid="landing-page"]', "section", 3);
    must((await page.getByTestId("landing-hero-cta").count()) === 1, "hero CTA missing");
    return `${await page.locator("section").count()} sections`;
  });

  await step("Connect the wallet and sign in (SIWS)", async (c) => {
    const before = signCalls.message;
    await page.getByTestId("landing-hero-cta").click();
    await page.getByText(WALLET_NAME).first().click();
    await page.waitForURL(/\/agents(\?|$)/, { timeout: 60_000 });
    const session = await page.evaluate(() => localStorage.getItem("tma.session"));
    must(session, "no tma.session after sign-in");
    must(JSON.parse(session).wallet === PUB, "the session wallet is not the test wallet");
    must(signCalls.message - before === 1, `SIWS needed ${signCalls.message - before} message signatures, expected 1`);
    await c.verify("connected", '[data-testid="agents-page"]', '[data-testid="app-nav"]', 1);
    return "signed in with one message signature";
  });

  await step("Agent detail /agents/:id renders (fixture agent)", async (c) => {
    await page.goto(`${WEB}/agents/${encodeURIComponent(AGENT_ID)}`, { waitUntil: "domcontentloaded" });
    await c.verify("agent-detail", '[data-testid="agent-detail"]', '[data-testid="agent-name"]', 1);
    const name = (await page.getByTestId("agent-name").innerText()).trim();
    must(name.length > 0, "agent name is empty");
    must((await page.getByTestId("choose-tasks").count()) === 1, "Choose tasks button missing");
    return name;
  });

  await step(`Choose ${TASK} and get an itemized quote`, async (c) => {
    const taskId = await catalogTaskId(TASK);
    await page.getByTestId("choose-tasks").click();
    await page.waitForURL(/\/agents\/[^/]+\/evaluate/, { timeout: 30_000 });
    await page.getByTestId("task-filter-row").first().waitFor({ timeout: 45_000 });
    const rows = page.getByTestId("task-filter-row");
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const r = rows.nth(i);
      if ((await r.getAttribute("aria-checked")) === "true" && (await r.getAttribute("data-task-id")) !== taskId) await r.click();
    }
    const target = page.locator(`[data-testid="task-filter-row"][data-task-id="${taskId}"]`);
    must((await target.count()) === 1, `task ${TASK} is not in the run list`);
    if ((await target.getAttribute("aria-checked")) !== "true") await target.click();
    await page.getByTestId("quote-validity").waitFor({ timeout: 45_000 });
    await c.verify("quote", '[data-testid="select-tasks-page"]', '[data-testid="summary-total"]', 1);
    const total = (await page.getByTestId("summary-total").innerText()).replace(/\s+/g, " ");
    must(/SOL/.test(total), `the total has no SOL amount: "${total}"`);
    return `total "${total}"`;
  });

  await step("Pay and start with one wallet signature", async () => {
    const pay = page.getByTestId("pay-and-start");
    await pay.waitFor({ state: "visible", timeout: 30_000 });
    must(await pay.isEnabled(), "Pay and start is disabled");
    const before = signCalls.transaction;
    const reqPromise = page.waitForRequest((r) => r.method() === "POST" && /\/evaluations$/.test(new URL(r.url()).pathname), { timeout: 180_000 });
    await pay.click();
    // When the wallet adapter is not connected (autoConnect is off), the first press connects it and
    // asks for a second press ("Connect your wallet to pay."). This is the designed behaviour.
    const err = page.getByTestId("pay-error");
    if (await err.waitFor({ state: "visible", timeout: 6_000 }).then(() => true, () => false)) {
      const msg = (await err.innerText()).trim();
      must(/connect your wallet/i.test(msg), `pay error before the wallet prompt: ${msg}`);
      await page.waitForFunction(() => !(document.querySelector('[data-testid="pay-and-start"]') as HTMLButtonElement | null)?.disabled, null, { timeout: 15_000 });
      await sleep(1000);
      await pay.click();
    }
    const req = await reqPromise;
    state.txSig = (req.postDataJSON() as { txSig?: string })?.txSig;
    must(state.txSig, "POST /evaluations has no txSig");
    await page.waitForURL(/\/evaluations\/[0-9a-f-]{36}/, { timeout: 120_000 });
    state.evaluationId = page.url().match(/\/evaluations\/([0-9a-f-]{36})/)![1];
    must(signCalls.transaction - before === 1, `the payment needed ${signCalls.transaction - before} transaction signatures, expected 1`);
    const rpc = await rpcCheckPayment(state.txSig);
    return `evaluation ${state.evaluationId}, ${rpc}`;
  });

  await step("Running evaluation moves to issued, event log renders", async (c) => {
    const seen: string[] = [];
    const until = Date.now() + MAX_WAIT_MS;
    let ui: string | null = null;
    for (;;) {
      ui = await page.getByTestId("running-evaluation-page").getAttribute("data-ui-state").catch(() => null);
      if (ui && !seen.includes(ui)) {
        seen.push(ui);
        log(`     evaluation state: ${ui}`);
      }
      if (ui === "issued" || ui === "cancelled" || ui === "failed") break;
      if (Date.now() > until) throw new Assertion(`evaluation not issued after ${argv["max-wait-min"]} min (last state ${ui})`);
      await sleep(2000);
    }
    must(ui === "issued", `evaluation ended ${ui}, states ${seen.join(" > ")}`);
    await c.verify("evaluation-issued", '[data-testid="running-evaluation-page"]', '[data-testid="event-row"]', 2);
    must((await page.getByTestId("issued-banner").count()) === 1, "issued banner missing");
    const link = page.getByTestId("view-profile");
    must((await link.count()) === 1, "View public profile link missing");
    state.evaluationSlug = new URL((await link.getAttribute("href")) ?? "", WEB).pathname.split("/e/")[1];
    must(state.evaluationSlug, "the profile link has no /e/:slug");
    return `states ${seen.join(" > ")}, profile /e/${state.evaluationSlug}`;
  });

  await step("Public profile /e/:slug shows the score; Verify -> VERIFIED", async (c) => {
    await page.goto(`${WEB}/e/${state.evaluationSlug}`, { waitUntil: "domcontentloaded" });
    await c.verify("profile", '[data-testid="public-profile"]', '[data-testid="task-card"]', 1);
    const scoreText = (await page.getByTestId("profile-score").first().innerText()).replace(/\s+/g, " ");
    const score = Number(scoreText.match(/\d+(\.\d+)?/)?.[0]);
    // The stub model applies the reference patch, so the grader passes the task.
    must(Number.isFinite(score) && score > 0, `profile score is not a positive number: "${scoreText}"`);
    state.score = score;
    await page.getByTestId("verify-button").click({ timeout: 90_000 });
    // The verdict (verify-result) or an error message (the same .pp-verify element without the test id).
    await page.locator('[data-testid="verify-result"], .pp-verify').first().waitFor({ timeout: 120_000 });
    if ((await page.getByTestId("verify-result").count()) === 0) {
      throw new Assertion(`verify failed: ${(await page.locator(".pp-verify").first().innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
    }
    const result = (await page.getByTestId("verify-result").innerText()).replace(/\s+/g, " ").trim();
    must(/^VERIFIED/.test(result), `verify result: ${result}`);
    state.verify = result;
    await c.verify("profile-verified", '[data-testid="public-profile"]', '[data-testid="verify-result"]', 1);
    return `score ${score}, ${result.slice(0, 80)}`;
  });

  await step("My evaluations lists the issued evaluation", async (c) => {
    await page.goto(WEB + "/evaluations", { waitUntil: "domcontentloaded" });
    await c.verify("my-evaluations", '[data-testid="my-evaluations"]', '[data-testid="evaluations-table-row"]', 1);
    must((await page.getByTestId("status-issued").count()) >= 1, "no issued evaluation in the list");
    return `${await page.getByTestId("evaluations-table-row").count()} row(s)`;
  });

  await step("Agents ranking lists the agent with a score", async (c) => {
    await page.goto(WEB + "/agents", { waitUntil: "domcontentloaded" });
    await c.verify("agents", '[data-testid="agents-page"]', '[data-testid="agents-table-row"]', 1);
    const scores = (await page.getByTestId("agent-score").allInnerTexts()).map(Number).filter((n) => Number.isFinite(n));
    must(scores.length >= 1, "no agent has a score");
    return `scores ${scores.join(", ")}`;
  });

  await step(`Public task page /tasks/${TASK}`, async (c) => {
    await page.goto(`${WEB}/tasks/${TASK}`, { waitUntil: "domcontentloaded" });
    await c.verify("task-page", '[data-testid="task-profile"]', '[data-testid="task-title"]', 1);
    const title = (await page.getByTestId("task-title").innerText()).trim();
    must(title.length > 0, "task title is empty");
    return title;
  });

  await step("Hermetic: no request reached a production host; the app RPC was routed", async () => {
    must(prodRequests.length === 0, `${prodRequests.length} request(s) to a production host: ${prodRequests.slice(0, 3).join(", ")}`);
    must(routed.rpc > 0, "the app made no RPC call through the route (the devnet RPC route did not match)");
    must(pageErrors.length === 0, `${pageErrors.length} pageerror event(s) in the run`);
    return `routed: ${routed.rpc} RPC, ${routed.rpcWs} WebSocket, ${routed.ipfs} IPFS`;
  });

  await browser.close();
  finish(startedAt);
}

// ------------------------------------------------------------------------------------------------
// Report (no secret: the wallet is shown shortened)

function finish(startedAt: Date): void {
  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.length - pass;
  const summary = {
    web: WEB,
    api: API,
    wallet: `${PUB.slice(0, 4)}...${PUB.slice(-4)}`,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    pass,
    fail,
    pageErrors: pageErrors.length,
    prodRequests: prodRequests.length,
    routed,
    signatures: signCalls,
    evaluationId: state.evaluationId,
    evaluationSlug: state.evaluationSlug,
    score: state.score,
    verify: state.verify,
  };
  writeFileSync(join(OUT, "browser-hermetic.json"), JSON.stringify({ summary, steps: results, pageErrors, prodRequests }, null, 2));
  const md = [
    `**${pass} pass, ${fail} fail** · pageerror events: ${pageErrors.length} · production requests: ${prodRequests.length} · wallet signatures: ${signCalls.message} message, ${signCalls.transaction} transaction`,
    "",
    "| # | Step | Result | Time | Detail |",
    "|---|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.name} | ${r.status.toUpperCase()} | ${(r.ms / 1000).toFixed(1)} s | ${(r.error ?? r.detail).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 300)} |`),
    "",
  ].join("\n");
  writeFileSync(join(OUT, "browser-hermetic.md"), md);
  console.log(`\n${pass} pass, ${fail} fail. Report: ${join(OUT, "browser-hermetic.json")}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("setup error:", e instanceof Error ? e.message : e);
  process.exit(2);
});

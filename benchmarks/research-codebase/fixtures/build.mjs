#!/usr/bin/env node
// Writes the fixture repo, the questions, the span truth and the reference solution of this task, byte for byte.
//
//   node benchmarks/research-codebase/fixtures/build.mjs
//
// The code is invented: a fictional shop backend, no real project. Every answer span is computed from the
// fixture source (the declaration line to the closing brace), never typed by hand.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = join(import.meta.dirname, '..');

export const FILES = {
  'src/config/env.ts': `export interface AppConfig {
  port: number;
  databaseUrl: string;
  logLevel: 'debug' | 'info' | 'warn';
}

export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const level = env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'warn' ? env.LOG_LEVEL : 'info';
  return { port: parsePort(env.PORT), databaseUrl, logLevel: level };
}
`,
  'src/auth/session.ts': `export interface Session {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

const SESSION_TTL_MS = 30 * 60 * 1000;

export function createSession(userId: string, now: number): Session {
  return {
    id: userId + ':' + now.toString(36),
    userId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    revokedAt: null,
  };
}

export function isSessionExpired(session: Session, now: number): boolean {
  if (session.revokedAt !== null) return true;
  return now >= session.expiresAt;
}

export function revokeSession(session: Session, now: number): Session {
  if (session.revokedAt !== null) return session;
  return { ...session, revokedAt: now };
}
`,
  'src/auth/password.ts': `import { createHash, timingSafeEqual } from 'node:crypto';

export function hashPassword(password: string, salt: string): string {
  return createHash('sha256').update(salt + ':' + password).digest('hex');
}

export function verifyPassword(password: string, salt: string, expectedHex: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
`,
  'src/orders/pricing.ts': `export interface LineItem {
  sku: string;
  unitCents: number;
  quantity: number;
}

export interface Coupon {
  code: string;
  percentOff: number;
  minSubtotalCents: number;
}

export function calculateSubtotal(items: LineItem[]): number {
  let total = 0;
  for (const item of items) total += item.unitCents * item.quantity;
  return total;
}

export function applyCoupon(subtotalCents: number, coupon: Coupon | null): number {
  if (coupon === null) return subtotalCents;
  if (subtotalCents < coupon.minSubtotalCents) return subtotalCents;
  const discount = Math.floor((subtotalCents * coupon.percentOff) / 100);
  return subtotalCents - discount;
}

const TAX_RATE_BY_REGION: Record<string, number> = { eu: 0.21, us: 0.07, br: 0.17 };

export function calculateTax(amountCents: number, region: string): number {
  const rate = TAX_RATE_BY_REGION[region] ?? 0;
  return Math.round(amountCents * rate);
}
`,
  'src/orders/legacy/pricing.ts': `// Deprecated: replaced by src/orders/pricing.ts. Kept only for the v1 import job.
export function applyCoupon(subtotal: number, percent: number): number {
  return subtotal - subtotal * (percent / 100);
}

export function calculateTax(amount: number): number {
  return amount * 0.2;
}
`,
  'src/orders/checkout.ts': `import { reserveStock } from '../inventory/stock.js';
import { applyCoupon, calculateSubtotal, calculateTax, type Coupon, type LineItem } from './pricing.js';

export interface Order {
  userId: string;
  items: LineItem[];
  totalCents: number;
}

export function validateCart(items: LineItem[]): string[] {
  const problems: string[] = [];
  if (items.length === 0) problems.push('cart is empty');
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      problems.push('invalid quantity for ' + item.sku);
    }
  }
  return problems;
}

export function placeOrder(userId: string, items: LineItem[], coupon: Coupon | null, region: string): Order {
  const problems = validateCart(items);
  if (problems.length > 0) throw new Error(problems.join('; '));
  for (const item of items) reserveStock(item.sku, item.quantity);
  const discounted = applyCoupon(calculateSubtotal(items), coupon);
  return { userId, items, totalCents: discounted + calculateTax(discounted, region) };
}
`,
  'src/inventory/stock.ts': `const available = new Map<string, number>();

export function seedStock(sku: string, quantity: number): void {
  available.set(sku, quantity);
}

export function reserveStock(sku: string, quantity: number): void {
  const current = available.get(sku) ?? 0;
  if (current < quantity) throw new Error('insufficient stock for ' + sku);
  available.set(sku, current - quantity);
}

export function releaseStock(sku: string, quantity: number): void {
  const current = available.get(sku) ?? 0;
  available.set(sku, current + quantity);
}
`,
  'src/http/router.ts': `export interface Route {
  method: 'GET' | 'POST';
  path: string;
  handler: (body: unknown) => { status: number; body: unknown };
}

export function handleHealth(): { status: number; body: unknown } {
  return { status: 200, body: { ok: true } };
}

export function registerRoutes(routes: Route[]): Map<string, Route['handler']> {
  const table = new Map<string, Route['handler']>();
  for (const route of routes) table.set(route.method + ' ' + route.path, route.handler);
  table.set('GET /health', handleHealth);
  return table;
}
`,
  'src/http/rate-limit.ts': `export interface Limiter {
  allow(clientId: string, now: number): boolean;
}

export function rejectTooManyRequests(retryAfterSeconds: number): { status: number; headers: Record<string, string>; body: string } {
  return {
    status: 429,
    headers: { 'retry-after': String(retryAfterSeconds) },
    body: 'rate limit exceeded',
  };
}

export function createRateLimiter(maxPerWindow: number, windowMs: number): Limiter {
  const hits = new Map<string, number[]>();
  return {
    allow(clientId, now) {
      const recent = (hits.get(clientId) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= maxPerWindow) return false;
      recent.push(now);
      hits.set(clientId, recent);
      return true;
    },
  };
}
`,
  'src/notifications/email.ts': `import type { Order } from '../orders/checkout.js';

export function renderReceiptEmail(order: Order): string {
  const lines = order.items.map((i) => i.quantity + ' x ' + i.sku);
  return 'Thanks for your order.\\n' + lines.join('\\n') + '\\nTotal: ' + (order.totalCents / 100).toFixed(2);
}

export function sendReceipt(order: Order, send: (to: string, text: string) => void): void {
  send(order.userId + '@example.test', renderReceiptEmail(order));
}
`,
  'src/util/retry.ts': `export function backoffDelayMs(attempt: number, baseMs = 100, capMs = 5000): number {
  return Math.min(capMs, baseMs * 2 ** attempt);
}

export async function retryWithBackoff<T>(task: () => Promise<T>, maxAttempts: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt)));
    }
  }
  throw lastError;
}
`,
};

export const README = `# shop-backend (fixture)

A small invented backend. Source is under \`src/\`, one folder per area:
\`auth\`, \`config\`, \`http\`, \`inventory\`, \`notifications\`, \`orders\`, \`util\`.
`;

// id, question (never names the function), file, function
const QUESTIONS = [
  ['q1', 'Which function decides whether a user session can no longer be used, because it timed out or was revoked?', 'src/auth/session.ts', 'isSessionExpired'],
  ['q2', 'Which function computes how long to wait before the next retry of a failed task?', 'src/util/retry.ts', 'backoffDelayMs'],
  ['q3', 'Which function applies a percentage coupon to the subtotal in the CURRENT pricing code, not the deprecated one?', 'src/orders/pricing.ts', 'applyCoupon'],
  ['q4', 'Which function turns an amount and a region into the tax in cents for the CURRENT pricing code?', 'src/orders/pricing.ts', 'calculateTax'],
  ['q5', 'Which function reports problems when a cart is empty or has an item whose quantity is not a positive integer?', 'src/orders/checkout.ts', 'validateCart'],
  ['q6', 'Which function builds the HTTP response sent to a client that went over its request limit?', 'src/http/rate-limit.ts', 'rejectTooManyRequests'],
  ['q7', 'Which function reads the listening port from the environment and falls back to a default when it is missing?', 'src/config/env.ts', 'parsePort'],
  ['q8', 'Which function gives reserved units back to the available stock of a product?', 'src/inventory/stock.ts', 'releaseStock'],
];

function spanOf(file, fn) {
  const lines = FILES[file].split('\n');
  const decl = new RegExp(`^export (?:async )?function ${fn}\\b`);
  const starts = lines.flatMap((l, i) => (decl.test(l) ? [i] : []));
  if (starts.length !== 1) throw new Error(`${file}: expected one declaration of ${fn}, found ${starts.length}`);
  const end = lines.findIndex((l, i) => i > starts[0] && l === '}');
  if (end < 0) throw new Error(`${file}: no closing brace after ${fn}`);
  return { start: starts[0] + 1, end: end + 1 };
}

export const QUESTIONS_JSON = `${JSON.stringify(
  {
    repo: 'repo',
    answer_format: 'path relative to repo/, a colon and a 1-based line number inside the function, e.g. src/foo/bar.ts:42',
    questions: QUESTIONS.map(([id, question]) => ({ id, question })),
  },
  null,
  2,
)}\n`;

export const TRUTH_JSON = `${JSON.stringify(
  {
    answers: QUESTIONS.map(([id, , file, fn]) => ({ id, file, function: fn, ...spanOf(file, fn) })),
  },
  null,
  2,
)}\n`;

export const ANSWERS_JSON = `${JSON.stringify(
  {
    answers: QUESTIONS.map(([id, , file, fn]) => ({ id, answer: `${file}:${spanOf(file, fn).start}` })),
  },
  null,
  2,
)}\n`;

export const QUESTION_SYMBOLS = QUESTIONS.map(([id, , file, fn]) => ({ id, file, fn }));

function patchFor(path, content) {
  const dir = mkdtempSync(join(tmpdir(), 'research-codebase-patch-'));
  try {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), content);
    const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, encoding: 'utf-8' });
    git('init', '-q');
    git('add', path);
    return git('diff', '--cached', '--no-color');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const SOLUTION_PATCH = () => patchFor('out/answers.json', ANSWERS_JSON);

if (import.meta.url === `file://${process.argv[1]}`) {
  const put = (rel, content) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  for (const [rel, content] of Object.entries(FILES)) put(`environment/repo/${rel}`, content);
  put('environment/repo/README.md', README);
  put('environment/data/questions.json', QUESTIONS_JSON);
  put('tests/hidden/truth.json', TRUTH_JSON);
  put('solution/answers.json', ANSWERS_JSON);
  put('solution/solution.patch', SOLUTION_PATCH());
  console.log(`wrote ${Object.keys(FILES).length} fixture files, ${QUESTIONS.length} questions`);
}

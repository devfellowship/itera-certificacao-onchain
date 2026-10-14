// Hidden grader of dfl-html-report (plan 20261012-testmyagent-dfl-benchmark-tasks, pick B).
// One `it` per deterministic check. It runs in the grading container, which has no network and a
// headless Chromium: the grader image chromium-axe (task.json verifier.image), whose
// /opt/grader/lib.mjs gives launch / open / axe. The page is loaded from disk, offline.
// The render checks are the three assertions of verify-render: MOUNT, NO ERRORS, CONTROL.
// The upload itself is checked by the mcp_state scorer (tests/hidden/mcp/media/assert.json).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface Cell {
  task: string;
  metric: 'volume' | 'cost_usd' | 'checkability';
  value: number | null;
  inferred: boolean;
}
interface Key {
  order_volume: string[];
  order_cost: string[];
  top5_volume: string[];
  top5_cost: string[];
  total_volume: number;
  total_cost_usd: number;
  cells: Cell[];
  upload_url: string;
}

const key: Key = JSON.parse(readFileSync(new URL('./key.json', import.meta.url), 'utf-8'));
const REPORT = resolve('out/report.html');
const RESULT = resolve('out/result.json');
const html = existsSync(REPORT) ? readFileSync(REPORT) : null;
const text = html ? html.toString('utf-8') : '';
// Absolute path inside the grader image; a variable so vite does not try to bundle it.
const GRADER_LIB = process.env.ITERA_GRADER_LIB ?? '/opt/grader/lib.mjs';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Page = any;

interface ViewFacts {
  pageErrors: string[];
  requests: string[];
  mountedChars: number;
  bars: { bar: string; task: string; width: number; visible: boolean }[];
  cells: { task: string; metric: string; text: string; inferredClass: boolean; pseudo: boolean }[];
  totals: Record<string, string>;
  background: [number, number, number, number];
  scrollWidth: number;
  clientWidth: number;
  contrastViolations: number;
}

const facts: Record<'wide' | 'narrow', ViewFacts | null> = { wide: null, narrow: null };
let loadError = '';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let grader: any = null;
let browser: { open: Function; close: () => Promise<void> } | null = null;

async function inspect(page: Page): Promise<Omit<ViewFacts, 'pageErrors' | 'requests' | 'contrastViolations'>> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
    };
    const pseudo = (el: Element) =>
      [el, ...Array.from(el.querySelectorAll('*'))].some((e) =>
        ['::before', '::after'].some((p) => {
          const c = getComputedStyle(e, p).content;
          return c !== 'none' && c !== 'normal' && c !== '""' && c !== "''";
        }),
      );
    const rgba = (c: string): [number, number, number, number] => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return [255, 255, 255, 0];
      const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
    };
    const bodyBg = rgba(getComputedStyle(document.body).backgroundColor);
    const htmlBg = rgba(getComputedStyle(document.documentElement).backgroundColor);
    const totals: Record<string, string> = {};
    document.querySelectorAll('[data-total]').forEach((el) => {
      totals[el.getAttribute('data-total') ?? ''] = (el as HTMLElement).innerText;
    });
    return {
      mountedChars: document.body ? document.body.innerText.trim().length : 0,
      bars: Array.from(document.querySelectorAll('[data-bar]')).map((el) => ({
        bar: el.getAttribute('data-bar') ?? '',
        task: el.getAttribute('data-task') ?? '',
        width: el.getBoundingClientRect().width,
        visible: visible(el),
      })),
      cells: Array.from(document.querySelectorAll('#checkability tr[data-task] td[data-metric]')).map((td) => ({
        task: td.closest('tr')!.getAttribute('data-task') ?? '',
        metric: td.getAttribute('data-metric') ?? '',
        text: (td as HTMLElement).innerText,
        inferredClass: td.classList.contains('inferred') || td.querySelector('.inferred') !== null,
        pseudo: pseudo(td),
      })),
      totals,
      // A transparent root shows the browser canvas, which is white.
      background: bodyBg[3] > 0 ? bodyBg : htmlBg[3] > 0 ? htmlBg : ([255, 255, 255, 1] as [number, number, number, number]),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
}

async function load(width: number, height: number): Promise<ViewFacts> {
  // open() arms the pageerror listener BEFORE the load and aborts + counts every non-local request.
  const { page, context, pageErrors, blocked } = await browser!.open(REPORT, { width, height });
  await page.waitForTimeout(300);
  const seen = await inspect(page);
  let contrastViolations = -1;
  try {
    const violations: { impact: string; nodes: number }[] = await grader.axe(page, ['color-contrast']);
    contrastViolations = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').reduce((n, v) => n + v.nodes, 0);
  } catch {
    contrastViolations = -1;
  }
  await context.close();
  return { ...seen, pageErrors, requests: blocked, contrastViolations };
}

beforeAll(async () => {
  if (!html) {
    loadError = 'out/report.html does not exist';
    return;
  }
  try {
    grader = await import(/* @vite-ignore */ GRADER_LIB);
    browser = await grader.launch();
    facts.wide = await load(1280, 800);
    facts.narrow = await load(390, 844);
  } catch (err) {
    loadError = `the page could not be rendered: ${String((err as Error)?.message ?? err).slice(0, 300)}`;
  }
});

afterAll(async () => {
  await browser?.close();
});

const wide = () => {
  expect(loadError).toBe('');
  return facts.wide!;
};
const narrow = () => {
  expect(loadError).toBe('');
  return facts.narrow!;
};

/** "$1,234.50 *" -> 1234.5. Thousands separators (comma, space, thin space, apostrophe) are removed. */
export function parseNumber(raw: string): number | null {
  const t = raw.replace(/(\d)[,\s  '](?=\d{3}(\D|$))/g, '$1');
  const m = t.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
/** Visible marker text: anything left after removing the number, the currency and the separators. */
const markerText = (raw: string) => raw.replace(/no data/gi, '').replace(/US\$|USD|\$/g, '').replace(/[\d.,\s  ']/g, '');
const close = (a: number | null, b: number, metric: string) => a !== null && (metric === 'cost_usd' ? Math.abs(a - b) < 0.005 : a === b);
const cellOf = (f: ViewFacts, c: Cell) => f.cells.find((x) => x.task === c.task && x.metric === c.metric);
const order = (f: ViewFacts, bar: string) => f.bars.filter((b) => b.bar === bar && b.visible).map((b) => b.task);
const luminance = ([r, g, b]: [number, number, number, number]) => {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};

describe('document (gate)', () => {
  it('starts with <!doctype html>, declares utf-8 in the first 1024 bytes, and is at most 1 MB', () => {
    expect(html).not.toBeNull();
    const head = html!.subarray(0, 1024).toString('utf-8');
    expect(head.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(/<meta\s+charset=["']?utf-8["']?\s*\/?>/i.test(head)).toBe(true);
    expect(html!.length).toBeLessThanOrEqual(1024 * 1024);
  });
  it('is self-contained: no external script, stylesheet or resource, no fetch or XMLHttpRequest', () => {
    expect(html).not.toBeNull();
    expect(/<script[^>]*\ssrc\s*=/i.test(text)).toBe(false);
    expect(/<link[^>]*rel\s*=\s*["']?stylesheet/i.test(text)).toBe(false);
    expect(/\bsrc\s*=\s*["']?(https?:)?\/\//i.test(text)).toBe(false);
    expect(/<link[^>]*\shref\s*=\s*["']?(https?:)?\/\//i.test(text)).toBe(false);
    expect(/@import|url\(\s*["']?(https?:)?\/\//i.test(text)).toBe(false);
    expect(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/.test(text)).toBe(false);
  });
  it('makes no network request while it loads', () => {
    expect(wide().requests).toEqual([]);
    expect(narrow().requests).toEqual([]);
  });
});

describe('render: mount, no errors, control', () => {
  it('MOUNT: the body has visible content at 1280 px and at 390 px', () => {
    expect(wide().mountedChars).toBeGreaterThan(200);
    expect(narrow().mountedChars).toBeGreaterThan(200);
  });
  it('NO ERRORS: zero pageerror events at both widths', () => {
    expect(wide().pageErrors).toEqual([]);
    expect(narrow().pageErrors).toEqual([]);
  });
  it('CONTROL: at least 16 visible bars', () => {
    expect(wide().bars.filter((b) => b.visible).length).toBeGreaterThanOrEqual(16);
  });
});

describe('numbers', () => {
  it('the table has one row per task type with the three cells', () => {
    const f = wide();
    for (const c of key.cells) expect(cellOf(f, c), `${c.task} ${c.metric}`).toBeDefined();
  });
  it('every non-null value appears in its table cell', () => {
    const f = wide();
    const wrong = key.cells.filter((c) => c.value !== null && !close(parseNumber(cellOf(f, c)?.text ?? ''), c.value, c.metric));
    expect(wrong.map((c) => `${c.task}.${c.metric}`)).toEqual([]);
  });
  it('a missing value shows "no data", never a number, and has no bar', () => {
    const f = wide();
    for (const c of key.cells.filter((x) => x.value === null)) {
      const cell = cellOf(f, c)?.text ?? '';
      expect(/no data/i.test(cell), `${c.task}.${c.metric}`).toBe(true);
      expect(parseNumber(cell), `${c.task}.${c.metric}`).toBeNull();
      if (c.metric !== 'checkability') expect(f.bars.some((b) => b.bar === c.metric && b.task === c.task)).toBe(false);
    }
  });
  it('the totals match the sums of the non-null values', () => {
    const f = wide();
    expect(parseNumber(f.totals.volume ?? '')).toBe(key.total_volume);
    expect(close(parseNumber(f.totals.cost_usd ?? ''), key.total_cost_usd, 'cost_usd')).toBe(true);
  });
});

describe('order', () => {
  it('top 5 by volume', () => expect(order(wide(), 'volume').slice(0, 5)).toEqual(key.top5_volume));
  it('top 5 by cost', () => expect(order(wide(), 'cost_usd').slice(0, 5)).toEqual(key.top5_cost));
  it('every bar in order, and the bar widths never grow down the ranking', () => {
    const f = wide();
    expect(order(f, 'volume')).toEqual(key.order_volume);
    expect(order(f, 'cost_usd')).toEqual(key.order_cost);
    for (const bar of ['volume', 'cost_usd']) {
      const w = f.bars.filter((b) => b.bar === bar && b.visible).map((b) => b.width);
      expect(w.every((x, i) => i === 0 || x <= w[i - 1]! + 1), bar).toBe(true);
      expect(w[0]! > w[w.length - 1]!, bar).toBe(true);
    }
  });
});

describe('inferred marks', () => {
  it('every inferred number has the class and a visible marker', () => {
    const f = wide();
    const bad = key.cells
      .filter((c) => c.inferred)
      .filter((c) => {
        const cell = cellOf(f, c);
        return !cell || !cell.inferredClass || (markerText(cell.text) === '' && !cell.pseudo);
      });
    expect(bad.map((c) => `${c.task}.${c.metric}`)).toEqual([]);
  });
  it('no measured number has a mark', () => {
    const f = wide();
    const bad = key.cells
      .filter((c) => !c.inferred && c.value !== null)
      .filter((c) => {
        const cell = cellOf(f, c);
        return !cell || cell.inferredClass || markerText(cell.text) !== '' || cell.pseudo;
      });
    expect(bad.map((c) => `${c.task}.${c.metric}`)).toEqual([]);
  });
});

describe('theme, contrast, layout', () => {
  it('dark theme: the page background is dark', () => {
    expect(luminance(wide().background)).toBeLessThan(0.2);
  });
  it('axe-core color-contrast: zero serious violations at 1280 px', () => expect(wide().contrastViolations).toBe(0));
  it('axe-core color-contrast: zero serious violations at 390 px', () => expect(narrow().contrastViolations).toBe(0));
  it('no horizontal scroll at 390 px', () => expect(narrow().scrollWidth).toBeLessThanOrEqual(narrow().clientWidth + 1));
});

describe('delivery record', () => {
  it('out/result.json names the uploaded url and the sha256 of out/report.html', () => {
    expect(html).not.toBeNull();
    const r = JSON.parse(readFileSync(RESULT, 'utf-8'));
    expect(r.url).toBe(key.upload_url);
    expect(r.sha256).toBe(createHash('sha256').update(html!).digest('hex'));
  });
});

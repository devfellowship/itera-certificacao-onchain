#!/usr/bin/env node
// Generator of the ui-design-audit task (pick C of plan 20261012-testmyagent-dfl-benchmark-tasks).
// From one seed it writes:
//   mcp/browser/seed.json              the browser@1 seed: app.local (the app, with the defects) and
//                                      design.local (the golden design as HTML, Q7 option A)
//   tests/hidden/key.json              the injected defects and the decoys (the answer key)
//   tests/hidden/mcp/browser/assert.json  coverage: every screen seen at 1280 and 390 px
//   solution/findings.json, solution/solution.patch, solution/mcp-calls.jsonl
// The design PNGs and the bounding boxes come from fixtures/render.mjs (needs the browser@1 image).
//
//   node fixtures/gen.mjs --seed 1 [--out <dir>]      (default --out: the task folder)
//
// The app is a small 3-screen order tool ("Northwind Ops"), invented. Every element that a defect
// can touch has a data-testid and its own CSS rule, so the golden build and the app build have the
// SAME structure and differ only in values: the stylesheet does not reveal the defects.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SCREENS = { list: '/', detail: '/orders/1042', form: '/new' };
export const VIEWPORTS = [
  { name: '1280', width: 1280, height: 800 },
  { name: '390', width: 390, height: 844 },
];
export const CATEGORIES = ['spacing', 'color', 'typography', 'copy', 'missing-element', 'order', 'size'];
export const SKELETON = '{\n  "findings": []\n}\n';
const FONT = "'DejaVu Sans', sans-serif";

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const shuffle = (r, list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const T = (id) => `[data-testid="${id}"]`;

/** The golden model: per-testid CSS (base + ≤600 px), copy, element order. */
function goldenModel() {
  const css = {
    'app-header': { padding: '16px 24px', background: '#111827', color: '#f9fafb' },
    'brand-name': { 'font-size': '18px', 'font-weight': '700', color: '#f9fafb' },
    'brand-icon': { width: '20px', height: '20px' },
    'last-updated': { 'font-size': '13px', color: '#d1d5db' },
    'page-title-list': { 'font-size': '26px', 'font-weight': '700', color: '#111827', margin: '0' },
    'new-order-btn': { background: '#2952cc', color: '#ffffff', 'border-radius': '8px', height: '40px', padding: '0 16px', 'font-weight': '600' },
    'search-input': { height: '40px', 'border-radius': '8px', padding: '0 12px', border: '1px solid #9ca3af' },
    'orders-table': { 'border-spacing': '0', width: '100%' },
    'order-cell': { padding: '12px', 'border-bottom': '1px solid #e5e7eb' },
    'status-badge': { background: '#dcfce7', color: '#166534', 'border-radius': '999px', padding: '2px 10px', 'font-size': '13px', 'font-weight': '600' },
    'summary-card': { 'margin-top': '24px', padding: '16px', 'border-radius': '8px', background: '#f3f4f6' },
    'page-title-detail': { 'font-size': '26px', 'font-weight': '700', color: '#111827', margin: '0' },
    'detail-status': { background: '#dbeafe', color: '#1e40af', 'border-radius': '999px', padding: '4px 12px', 'font-size': '14px', 'font-weight': '600' },
    'items-list': { 'list-style': 'none', padding: '0', margin: '16px 0', display: 'flex', 'flex-direction': 'column', gap: '8px' },
    'item-row': { display: 'flex', 'justify-content': 'space-between', padding: '12px 16px', border: '1px solid #e5e7eb', 'border-radius': '8px' },
    'order-total': { 'font-size': '20px', 'font-weight': '700', color: '#111827' },
    'refund-btn': { background: '#b91c1c', color: '#ffffff', 'border-radius': '8px', height: '40px', padding: '0 16px', 'font-weight': '600' },
    'notes-text': { color: '#374151', 'font-size': '15px', 'line-height': '24px' },
    'page-title-form': { 'font-size': '26px', 'font-weight': '700', color: '#111827', margin: '0' },
    'form-fields': { display: 'flex', 'flex-direction': 'column', gap: '20px', 'max-width': '560px' },
    'customer-label': { 'font-size': '14px', 'font-weight': '600', color: '#111827' },
    'customer-input': { height: '40px', 'border-radius': '8px', padding: '0 12px', border: '1px solid #9ca3af' },
    'amount-input': { height: '40px', 'border-radius': '8px', padding: '0 12px', border: '1px solid #9ca3af' },
    'help-text': { 'font-size': '13px', color: '#4b5563' },
    'submit-btn': { background: '#2952cc', color: '#ffffff', 'border-radius': '8px', height: '44px', padding: '0 20px', 'font-weight': '600' },
  };
  const mobile = {
    'app-header': { padding: '12px 16px' },
    'page-title-list': { 'font-size': '22px' },
    'page-title-detail': { 'font-size': '22px' },
    'page-title-form': { 'font-size': '22px' },
    'summary-card': { padding: '12px' },
  };
  const copy = {
    'brand-name': 'Northwind Ops', 'page-title-list': 'Orders', 'new-order-btn': 'New order',
    'page-title-detail': 'Order #1042', 'refund-btn': 'Issue refund', 'notes-text': 'Customer asked for delivery after 5 pm. Gate code is on file.',
    'page-title-form': 'New order', 'customer-label': 'Customer name', 'submit-btn': 'Create order',
    'help-text': 'Amounts are in US dollars, taxes included.', 'order-total-label': 'Total',
  };
  return { css, mobile, copy, hidden: new Set(), order: { nav: ['nav-orders', 'nav-customers', 'nav-reports'], form: ['field-customer', 'field-amount', 'field-priority'] } };
}

/**
 * The defect catalog: 12 types. Each candidate is { type, category, accept, screen, testid, apply(model), ... }.
 * `scoped`: the type can be placed in the ≤600 px media block only (viewport 390).
 */
const CATALOG = [
  { type: 'padding', category: 'spacing', accept: ['spacing', 'size'], kind: 'px', scoped: true, targets: [
    { screen: 'detail', testid: 'item-row', prop: 'padding', from: '12px 16px', to: '6px 16px', expected: '12px', actual: '6px' },
    { screen: 'list', testid: 'order-cell', prop: 'padding', from: '12px', to: '6px', expected: '12px', actual: '6px' } ] },
  { type: 'gap', category: 'spacing', accept: ['spacing'], kind: 'px', scoped: true, targets: [
    { screen: 'form', testid: 'form-fields', prop: 'gap', from: '20px', to: '8px', expected: '20px', actual: '8px' },
    { screen: 'detail', testid: 'items-list', prop: 'gap', from: '8px', to: '20px', expected: '8px', actual: '20px' } ] },
  { type: 'text-color', category: 'color', accept: ['color'], kind: 'color', targets: [
    { screen: 'detail', testid: 'notes-text', prop: 'color', from: '#374151', to: '#9ca3af' },
    { screen: 'form', testid: 'help-text', prop: 'color', from: '#4b5563', to: '#b45309' } ] },
  { type: 'bg-color', category: 'color', accept: ['color'], kind: 'color', targets: [
    { screen: 'list', testid: 'new-order-btn', prop: 'background', from: '#2952cc', to: '#0f766e' },
    { screen: 'list', testid: 'status-badge', prop: 'background', from: '#dcfce7', to: '#fef3c7' },
    { screen: 'detail', testid: 'refund-btn', prop: 'background', from: '#b91c1c', to: '#ea580c' } ] },
  { type: 'font-weight', category: 'typography', accept: ['typography'], kind: 'weight', targets: [
    { screen: 'detail', testid: 'order-total', prop: 'font-weight', from: '700', to: '400' },
    { screen: 'form', testid: 'customer-label', prop: 'font-weight', from: '600', to: '400' } ] },
  { type: 'font-size', category: 'typography', accept: ['typography', 'size'], kind: 'px', scoped: true, targets: [
    { screen: 'list', testid: 'page-title-list', prop: 'font-size', from: '26px', to: '32px', mobileFrom: '22px', mobileTo: '28px' },
    { screen: 'detail', testid: 'page-title-detail', prop: 'font-size', from: '26px', to: '20px', mobileFrom: '22px', mobileTo: '17px' } ] },
  { type: 'copy', category: 'copy', accept: ['copy'], kind: 'text', targets: [
    { screen: 'form', testid: 'submit-btn', to: 'Create' },
    { screen: 'detail', testid: 'refund-btn', to: 'Refund' },
    { screen: 'list', testid: 'new-order-btn', to: 'Add order' } ] },
  { type: 'missing-icon', category: 'missing-element', accept: ['missing-element'], kind: null, targets: [
    { screen: 'list', testid: 'search-icon', also: ['search-input', 'search-box'] },
    { screen: 'detail', testid: 'back-icon', also: ['back-link'] } ] },
  { type: 'swapped-order', category: 'order', accept: ['order'], kind: null, targets: [
    { screen: 'list', testid: 'nav-customers', also: ['nav-reports', 'main-nav'], swap: ['nav', 1, 2], expected: 'Customers before Reports', actual: 'Reports before Customers' },
    { screen: 'form', testid: 'field-amount', also: ['field-customer', 'form-fields', 'amount-input', 'customer-input'], swap: ['form', 0, 1], expected: 'Customer name before Amount', actual: 'Amount before Customer name' } ] },
  { type: 'border-radius', category: 'size', accept: ['size', 'spacing'], kind: 'px', scoped: true, targets: [
    { screen: 'list', testid: 'search-input', prop: 'border-radius', from: '8px', to: '0px' },
    { screen: 'form', testid: 'submit-btn', prop: 'border-radius', from: '8px', to: '22px' } ] },
  { type: 'truncated-label', category: 'size', accept: ['size', 'copy'], kind: null, targets: [
    { screen: 'form', testid: 'customer-label', prop: 'max-width', from: 'none', to: '70px', truncate: true },
    { screen: 'detail', testid: 'page-title-detail', prop: 'max-width', from: 'none', to: '90px', truncate: true } ] },
  { type: 'height', category: 'size', accept: ['size'], kind: 'px', scoped: true, targets: [
    { screen: 'form', testid: 'amount-input', prop: 'height', from: '40px', to: '30px' },
    { screen: 'list', testid: 'new-order-btn', prop: 'height', from: '40px', to: '32px' } ] },
];
/** Decoys: differences that the instruction says NOT to report. */
const DECOYS = [
  { id: 'decoy-clock', screen: 'all', testid: 'last-updated', why: 'the live clock: the app shows the current time, the design a fixed time' },
  { id: 'decoy-subpixel', screen: 'list', testid: 'summary-card', prop: 'margin-top', expected: '24px', actual: '24.4px', why: 'a 0.4 px shift: anti-aliasing only, below the 1 px rule' },
];

/** Choose K = 8 defects of 8 distinct types, at least 2 per screen, 2 of them scoped to 390 px. */
export function chooseDefects(seed) {
  const r = rng(seed * 7919 + 17);
  for (let attempt = 0; attempt < 500; attempt++) {
    const types = shuffle(r, CATALOG).slice(0, 8);
    const chosen = types.map((t) => ({ t, target: pick(r, t.targets) }));
    const used = new Set();
    let clash = false;
    for (const c of chosen) {
      const k = `${c.target.screen}:${c.target.testid}`;
      if (used.has(k)) clash = true;
      used.add(k);
    }
    const perScreen = Object.keys(SCREENS).map((s) => chosen.filter((c) => c.target.screen === s).length);
    if (clash || perScreen.some((n) => n < 2)) continue;
    const scopable = chosen.filter((c) => c.t.scoped);
    if (scopable.length < 2) continue;
    const scoped = new Set(shuffle(r, scopable).slice(0, 2));
    return chosen.map((c, i) => ({ ...c, id: `D${i + 1}`, scope: scoped.has(c) ? '390' : 'both' }));
  }
  throw new Error(`seed ${seed}: no valid defect set`);
}

function applyDefects(model, defects) {
  const m = structuredClone({ ...model, hidden: [...model.hidden] });
  m.hidden = new Set(m.hidden);
  m.truncate = new Set();
  for (const d of defects) {
    const tg = d.target;
    if (d.t.type === 'copy') m.copy[tg.testid] = tg.to;
    else if (d.t.type === 'missing-icon') m.hidden.add(tg.testid);
    else if (d.t.type === 'swapped-order') {
      const [list, i, j] = tg.swap;
      [m.order[list][i], m.order[list][j]] = [m.order[list][j], m.order[list][i]];
    } else {
      if (d.scope === '390') m.mobile[tg.testid] = { ...(m.mobile[tg.testid] ?? {}), [tg.prop]: tg.mobileTo ?? tg.to };
      else {
        m.css[tg.testid] = { ...m.css[tg.testid], [tg.prop]: tg.to };
        // The ≤600 px block can override the property: the defect must show at 390 px too.
        if (m.mobile[tg.testid]?.[tg.prop] !== undefined) m.mobile[tg.testid][tg.prop] = tg.mobileTo ?? tg.to;
      }
      if (tg.truncate) m.truncate.add(tg.testid);
    }
  }
  return m;
}

/** The key entry of one defect: what a correct finding says. */
function keyEntry(d, model) {
  const tg = d.target;
  const e = { id: d.id, type: d.t.type, screen: tg.screen, viewport: d.scope, testid: tg.testid, match_testids: [tg.testid, ...(tg.also ?? [])], category: d.t.category, accept_categories: d.t.accept, value_kind: d.t.kind };
  if (d.t.type === 'copy') return { ...e, property: 'text', expected: model.copy[tg.testid], actual: tg.to };
  if (d.t.type === 'missing-icon') return { ...e, property: 'presence', expected: 'present', actual: 'absent' };
  if (d.t.type === 'swapped-order') return { ...e, property: 'order', expected: tg.expected, actual: tg.actual };
  if (tg.truncate) return { ...e, property: 'text-overflow', expected: `full label "${model.copy[tg.testid]}"`, actual: 'label cut with an ellipsis' };
  // A value can differ per viewport (a title is 26 px wide, 22 px at 390): `values` lists every
  // correct (expected, actual) pair, and the grader accepts any of them.
  const desk = { expected: tg.expected ?? tg.from, actual: tg.actual ?? tg.to };
  const mob = tg.mobileFrom ? { expected: tg.mobileFrom, actual: tg.mobileTo } : desk;
  const values = d.scope === '390' ? [mob] : [desk, ...(mob === desk ? [] : [mob])];
  return { ...e, property: tg.prop, expected: values[0].expected, actual: values[0].actual, values };
}

const decl = (props) => Object.entries(props).map(([k, v]) => `${k}: ${v};`).join(' ');
function stylesheet(m, { subpixel }) {
  const base = `* { box-sizing: border-box; }
html, body { margin: 0; background: #ffffff; color: #111827; font-family: ${FONT}; font-size: 15px; line-height: 1.5; }
a { color: inherit; text-decoration: none; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 8px; }
.nav { display: flex; gap: 16px; font-size: 14px; }
.nav a { color: #e5e7eb; }
main { padding: 24px; max-width: 1040px; margin: 0 auto; }
.toolbar { display: flex; gap: 12px; align-items: center; margin: 16px 0; flex-wrap: wrap; }
.search { display: flex; align-items: center; gap: 6px; flex: 1 1 220px; }
.search input { width: 100%; }
button { border: 0; font-family: inherit; font-size: 15px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
input, select { font-family: inherit; font-size: 15px; background: #ffffff; color: #111827; }
.field { display: flex; flex-direction: column; gap: 6px; }
.icon { width: 16px; height: 16px; flex: none; }
.cols { display: grid; grid-template-columns: 2fr 1fr; gap: 24px; }
.table-wrap { overflow-x: auto; }
th { text-align: left; font-size: 13px; color: #4b5563; padding: 8px 12px; }
td { padding: 12px; border-bottom: 1px solid #e5e7eb; }
[data-testid^="status-badge"] { background: #dcfce7; color: #166534; border-radius: 999px; padding: 2px 10px; font-size: 13px; font-weight: 600; }
[data-testid="items-list"] li { display: flex; justify-content: space-between; padding: 12px 16px; border: 1px solid #e5e7eb; border-radius: 8px; }
@media (max-width: 600px) { main { padding: 16px; } .cols { grid-template-columns: 1fr; } .hide-sm { display: none; } }
`;
  const rule = (id, props) => {
    const p = { ...props };
    if (m.truncate?.has(id)) Object.assign(p, { display: 'inline-block', overflow: 'hidden', 'white-space': 'nowrap', 'text-overflow': 'ellipsis', 'vertical-align': 'bottom' });
    if (subpixel && id === 'summary-card') p['margin-top'] = '24.4px';
    return `${T(id)} { ${decl(p)} }`;
  };
  const rules = Object.entries(m.css).map(([id, p]) => rule(id, p)).join('\n');
  const mobile = Object.entries(m.mobile).map(([id, p]) => `  ${T(id)} { ${decl(p)} }`).join('\n');
  return `${base}${rules}\n@media (max-width: 600px) {\n${mobile}\n}\n`;
}

const ICON = {
  brand: '<svg class="icon" data-testid="brand-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="3" fill="#60a5fa"/><path d="M4 11V5l4 4 4-4v6" stroke="#111827" stroke-width="1.6" fill="none"/></svg>',
  search: '<svg class="icon" data-testid="search-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="#4b5563" stroke-width="1.6" fill="none"/><path d="M10.5 10.5 14 14" stroke="#4b5563" stroke-width="1.6"/></svg>',
  back: '<svg class="icon" data-testid="back-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" stroke="#2952cc" stroke-width="1.8" fill="none"/></svg>',
};
const ORDERS = [
  ['1042', 'Ada Brennan', '$184.20', 'Paid'], ['1041', 'Tomás Ruiz', '$62.00', 'Paid'], ['1040', 'Mei Tanaka', '$1,240.00', 'Paid'],
  ['1039', 'Kofi Mensah', '$18.75', 'Paid'], ['1038', 'Lena Novak', '$309.99', 'Paid'],
];

function page(m, { title, body, live }) {
  const show = (id, html) => (m.hidden.has(id) ? '' : html);
  const navLinks = { 'nav-orders': 'Orders', 'nav-customers': 'Customers', 'nav-reports': 'Reports' };
  const clock = live
    ? '<span data-testid="last-updated">Updated <time id="clock">--:--</time></span><script>(() => { const t = () => { const d = new Date(); document.getElementById("clock").textContent = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }; t(); setInterval(t, 15000); })();</script>'
    : '<span data-testid="last-updated">Updated <time id="clock">09:41</time></span>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Northwind Ops</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="bar" data-testid="app-header">
<div class="brand">${show('brand-icon', ICON.brand)}<span data-testid="brand-name">${m.copy['brand-name']}</span></div>
<nav class="nav" data-testid="main-nav">${m.order.nav.map((id) => `<a href="/" data-testid="${id}">${navLinks[id]}</a>`).join('')}</nav>
${clock}
</header>
<main>
${body(show)}
</main>
</body>
</html>
`;
}

function screens(m, live) {
  const list = page(m, {
    title: 'Orders',
    live,
    body: (show) => `<div class="bar"><h1 data-testid="page-title-list">${m.copy['page-title-list']}</h1></div>
<div class="toolbar">
<label class="search" data-testid="search-box">${show('search-icon', ICON.search)}<input data-testid="search-input" type="search" placeholder="Search orders" aria-label="Search orders"></label>
<button data-testid="new-order-btn">${m.copy['new-order-btn']}</button>
</div>
<div class="table-wrap"><table data-testid="orders-table">
<thead><tr><th>Order</th><th>Customer</th><th class="hide-sm">Amount</th><th>Status</th></tr></thead>
<tbody>
${ORDERS.map(([id, who, amt, st], i) => `<tr data-testid="order-row-${id}"><td data-testid="${i === 0 ? 'order-cell' : `order-cell-${id}`}">#${id}</td><td>${who}</td><td class="hide-sm">${amt}</td><td><span data-testid="${i === 0 ? 'status-badge' : `status-badge-${id}`}">${st}</span></td></tr>`).join('\n')}
</tbody></table></div>
<section data-testid="summary-card"><b>5 orders</b> today · $1,814.94 in total</section>`,
  });
  const detail = page(m, {
    title: 'Order #1042',
    live,
    body: (show) => `<a href="/" data-testid="back-link" style="display:inline-flex;align-items:center;gap:4px;color:#2952cc">${show('back-icon', ICON.back)}All orders</a>
<div class="bar" style="margin-top:12px"><h1 data-testid="page-title-detail">${m.copy['page-title-detail']}</h1><span data-testid="detail-status">Paid</span></div>
<div class="cols">
<section>
<ul data-testid="items-list">
<li data-testid="item-row"><span>Ceramic mug, 2 ×</span><span>$36.00</span></li>
<li data-testid="item-row-2"><span>Linen apron</span><span>$48.20</span></li>
<li data-testid="item-row-3"><span>Chef knife</span><span>$100.00</span></li>
</ul>
<p><span data-testid="order-total-label">${m.copy['order-total-label']}</span>: <span data-testid="order-total">$184.20</span></p>
</section>
<aside>
<p data-testid="notes-text">${m.copy['notes-text']}</p>
<button data-testid="refund-btn">${m.copy['refund-btn']}</button>
</aside>
</div>`,
  });
  const fields = {
    'field-customer': `<div class="field" data-testid="field-customer"><label for="customer" data-testid="customer-label">${m.copy['customer-label']}</label><input id="customer" data-testid="customer-input" value="Ada Brennan"></div>`,
    'field-amount': `<div class="field" data-testid="field-amount"><label for="amount">Amount</label><input id="amount" data-testid="amount-input" value="184.20"><span data-testid="help-text">${m.copy['help-text']}</span></div>`,
    'field-priority': '<div class="field" data-testid="field-priority"><label for="priority">Priority</label><select id="priority" data-testid="priority-select" style="height:40px;border-radius:8px;border:1px solid #9ca3af;padding:0 8px"><option>Normal</option><option>Rush</option></select></div>',
  };
  const form = page(m, {
    title: 'New order',
    live,
    body: () => `<h1 data-testid="page-title-form">${m.copy['page-title-form']}</h1>
<form data-testid="form-fields" style="margin-top:16px" onsubmit="return false">
${m.order.form.map((id) => fields[id]).join('\n')}
<div><button data-testid="submit-btn" type="submit">${m.copy['submit-btn']}</button></div>
</form>`,
  });
  return { 'index.html': list, 'orders/1042.html': detail, 'new.html': form };
}

/** One full variant. Pure: the same seed gives the same bytes. */
export function generate(seed) {
  const golden = goldenModel();
  const defects = chooseDefects(seed);
  const app = applyDefects(golden, defects);
  const goldenFiles = { ...screens({ ...golden, truncate: new Set() }, false), 'style.css': stylesheet({ ...golden, truncate: new Set() }, { subpixel: false }) };
  const appFiles = { ...screens(app, true), 'style.css': stylesheet(app, { subpixel: true }) };
  const browserSeed = { hosts: { 'app.local': { files: appFiles }, 'design.local': { files: goldenFiles } }, viewport: { width: 1280, height: 800 } };
  const key = {
    seed,
    screens: SCREENS,
    viewports: VIEWPORTS.map((v) => v.name),
    defects: defects.map((d) => keyEntry(d, golden)),
    decoys: DECOYS.map((d) => ({ ...d, match_testids: [d.testid] })),
  };
  const assert = [];
  for (const [screen, path] of Object.entries(SCREENS)) {
    for (const v of VIEWPORTS) {
      assert.push({ path: `$.visits[?(@.view=='http://app.local${path}@${v.width}')]`, exists: true, note: `the ${screen} screen was open at ${v.width} px` });
    }
  }
  const findings = {
    findings: key.defects.map((d) => ({
      screen: d.screen,
      viewport: d.viewport,
      selector: T(d.testid),
      category: d.category,
      expected: d.expected,
      actual: d.actual,
      note: `${d.type}: ${d.property}`,
    })),
  };
  const calls = [];
  for (const v of VIEWPORTS) {
    calls.push({ server: 'browser', tool: 'browser_resize', arguments: { width: v.width, height: v.height } });
    for (const path of Object.values(SCREENS)) {
      calls.push({ server: 'browser', tool: 'browser_navigate', arguments: { url: `http://app.local${path}` } });
      // A snapshot, not a screenshot: the app's live clock changes the pixels every minute, so a
      // screenshot hash would make the gate's 3 replays differ (the export must be byte-stable).
      calls.push({ server: 'browser', tool: 'browser_snapshot', arguments: {} });
    }
  }
  return { browserSeed, key, assert, findings, calls };
}

/** A git-format patch that turns the skeleton out/findings.json into the reference findings. */
export function patchFor(text) {
  const oldLines = SKELETON.trimEnd().split('\n');
  const newLines = text.trimEnd().split('\n');
  return [
    'diff --git a/out/findings.json b/out/findings.json',
    '--- a/out/findings.json',
    '+++ b/out/findings.json',
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const seed = Number(args[args.indexOf('--seed') + 1] ?? 1);
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(import.meta.dirname, '..');
  if (!Number.isInteger(seed) || seed < 1) throw new Error('--seed must be a positive integer');
  const g = generate(seed);
  const write = (rel, text) => {
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    writeFileSync(join(out, rel), text);
  };
  const findingsText = `${JSON.stringify(g.findings, null, 2)}\n`;
  write('mcp/browser/seed.json', `${JSON.stringify(g.browserSeed, null, 1)}\n`);
  write('tests/hidden/key.json', `${JSON.stringify(g.key, null, 2)}\n`);
  write('tests/hidden/mcp/browser/assert.json', `${JSON.stringify(g.assert, null, 2)}\n`);
  write('solution/findings.json', findingsText);
  write('solution/solution.patch', patchFor(findingsText));
  write('solution/mcp-calls.jsonl', g.calls.map((c) => JSON.stringify(c)).join('\n') + '\n');
  console.log(`seed ${seed}: ${g.key.defects.map((d) => `${d.id} ${d.type}@${d.screen}${d.viewport === '390' ? ' (390)' : ''}`).join(', ')}`);
}

if (process.argv[1] === import.meta.filename) main();

#!/usr/bin/env node
// Writes the synthetic search-terms report and the reference solution of this task, byte for byte.
//
//   node benchmarks/loop-acquisition-search-terms/fixtures/build.mjs
//
// The data is invented: a fictional outdoor-gear shop, no real Ads account, no real search query.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

// term, campaign, impressions, clicks, cost (currency units), conversions
const ROWS = [
  ['trail running shoes', 'Shoes', 5400, 212, 164.5, 9],
  ['waterproof hiking boots', 'Boots', 4100, 160, 131.2, 6],
  ['buy hiking boots online', 'Boots', 1800, 74, 70.4, 4],
  ['hiking boots sale', 'Boots', 2600, 98, 79.1, 3],
  ['tent footprint', 'Camping', 900, 31, 26.8, 0.5],
  ['camping stove', 'Camping', 2300, 87, 61.3, 2],
  ['free hiking boots', 'Boots', 1500, 41, 38.7, 0],
  ['hiking boots repair near me', 'Boots', 980, 27, 24.1, 0],
  ['how to clean hiking boots', 'Boots', 1250, 33, 22.6, 0],
  ['hiking boot lace tutorial pdf', 'Boots', 610, 12, 9.4, 0],
  ['outdoor store jobs', 'Brand', 770, 19, 15.8, 0],
  ['used tents for sale', 'Camping', 1320, 28, 25.3, 0],
  ['sleeping bag diy', 'Camping', 480, 8, 6.9, 0],
  ['hiking boots wallpaper', 'Boots', 360, 0, 0, 0],
  ['boots clip art', 'Boots', 220, 0, 0, 0],
  ['trail running shoes size guide', 'Shoes', 1150, 36, 31.9, 1],
  ['trail running shoes for free', 'Shoes', 640, 15, 12.2, 0],
  ['stove fuel canister', 'Camping', 1020, 40, 28.4, 3],
];

const report = {
  account: 'Fixture Outdoor Gear (synthetic)',
  period: { from: '2026-10-05', to: '2026-10-11' },
  currency: 'USD',
  fields: {
    cost_micros: 'cost in millionths of a currency unit',
    conversions: 'conversions attributed to the term; can be fractional',
  },
  terms: ROWS.map(([term, campaign, impressions, clicks, cost, conversions]) => ({
    term,
    campaign,
    impressions,
    clicks,
    cost_micros: Math.round(cost * 1_000_000),
    conversions,
  })),
};

const proposals = {
  proposals: report.terms
    .filter((t) => t.conversions === 0 && t.cost_micros > 0)
    .map((t) => ({
      term: t.term,
      action: 'add_negative_keyword',
      reason: `${t.clicks} clicks and ${(t.cost_micros / 1_000_000).toFixed(2)} ${report.currency} spent with zero conversions.`,
    })),
};

export const REPORT_JSON = `${JSON.stringify(report, null, 2)}\n`;
export const PROPOSALS_JSON = `${JSON.stringify(proposals, null, 2)}\n`;

function patchFor(path, content) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-acq-patch-'));
  try {
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, path), content);
    const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, encoding: 'utf-8' });
    git('init', '-q');
    git('add', path);
    return git('diff', '--cached', '--no-color');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const SOLUTION_PATCH = () => patchFor('out/proposals.json', PROPOSALS_JSON);

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(join(root, 'environment/data'), { recursive: true });
  writeFileSync(join(root, 'environment/data/search-terms.json'), REPORT_JSON);
  writeFileSync(join(root, 'solution/proposals.json'), PROPOSALS_JSON);
  writeFileSync(join(root, 'solution/solution.patch'), SOLUTION_PATCH());
  console.log(`wrote ${report.terms.length} terms, ${proposals.proposals.length} proposals`);
}

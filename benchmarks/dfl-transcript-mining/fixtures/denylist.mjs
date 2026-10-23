#!/usr/bin/env node
// Denylist of the transcript-mining task folder. The real transcripts and labels are PRIVATE; only
// synthetic content (invented org "acme", hosts under example.test) may be in this folder.
//
//   node fixtures/denylist.mjs [dir]       exit 0 = clean, 1 = a hit (each hit printed as file:line: rule)
//
// A hit is:
//   - a real organisation or repo name: "devfellowship/", "iterahq/", "dfl-<name>" (except the task name
//     itself and "dfl-app", a closed enum value of rubric/schema.json);
//   - an internal host: devfellowship.com and any of its subdomains;
//   - a marker of the real corpus: "/root/.claude/projects/", "source_file /root", an internal volume path;
//   - a Telegram chat id: chat_id=" followed by digits;
//   - a <REDACTED:kind> marker followed, on the same line, by real-looking context: a secret-shaped token,
//     a host path, an IPv4 address, or a URL outside example.test;
//   - a secret-shaped string anywhere.
// This file is the only one that names the terms, so it is the only file the scan skips.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SELF = 'fixtures/denylist.mjs';
const SKIP = new Set([SELF, 'environment/package-lock.json']); // the lockfile: npm registry URLs and integrity hashes only

export const DENY = [
  ['real org or repo', /devfellowship\//i],
  ['real org or repo', /iterahq\//i],
  ['real repo name', /\bdfl-(?!app\b|transcript-mining\b)[a-z0-9]/i],
  ['internal host', /devfellowship\.com/i],
  ['corpus marker', /\/root\/\.claude\/projects\//],
  ['corpus marker', /source_file \/root/],
  ['internal path', /HC_Volume_|\/tma-private-tasks\/|\/codex-runs\//],
  ['telegram chat id', /chat_id="\d/],
  ['internal name', /openclaw|infisical|paperclip|claude-main|yoojxnggaxcqtsyjdrdx|kjefmwlopzeaqgqtlbdn/i],
];
export const SECRET = [
  /gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /sk-(?:or|ant|proj)-[A-Za-z0-9_-]{16,}/, /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[baprs]-[A-Za-z0-9-]{10,}/, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, /\bvcp_[A-Za-z0-9]{8,}/,
];

/** True when the text after a <REDACTED:kind> marker (same line) looks real. */
export function realLookingContext(after) {
  const tail = after.slice(0, 120);
  if (SECRET.some((re) => re.test(tail))) return true;
  if (/(?=[A-Za-z0-9_\-]*\d)(?=[A-Za-z0-9_\-]*[A-Za-z])[A-Za-z0-9_\-]{24,}/.test(tail)) return true; // a long mixed token
  if (/(?:^|[\s"'=])\/(?:root|home|mnt|opt|etc|srv|var)\//.test(tail)) return true;
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(tail)) return true;
  for (const m of tail.matchAll(/https?:\/\/([^/\s"'<>]+)/g)) if (!/(^|\.)example\.test$/i.test(m[1])) return true;
  return false;
}

/** Scan one text. Returns a list of { line, rule }. */
export function scanText(text) {
  const hits = [];
  text.split('\n').forEach((l, i) => {
    for (const [rule, re] of DENY) if (re.test(l)) hits.push({ line: i + 1, rule });
    for (const re of SECRET) if (re.test(l)) hits.push({ line: i + 1, rule: 'secret-shaped string' });
    for (const m of l.matchAll(/<REDACTED:[^>]*>/g)) if (realLookingContext(l.slice(m.index + m[0].length))) hits.push({ line: i + 1, rule: 'REDACTED marker with real-looking context' });
  });
  return hits;
}

/** Scan every file under `root` except this file and the lockfile. Returns { files, hits: [{ file, line, rule }] }. */
export function scanDir(root) {
  const files = [];
  const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).forEach((n) => n !== 'node_modules' && walk(join(p, n))) : files.push(p));
  walk(root);
  const hits = [];
  let scanned = 0;
  for (const f of files) {
    const rel = relative(root, f);
    if (SKIP.has(rel)) continue;
    scanned++;
    for (const h of scanText(readFileSync(f, 'utf-8'))) hits.push({ file: rel, ...h });
  }
  return { files: scanned, hits };
}

if (process.argv[1] === import.meta.filename) {
  const root = process.argv[2] ?? join(import.meta.dirname, '..');
  const { files, hits } = scanDir(root);
  for (const h of hits) console.error(`✗ ${h.file}:${h.line}: ${h.rule}`);
  console.log(`denylist: ${files} file(s) scanned, ${hits.length} hit(s)`);
  process.exit(hits.length ? 1 : 0);
}

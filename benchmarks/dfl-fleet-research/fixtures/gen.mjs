#!/usr/bin/env node
// Generator of the fleet-research task variant (ADR-2, ADR-7 of the plan): a synthetic fleet of
// real git repos in 2 orgs (the repos seed) plus the answer key, from ONE integer seed. The key
// is written at the same time as the fixture, so it is true by construction. No real content: every
// name, path and value is invented (see check.mjs, the denylist).
//
//   node fixtures/gen.mjs --seed 1            write the open variant into this task folder
//   node fixtures/gen.mjs --seed 7 --out DIR  write a (sealed) variant somewhere else
//
// Files it writes (relative to the task folder or --out):
//   mcp/repos/seed.json                 the repos seed (orgs → repos → commits → files)
//   tests/hidden/key.json               answers, evidence files, and the text of every file at HEAD
//   tests/hidden/mcp/repos/assert.json  mcp_state assertions: the key files were read through MCP
//   solution/answers.json               the reference answer (from the key)
//   solution/report.md                  the reference report
//   solution/mcp-calls.jsonl            the reads that justify each citation
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// ---------- seeded randomness (mulberry32) ----------
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

export function generate(seed) {
  const rand = rng(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const shuffle = (list) => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const people = [
    { name: 'Ana Lima', email: 'ana@acme.test' },
    { name: 'Bruno Reis', email: 'bruno@acme.test' },
    { name: 'Carla Nunes', email: 'carla@acme.test' },
    { name: 'Diego Prado', email: 'diego@acme.test' },
  ];
  let day = 0;
  const date = () => {
    day += 1;
    const d = new Date(Date.UTC(2026, 5, 1, 9, 0, 0) + day * 86_400_000 + int(0, 7) * 3_600_000);
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  };
  const filler = (n, topic) =>
    Array.from({ length: n }, (_, i) => pick([
      `- Keep ${topic} changes small and reviewed.`,
      `- The owners of ${topic} answer in the team channel.`,
      `- See the changelog for older ${topic} notes.`,
      `- Run the checks locally before you open a pull request.`,
      `- Version ${i + 1} of this section was reviewed in the last cycle.`,
    ]));
  const md = (lines) => `${lines.join('\n')}\n`;

  // ---------- the fleet topology ----------
  const ORG_A = 'acme';
  const ORG_B = 'acmehq';
  const visibility = {
    [`${ORG_A}/acme-schema`]: 'private',
    [`${ORG_A}/acme-ci`]: 'private',
    [`${ORG_A}/acme-iterate`]: 'private',
    [`${ORG_A}/acme-harness`]: 'private',
    [`${ORG_A}/acme-infra`]: 'private',
    [`${ORG_A}/acme-services`]: 'private',
    [`${ORG_A}/acme-website`]: 'public',
    [`${ORG_A}/acme-plans`]: 'private',
    [`${ORG_B}/acme-player`]: 'private',
    [`${ORG_B}/acme-landing`]: 'public',
    [`${ORG_B}/acme-api`]: 'private',
    [`${ORG_B}/acme-mcp`]: 'private',
    [`${ORG_B}/acme-cert`]: 'private',
    [`${ORG_B}/acme-mobile`]: 'private',
  };
  const repos = Object.fromEntries(Object.keys(visibility).map((id) => [id, { files: {}, commits: [] }]));
  // Files are added in "commits": each call is one commit of the listed files.
  const commit = (id, message, files) => repos[id].commits.push({ message, author: pick(people), date: date(), files });
  const ghWorkflow = (name, on, runsOn, steps) =>
    md([`name: ${name}`, `on:`, ...on.map((l) => `  ${l}`), `jobs:`, `  ${name}:`, `    runs-on: ${runsOn}`, `    steps:`, `      - uses: actions/checkout@v4`, ...steps.map((s) => `      - run: ${s}`)]);
  const SELF = '[self-hosted, acme-runner]';

  // A README for every repo (the first commit).
  const purpose = {
    [`${ORG_A}/acme-schema`]: 'Database schema of the Acme platform: migrations and policies.',
    [`${ORG_A}/acme-ci`]: 'Reusable CI workflows that the other repos call.',
    [`${ORG_A}/acme-iterate`]: 'The iterate service: the API that turns lesson progress into the next step. The player calls it; it is NOT the player app.',
    [`${ORG_A}/acme-harness`]: 'Agent skills and hooks of the Acme engineering agents.',
    [`${ORG_A}/acme-infra`]: 'Infrastructure as code, deploy files and the repository inventory.',
    [`${ORG_A}/acme-services`]: 'Back-end services (payments, notifications, search).',
    [`${ORG_A}/acme-website`]: 'The public marketing website.',
    [`${ORG_A}/acme-plans`]: 'Planning documents of the engineering team.',
    [`${ORG_B}/acme-player`]: 'The Acme player: the learner-facing app where learners take lessons.',
    [`${ORG_B}/acme-landing`]: 'The landing page of the learner product.',
    [`${ORG_B}/acme-api`]: 'Public API of the learner product.',
    [`${ORG_B}/acme-mcp`]: 'MCP servers for the learner product.',
    [`${ORG_B}/acme-cert`]: 'Certificates for learners who finish a course.',
    [`${ORG_B}/acme-mobile`]: 'The mobile shell of the learner product.',
  };
  for (const id of Object.keys(repos)) {
    const name = id.split('/')[1];
    commit(id, `${name}: initial commit`, { 'README.md': md([`# ${name}`, '', purpose[id], '', '## Notes', '', ...filler(int(2, 5), name)]) });
  }

  // ---- Fact 1: topology trap. "The Acme player" = acmehq/acme-player, not acme/acme-iterate. ----
  commit(`${ORG_A}/acme-iterate`, 'iterate: add the player client contract', {
    'docs/player-contract.md': md(['# Contract with the player', '', ...filler(int(1, 3), 'contract'), 'The player sends a progress event to POST /iterate/next.', 'This repository does not contain the player app.']),
    'src/server.ts': md(["import { next } from './next';", '', 'export const routes = { "/iterate/next": next };']),
  });
  commit(`${ORG_B}/acme-player`, 'player: lesson screen', {
    'package.json': md(['{', '  "name": "acme-player",', '  "private": true,', '  "description": "The Acme player app"', '}']),
    'src/App.tsx': md(['export function App() {', '  return <Lesson />;', '}']),
  });

  // ---- Fact 2: the workflow that applies migrations to production on merge. ----
  const applyName = pick(['push-migrations.yml', 'apply-migrations.yml', 'db-deploy.yml']);
  const checkName = pick(['validate-migrations.yml', 'check-migrations.yml']);
  const applySteps = [...Array.from({ length: int(0, 2) }, (_, i) => `echo "prepare step ${i + 1}"`), 'npx dbtool push --target production'];
  commit(`${ORG_A}/acme-schema`, 'schema: add the first migrations', {
    'migrations/0001_init.sql': md(['create table lessons (id uuid primary key, title text not null);']),
    'migrations/0002_progress.sql': md(['create table progress (lesson_id uuid references lessons(id), step int not null);']),
  });
  commit(`${ORG_A}/acme-schema`, 'ci: validate migrations on pull requests', {
    [`.github/workflows/${checkName}`]: ghWorkflow('validate', ['pull_request:', '  branches: [main]'], SELF, ['npx dbtool lint migrations', 'npx dbtool push --dry-run']),
  });
  commit(`${ORG_A}/acme-schema`, 'ci: apply migrations to production after merge', {
    [`.github/workflows/${applyName}`]: ghWorkflow('apply', ['push:', '  branches: [main]', '  paths: [migrations/**]'], SELF, applySteps),
  });
  // A distractor in another repo: a workflow that mentions migrations but never applies them.
  commit(`${ORG_A}/acme-ci`, 'ci: shared test workflow', {
    '.github/workflows/test.yml': ghWorkflow('test', ['workflow_call:'], SELF, ['npm ci', 'npm test', 'echo "migrations are applied by the schema repo"']),
  });

  // ---- Fact 3: skills in acme/acme-harness, 20 skills, some pairs duplicate each other. ----
  const truePairs = [
    ['deploy-app', 'ship-app', 'Deploy one application to production and verify the health check.'],
    ['summarize-pr', 'pr-digest', 'Write a short summary of one pull request for the team channel.'],
    ['rotate-token', 'token-refresh', 'Replace an expiring access token in the vault and in every consumer.'],
    ['read-plan', 'plan-fetch', 'Fetch the full text of one planning document by its slug.'],
    ['triage-alert', 'alert-sort', 'Sort a new monitoring alert by severity and assign an owner.'],
  ];
  const decoyPairs = [
    ['deploy-docs', 'Publish the documentation site after a docs change.', 'deploy-db', 'Apply database migrations in the staging database only.'],
    ['summarize-log', 'Summarize the error lines of one service log.', 'summarize-call', 'Write the notes of a recorded customer call.'],
    ['plan-create', 'Create a new planning document from a template.', 'plan-close', 'Close a finished planning document and archive it.'],
    ['token-audit', 'List tokens that expire in the next 30 days.', 'token-count', 'Count the model tokens of one prompt.'],
  ];
  const singles = [
    ['vps-health', 'Report disk, memory and load of one server.'],
    ['image-fetch', 'Download an image from a public URL to the scratch folder.'],
    ['seo-keywords', 'Research long-tail keywords for one topic.'],
    ['invoice-make', 'Make an invoice PDF from a JSON order.'],
    ['speak-text', 'Turn a short text into an audio file.'],
    ['backup-check', 'Verify that last night backup finished.'],
    ['cert-renew', 'Renew a TLS certificate before it expires.'],
    ['queue-drain', 'Drain a stuck job queue safely.'],
    ['lint-yaml', 'Lint every YAML file in a repository.'],
    ['cost-report', 'Report the model cost of the last 7 days.'],
  ];
  const dups = shuffle(truePairs).slice(0, 3); // 3 MERGE pairs (~60%)
  const decoys = shuffle(decoyPairs).slice(0, 2); // 2 look-alike pairs that are NOT duplicates (~40%)
  const skills = [];
  for (const [a, b, p] of dups) skills.push([a, p], [b, p]); // a duplicate = the SAME purpose line
  for (const [a, pa, b, pb] of decoys) skills.push([a, pa], [b, pb]);
  for (const s of shuffle(singles)) if (skills.length < 20) skills.push(s);
  const skillFile = (name, p) => md(['---', `name: ${name}`, `purpose: ${p}`, '---', '', `# ${name}`, '', ...filler(int(1, 3), name)]);
  const skillFiles = {};
  for (const [n, p] of skills.sort((x, y) => (x[0] < y[0] ? -1 : 1))) skillFiles[`skills/${n}/SKILL.md`] = skillFile(n, p);
  commit(`${ORG_A}/acme-harness`, 'harness: import the skills', skillFiles);
  commit(`${ORG_A}/acme-harness`, 'docs: how to find duplicate skills', {
    'docs/skills.md': md(['# Skills', '', 'Two skills are duplicates when their `purpose:` lines describe the same job.', 'A similar NAME is not enough.']),
  });

  // ---- Fact 4: a rule file, and one private-repo workflow that breaks it. ----
  const violatorRepo = pick([`${ORG_B}/acme-api`, `${ORG_B}/acme-mcp`, `${ORG_B}/acme-cert`]);
  const violatorFile = `.github/workflows/${pick(['lint.yml', 'build.yml', 'typecheck.yml'])}`;
  commit(`${ORG_A}/acme-infra`, 'docs: CI runner rules', {
    'docs/ci-rules.md': md(['# CI rules', '', ...filler(int(1, 3), 'CI'), 'Rule R1: every job of a PRIVATE repository runs on the self-hosted runner `[self-hosted, acme-runner]`.', 'Rule R2: a PUBLIC repository may use `ubuntu-latest`, because the self-hosted runner refuses public repositories.']),
    'inventory/repos.yaml': md(['# Every repository of both orgs and its visibility.', 'repos:', ...Object.entries(visibility).map(([id, v]) => `  - { id: ${id}, visibility: ${v} }`)]),
  });
  for (const id of Object.keys(repos)) {
    if (id === violatorRepo) continue;
    if (!/acme-(api|mcp|cert|landing|website|services)$/.test(id)) continue;
    const runsOn = visibility[id] === 'public' ? 'ubuntu-latest' : SELF;
    commit(id, 'ci: add the build workflow', { '.github/workflows/build.yml': ghWorkflow('build', ['pull_request:'], runsOn, ['npm ci', 'npm run build']) });
  }
  commit(violatorRepo, 'ci: quick check workflow', {
    [violatorFile]: ghWorkflow('check', ['pull_request:'], 'ubuntu-latest', ['npm ci', 'npm run lint']),
  });

  // ---- Fact 5: a credential path referenced in exactly two places (path only, fake). ----
  const secretPath = 'vault:/payments/PAYMENTS_API_KEY';
  const places = [
    [`${ORG_A}/acme-services`, 'payments/config.example.env', (s) => md(['# Copy to .env. The value comes from the vault, never from this file.', `PAYMENTS_API_KEY_REF=${s}`, 'PAYMENTS_API_KEY=<fill-from-vault>'])],
    [`${ORG_A}/acme-infra`, 'deploy/payments.yaml', (s) => md(['service: payments', 'env:', `  - name: PAYMENTS_API_KEY`, `    from: ${s}`, '  - name: PAYMENTS_REGION', '    value: eu-1'])],
    [`${ORG_B}/acme-api`, 'src/payments/config.ts', (s) => md(['// The key is read at boot from the vault path below.', `export const PAYMENTS_KEY_PATH = '${s}';`])],
  ];
  const chosen = shuffle(places);
  const secretRefs = [];
  chosen.forEach(([id, path, body], i) => {
    // Two places use the API key path; the third uses the WEBHOOK secret (a distractor).
    const s = i < 2 ? secretPath : 'vault:/payments/PAYMENTS_WEBHOOK_SECRET';
    commit(id, 'payments: reference the vault path', { [path]: body(s) });
    if (i < 2) secretRefs.push({ id, path, line: body(s).split('\n').findIndex((l) => l.includes(secretPath)) + 1 });
  });

  // ---- Fact 6: unanswerable. Nothing in the fleet is a Helm chart or a Kubernetes manifest. ----
  commit(`${ORG_A}/acme-infra`, 'deploy: compose file for staging', {
    'deploy/compose.staging.yaml': md(['services:', '  api:', '    image: registry.acme.test/api:staging', '    ports: ["8080:8080"]']),
  });
  commit(`${ORG_A}/acme-plans`, 'plans: quarter plan', {
    'plans/2026-q3.md': md(['# Q3 plan', '', ...filler(int(2, 4), 'planning'), 'Open item: decide later how services are deployed in Q4.']),
  });

  // ---------- seed + snapshot ----------
  const seedOut = { orgs: [] };
  for (const org of [ORG_A, ORG_B]) {
    seedOut.orgs.push({
      name: org,
      repos: Object.keys(repos).filter((id) => id.startsWith(`${org}/`)).map((id) => ({ name: id.split('/')[1], default_branch: 'main', commits: repos[id].commits })),
    });
  }
  const snapshot = {};
  for (const [id, r] of Object.entries(repos)) {
    for (const c of r.commits) for (const [p, t] of Object.entries(c.files)) {
      if (t === null) delete snapshot[`${id}:${p}`];
      else snapshot[`${id}:${p}`] = t;
    }
  }

  const player = `${ORG_B}/acme-player`;
  const applyRef = `${ORG_A}/acme-schema/.github/workflows/${applyName}`;
  const key = {
    seed,
    questions: {
      q1: { kind: 'exact', answer: player, evidence_files: [`${player}:README.md`, `${player}:package.json`] },
      q2: { kind: 'exact', answer: applyRef, evidence_files: [`${ORG_A}/acme-schema:.github/workflows/${applyName}`] },
      q3: { kind: 'pairs', answer: dups.map(([a, b]) => [a, b].sort()), evidence_files: dups.flatMap(([a, b]) => [`${ORG_A}/acme-harness:skills/${a}/SKILL.md`, `${ORG_A}/acme-harness:skills/${b}/SKILL.md`]) },
      q4: { kind: 'exact', answer: `${violatorRepo}/${violatorFile}`, evidence_files: [`${violatorRepo}:${violatorFile}`, `${ORG_A}/acme-infra:inventory/repos.yaml`] },
      q5: { kind: 'set', answer: secretRefs.map((r) => `${r.id}/${r.path}`).sort(), evidence_files: secretRefs.map((r) => `${r.id}:${r.path}`) },
      q6: { kind: 'unanswerable', answer: null, evidence_files: [] },
    },
    snapshot,
  };

  // ---------- reference solution ----------
  const ev = (id, path, quote) => {
    const lines = snapshot[`${id}:${path}`].split('\n');
    const line = lines.findIndex((l) => l.includes(quote)) + 1;
    if (line === 0) throw new Error(`generator bug: "${quote}" not in ${id}:${path}`);
    return { ref: `${id}:${path}:${line}`, quote };
  };
  const answers = {
    answers: {
      q1: { answer: player, evidence: [ev(player, 'README.md', 'the learner-facing app')] },
      q2: { answer: applyRef, evidence: [ev(`${ORG_A}/acme-schema`, `.github/workflows/${applyName}`, 'npx dbtool push --target production'), ev(`${ORG_A}/acme-schema`, `.github/workflows/${applyName}`, 'branches: [main]')] },
      q3: { answer: key.questions.q3.answer, evidence: dups.flatMap(([a, b, p]) => [ev(`${ORG_A}/acme-harness`, `skills/${a}/SKILL.md`, `purpose: ${p}`), ev(`${ORG_A}/acme-harness`, `skills/${b}/SKILL.md`, `purpose: ${p}`)]) },
      q4: { answer: key.questions.q4.answer, evidence: [ev(violatorRepo, violatorFile, 'runs-on: ubuntu-latest'), ev(`${ORG_A}/acme-infra`, 'inventory/repos.yaml', `id: ${violatorRepo}, visibility: private`)] },
      q5: { answer: key.questions.q5.answer, evidence: secretRefs.map((r) => ev(r.id, r.path, secretPath)) },
    },
    not_verified: ['q6'],
  };
  const report = md([
    '# Fleet research report',
    '',
    '## Measured',
    '',
    `- q1: the player app is ${player} (its README says it is the learner-facing app). acme/acme-iterate is the iterate API that the player calls.`,
    `- q2: ${applyRef} runs on a push to main and runs \`dbtool push --target production\`. The ${checkName} workflow only validates.`,
    `- q3: ${dups.length} duplicate pairs, by identical purpose lines.`,
    `- q4: ${key.questions.q4.answer} uses ubuntu-latest in a private repository (rule R1).`,
    `- q5: the path ${secretPath} appears in ${secretRefs.length} files.`,
    '',
    '## Inferred',
    '',
    '- Nothing. Every answer above cites a file that I read.',
    '',
    '## Not verified',
    '',
    '- q6: no file in the fleet defines a Helm chart or a Kubernetes manifest. I did not find the fact, so I do not answer it.',
  ]);
  // Task version 3 (TMA-QA2 = A): the only tool that returns file content is read_file_lines. The reference
  // solution lists and searches, then reads every file it needs (discovery reads and cited files) with
  // read_file_lines, one call per file, so each cited line number is the one the tool printed.
  const cited = [...new Set(Object.values(answers.answers).flatMap((a) => a.evidence.map((e) => e.ref.slice(0, e.ref.lastIndexOf(':')))))];
  const discovery = [
    `${player}:README.md`, `${ORG_A}/acme-iterate:README.md`,
    `${ORG_A}/acme-schema:.github/workflows/${applyName}`,
    ...Object.keys(skillFiles).map((p) => `${ORG_A}/acme-harness:${p}`),
    `${ORG_A}/acme-infra:docs/ci-rules.md`, `${ORG_A}/acme-infra:inventory/repos.yaml`, `${violatorRepo}:${violatorFile}`,
    ...secretRefs.map((r) => `${r.id}:${r.path}`),
  ];
  const read = (paths) => paths.map((p) => `/repos/${p.replace(':', '/')}`);
  const calls = [
    { tool: 'directory_tree', arguments: { path: '/repos', excludePatterns: ['**/.git'] } },
    { tool: 'search_files', arguments: { path: '/repos', pattern: '**/*payments*' } },
    { tool: 'search_files', arguments: { path: '/repos', pattern: '**/*{helm,chart,k8s,kube}*' } },
    ...[...new Set([...discovery, ...cited])].map((p) => ({ tool: 'read_file_lines', arguments: { path: read([p])[0] } })),
  ].map((c) => ({ server: 'repos', ...c }));
  const assertions = [
    ...[`${player}:README.md`, `${ORG_A}/acme-schema:.github/workflows/${applyName}`, `${violatorRepo}:${violatorFile}`, `${ORG_A}/acme-infra:inventory/repos.yaml`, ...secretRefs.map((r) => `${r.id}:${r.path}`), ...key.questions.q3.evidence_files].map((id) => ({
      path: `$.files_read[?(@.id=='${id}')]`,
      exists: true,
      note: 'a file that holds a planted fact was read through the repos server',
    })),
    { path: '$.calls_outside', equals: 0, note: 'no successful call outside the fleet' },
  ];
  return { seed: seedOut, key, answers, report, calls, assertions };
}

/** The empty answers file of environment/out/ (the baseline the agent starts from). */
export const SKELETON = '{ "answers": {}, "not_verified": [] }\n';

/** A unified diff (git apply) from the skeleton to the reference answers + a new report. */
export function solutionPatch(answersText, reportText) {
  const plus = (t) => t.replace(/\n$/, '').split('\n').map((l) => `+${l}`).join('\n');
  const n = (t) => t.replace(/\n$/, '').split('\n').length;
  return [
    'diff --git a/out/answers.json b/out/answers.json',
    '--- a/out/answers.json',
    '+++ b/out/answers.json',
    `@@ -1 +1,${n(answersText)} @@`,
    `-${SKELETON.replace(/\n$/, '')}`,
    plus(answersText),
    'diff --git a/out/report.md b/out/report.md',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/out/report.md',
    `@@ -0,0 +1,${n(reportText)} @@`,
    plus(reportText),
    '',
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const get = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const seed = Number(get('--seed') ?? 1);
  if (!Number.isInteger(seed) || seed < 1) throw new Error('--seed must be a positive integer');
  const out = resolve(get('--out') ?? join(import.meta.dirname, '..'));
  const g = generate(seed);
  const write = (rel, text) => {
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    writeFileSync(join(out, rel), text);
  };
  const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
  write('mcp/repos/seed.json', json(g.seed));
  write('tests/hidden/key.json', json(g.key));
  write('tests/hidden/mcp/repos/assert.json', json(g.assertions));
  write('solution/answers.json', json(g.answers));
  write('solution/report.md', g.report);
  write('solution/mcp-calls.jsonl', g.calls.map((c) => JSON.stringify(c)).join('\n') + '\n');
  write('solution/solution.patch', solutionPatch(json(g.answers), g.report));
  console.log(`seed ${seed}: ${g.seed.orgs.reduce((n, o) => n + o.repos.length, 0)} repos, ${Object.keys(g.key.snapshot).length} files → ${out}`);
}

if (process.argv[1] === import.meta.filename) main();

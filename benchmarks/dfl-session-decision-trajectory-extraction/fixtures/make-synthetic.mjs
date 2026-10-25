#!/usr/bin/env node
// Rebuild the SYNTHETIC inputs of this task folder (invented org "acme", hosts under example.test). No real session.
//
//   node fixtures/make-synthetic.mjs --tools <layer-2 contract tools dir>
//
// It writes an invented Claude Code transcript (raw JSONL, in a temp dir only) and an invented layer-1 run record,
// then runs the contract's own builders (shape-list.mjs, condensed-view.mjs) on them, so item.txt and shapes.json
// have the exact production format. Outputs:
//   environment/{item.txt,layer1.json,shapes.json}, tests/hidden/reference.json, solution/{judgment.json,solution.patch}
//       the open variant: a MAIN session (Telegram turns, one correction, a merge with a risk floor, a spawn)
//   fixtures/synthetic/synth-acme-0001__agent-b7c1/{item.txt,layer1.json,shapes.json,reference.json}
//       a SUBAGENT run whose BRIEF relays the human's message (no corrections allowed)
// CI does not run this script (it needs the contract tools); fixtures/check.mjs checks its committed outputs.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const TOOLS = argv[argv.indexOf('--tools') + 1];
if (!argv.includes('--tools') || !TOOLS) { console.error('usage: make-synthetic.mjs --tools <layer-2 contract tools dir>'); process.exit(2); }
const ROOT = join(import.meta.dirname, '..');
const MAIN = 'synth-acme-0001', SUB = 'synth-acme-0001__agent-b7c1', SUB_AGENT = 'b7c1';
const T0 = Date.parse('2026-01-05T10:00:00Z');
const ts = (min) => new Date(T0 + min * 60000).toISOString();

/** Build one run: events = [{h|brief|a: text} | {tool, input, result, error?, shape, intent?, target?, child?}] */
function build(events, { kind }) {
  const rows = [], spans = [];
  let t = 0, seq = 0, tu = 0, turn = -1;
  for (const e of events) {
    t += 0.5;
    if (e.h !== undefined) {
      turn++;
      rows.push({ type: 'user', timestamp: ts(t), origin: { kind: 'channel', server: 'plugin:telegram:telegram' },
        message: { role: 'user', content: `<channel source="plugin:telegram:telegram" message_id="${e.mid}" user="owner" ts="${ts(t)}">\n${e.h}\n</channel>` } });
    } else if (e.brief !== undefined) {
      turn++;
      rows.push({ type: 'user', timestamp: ts(t), message: { role: 'user', content: e.brief } });
    } else if (e.a !== undefined) {
      rows.push({ type: 'assistant', timestamp: ts(t), message: { role: 'assistant', content: [{ type: 'text', text: e.a }] } });
    } else {
      const id = `toolu_${String(++tu).padStart(4, '0')}`;
      rows.push({ type: 'assistant', timestamp: ts(t), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: e.tool, input: e.input }] } });
      rows.push({ type: 'user', timestamp: ts(t + 0.1), toolUseResult: { stdout: e.result }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: e.result, is_error: !!e.error }] } });
      spans.push({ seq: seq++, turn_seq: Math.max(turn, 0), ts: ts(t), ts_end: ts(t + 0.1), dur_ms: 6000, tool: e.tool, shape: e.shape,
        intent: e.intent ?? null, intent_source: e.intent ? 'parser' : 'needs-model', family: e.family ?? 'builtin', target: e.target ?? null,
        target_kind: e.targetKind ?? null, ok: !e.error, retry_of: null, child_run: e.child ?? null, preview: String(e.preview ?? '').slice(0, 200), bytes_out: e.result.length });
    }
  }
  return { rows, spans, first: ts(0.5), last: ts(t + 0.1), kind };
}
const countBy = (a, f) => { const o = {}; for (const x of a) { const k = f(x); o[k] = (o[k] || 0) + 1; } return o; };
function layer1(run, extra) {
  const s = run.spans;
  return {
    kind: 'run', synthetic: true, adapter: 'jsonl', extractor_version: 'synthetic', intent_list_version: 1,
    started_at: run.first, ended_at: run.last, n_tool_calls: s.length,
    tool_counts: countBy(s, (x) => x.tool), intent_counts: countBy(s, (x) => x.intent || 'needs-model'), shape_counts: countBy(s, (x) => x.shape),
    errors: { n: s.filter((x) => !x.ok).length, by_tool: countBy(s.filter((x) => !x.ok), (x) => x.tool) },
    ...extra, spans: s,
  };
}

// ------------------------------------------------------------------ the open variant (main session)
const PR42 = 'https://git.example.test/acme/acme-widget/pull/42', PR43 = 'https://git.example.test/acme/acme-widget/pull/43';
const main = build([
  { h: 'the acme-widget CI is red on main again. fix it and merge when it is green', mid: 9001 },
  { a: 'I will read the log of the last failed run.' },
  { tool: 'Bash', input: { command: 'ci-cli logs acme/acme-widget --last-failed | tail -n 40' }, result: 'error: no space left on device (runner hosted-small-3)', shape: 'ci-cli logs + tail', family: 'ci', preview: 'ci-cli logs acme/acme-widget --last-failed | tail -n 40' },
  { a: 'The job ran out of disk on the hosted runner. I will move the job to a hosted-large runner.' },
  { h: 'não, nada de hosted. usa o runner fleet-x, sempre', mid: 9002 },
  { a: 'Understood. From now on every acme-widget job runs on the fleet-x runner.' },
  { tool: 'Read', input: { file_path: '.ci/pipeline.yml' }, result: 'runs-on: hosted-small', shape: 'Read', intent: 'file-read', target: '.ci/pipeline.yml', targetKind: 'file', preview: '.ci/pipeline.yml' },
  { tool: 'Edit', input: { file_path: '.ci/pipeline.yml', old_string: 'runs-on: hosted-small', new_string: 'runs-on: fleet-x' }, result: 'ok', shape: 'Edit', intent: 'file-edit', target: '.ci/pipeline.yml', targetKind: 'file', preview: '.ci/pipeline.yml' },
  { tool: 'Bash', input: { command: 'git commit -am "ci: run on fleet-x" && git push origin fix/runner' }, result: 'pushed fix/runner', shape: 'git commit + git push', intent: 'git-write', family: 'git', preview: 'git commit -am "ci: run on fleet-x" && git push origin fix/runner' },
  { tool: 'Bash', input: { command: 'git-cli pr create --repo acme/acme-widget --title "ci: run on fleet-x"' }, result: PR42, shape: 'git-cli pr create', family: 'git', preview: 'git-cli pr create --repo acme/acme-widget --title "ci: run on fleet-x"' },
  { tool: 'Bash', input: { command: 'acme-checks wait acme/acme-widget 42' }, result: 'all 6 checks green on 9f8e7d6', shape: 'acme-checks wait', family: 'ci', preview: 'acme-checks wait acme/acme-widget 42' },
  { a: 'All six checks are green on the head commit. I will merge PR 42 with safe-merge.' },
  { tool: 'Bash', input: { command: 'bash /opt/skills/safe-merge/run.sh 42 acme/acme-widget' }, result: 'MERGED:1a2b3c4d5e6f', shape: 'bash <skill:safe-merge>/run.sh', intent: 'pr-write/merge', family: 'skill-bash', target: 'safe-merge', targetKind: 'skill', preview: 'bash <skill:safe-merge>/run.sh 42 acme/acme-widget' },
  { tool: 'mcp__plugin_telegram_telegram__reply', input: { chat_id: 'owner', text: 'PR 42 is merged. CI now runs on the fleet-x runner.' }, result: 'sent', shape: 'mcp__plugin_telegram_telegram__reply', intent: 'reply-human', family: 'mcp', preview: 'PR 42 is merged. CI now runs on the fleet-x runner.' },
  { h: 'boa. e documenta o runner no README também, decidido', mid: 9003 },
  { a: 'I will spawn a subagent for the README change and check the disk of the fleet-x host.' },
  { tool: 'Agent', input: { subagent_type: 'general-purpose', description: 'Document the fleet-x runner in the README', prompt: 'see the brief', run_in_background: true }, result: 'agent b7c1 started', shape: 'Agent general-purpose', intent: 'spawn-subagent', target: SUB_AGENT, targetKind: 'agent', child: SUB_AGENT, preview: 'Document the fleet-x runner in the README' },
  { tool: 'Bash', input: { command: 'ssh build-host-1 df -h /' }, result: '/dev/sda1 80% used', shape: 'ssh + df', family: 'ssh', preview: 'ssh build-host-1 df -h /' },
  { a: 'PR 42 is merged. The README change runs in a subagent (PR 43). The fleet-x host has 20% disk free.' },
], { kind: 'main' });
const sub = build([
  { brief: 'Add one line about the fleet-x runner to README.md of acme/acme-widget, under the CI heading. Tainan decided it in TG msg 9003. Open one PR. Do not merge it: the parent merges.' },
  { a: 'I will read README.md and add the line under the CI heading.' },
  { tool: 'Read', input: { file_path: 'README.md' }, result: '## CI\nJobs run on every push.', shape: 'Read', intent: 'file-read', target: 'README.md', targetKind: 'file', preview: 'README.md' },
  { tool: 'Edit', input: { file_path: 'README.md', old_string: 'Jobs run on every push.', new_string: 'Jobs run on every push, on the self-hosted fleet-x runner.' }, result: 'ok', shape: 'Edit', intent: 'file-edit', target: 'README.md', targetKind: 'file', preview: 'README.md' },
  { tool: 'Bash', input: { command: 'git commit -am "docs: fleet-x runner" && git push origin docs/runner' }, result: 'pushed docs/runner', shape: 'git commit + git push', intent: 'git-write', family: 'git', preview: 'git commit -am "docs: fleet-x runner" && git push origin docs/runner' },
  { tool: 'Bash', input: { command: 'git-cli pr create --repo acme/acme-widget --title "docs: fleet-x runner"' }, result: PR43, shape: 'git-cli pr create', family: 'git', preview: 'git-cli pr create --repo acme/acme-widget --title "docs: fleet-x runner"' },
  { a: `PR 43 is open: ${PR43}. I leave the merge to the parent.` },
], { kind: 'subagent' });

const subSignals = { pr_created: 1 };
const mainOwn = { merge_call: 1, merge_token: 1, pr_created: 1, tg_reply_sent: 1 };
const mainTree = { merge_call: 1, merge_token: 1, pr_created: 2, tg_reply_sent: 1 };
const L1main = layer1(main, {
  session_id: MAIN, agent_id: null, is_subagent: false, channel: 'telegram', n_human_turns: 3, n_tg_turns: 3,
  repos_touched: [{ repo: 'acme/acme-widget', calls: 5, resolved_via: ['flag'], write: true }],
  links: [{ kind: 'pr', key: 'acme/acme-widget#42', url: PR42, repo: 'acme/acme-widget', action_run: ['write'], action_tree: ['write'] },
    { kind: 'pr', key: 'acme/acme-widget#43', url: PR43, repo: 'acme/acme-widget', action_run: ['mention (text only)'], action_tree: ['write'] }],
  outcome_signals: mainOwn,
  risk_signals: [{ signal: 'merge of a PR (may deploy on merge)', floor: 5, span_seq: 6 }],
  milestones: [{ seq: 4, signals: ['pr_created'] }, { seq: 6, signals: ['merge_call', 'merge_token'] }, { seq: 8, signals: ['spawn-subagent'] }],
  det_tags: ['telegram', 'ci', 'fanout'],
  subtree: { n_runs: 2, agent_ids: [SUB_AGENT], children: [SUB_AGENT], children_spawned: 1, children_joined: 1, outcome_signals: mainTree, n_tool_calls: main.spans.length + sub.spans.length },
  unit: { item_id: MAIN, kind: 'main', parent_session_id: null, window: null, outcome_signals: mainTree, outcome_scope: 'the run and every descendant run (subtree)' },
});
const L1sub = layer1(sub, {
  session_id: MAIN, agent_id: SUB_AGENT, parent_session_id: MAIN, is_subagent: true, agent_type: 'general-purpose', channel: 'subagent-brief',
  repos_touched: [{ repo: 'acme/acme-widget', calls: 2, resolved_via: ['flag'], write: true }],
  links: [{ kind: 'pr', key: 'acme/acme-widget#43', url: PR43, repo: 'acme/acme-widget', action_run: ['write'], action_tree: ['write'] }],
  outcome_signals: subSignals, risk_signals: [], milestones: [{ seq: 3, signals: ['pr_created'] }], det_tags: [],
  subtree: { n_runs: 1, agent_ids: [SUB_AGENT], children: [], children_spawned: 0, children_joined: 0, outcome_signals: subSignals, n_tool_calls: sub.spans.length },
  unit: { item_id: SUB, kind: 'subagent', parent_session_id: MAIN, window: null, outcome_signals: subSignals, outcome_scope: 'the run and every descendant run (subtree)' },
});

// ------------------------------------------------------------------ references (hand-written labels)
const refMain = {
  item_id: MAIN,
  decision_candidates: [
    { decision_text: 'Every acme-widget CI job runs on the self-hosted fleet-x runner, never on a hosted runner.', decided_by: 'tainan', domain: 'infra', risk: 6,
      risk_reason: 'A CI runner rule that every job of the repository follows.', reversible: 'yes', authorization: 'explicit', authorization_ref: 'm4', evidence_pointer: 'm4' },
    { decision_text: 'Merge PR 42 with safe-merge after every check is green on the head commit.', decided_by: 'agent', domain: 'infra', risk: 5,
      risk_reason: 'A merge to main of a CI change; the floor of the merge span is 5.', reversible: 'partly', authorization: 'standing_rule', authorization_ref: 'CI green merge policy', evidence_pointer: 'm6' },
    { decision_text: 'The acme-widget README documents the fleet-x runner.', decided_by: 'tainan', domain: 'infra', risk: 3,
      risk_reason: 'A documentation change by PR.', reversible: 'yes', authorization: 'explicit', authorization_ref: 'm7', evidence_pointer: 'm7' },
  ],
  tainan_corrections: [{ quote: 'não, nada de hosted. usa o runner fleet-x, sempre', topic: 'runner choice: fleet-x instead of a hosted runner', evidence_pointer: 'm4' }],
  classification: { type: 'fix', subtype: 'red-ci', tags: [], outcome: 'landed' },
  domain: 'infra',
  one_line_summary: 'Fixed the red acme-widget CI by moving its jobs to the fleet-x runner, merged PR 42, and spawned a subagent for the README.',
  narrative_summary: 'The human asked to fix the red CI and merge it when green. The agent planned a hosted runner, the human overruled it with fleet-x, and the agent changed the pipeline, opened PR 42 and merged it on green checks. It then spawned a subagent to document the runner in the README.',
  task_intent: { asked: 'Fix the red acme-widget CI on main and merge the fix when it is green.', capability: 'ci-repair', difficulty: 2, cheaper_model_could_do: 'partly',
    cheaper_model_why: 'The log read and the edit are simple; the runner choice needed the human correction.' },
  intent_labels: { 'ci-cli logs + tail': 'ci-read', 'git-cli pr create': 'pr-write/merge', 'acme-checks wait': 'ci-watch/poll', 'ssh + df': 'ops-inspect' },
};
const refSub = {
  item_id: SUB,
  decision_candidates: [
    { decision_text: 'The acme-widget README documents the fleet-x runner under the CI heading.', decided_by: 'tainan', domain: 'infra', risk: 3,
      risk_reason: 'A documentation change by PR.', reversible: 'yes', authorization: 'explicit', authorization_ref: 'm1', evidence_pointer: 'm1' },
  ],
  tainan_corrections: [],
  classification: { type: 'content', subtype: 'doc-deck', tags: ['handoff'], outcome: 'partial' },
  domain: 'infra',
  one_line_summary: 'Added the fleet-x runner line to the acme-widget README and opened PR 43; the parent merges it.',
  narrative_summary: 'The brief asked for one README line about the fleet-x runner and one PR. The agent edited README.md, pushed a branch and opened PR 43. It left the merge to the parent, as the brief said.',
  task_intent: { asked: 'Add one README line about the fleet-x runner and open one PR.', capability: 'writing', difficulty: 1, cheaper_model_could_do: 'yes',
    cheaper_model_why: 'One known file, one line, one PR.' },
  intent_labels: { 'git-cli pr create': 'pr-write/merge' },
};

// ------------------------------------------------------------------ write
const tmp = mkdtempSync(join(tmpdir(), 'sdte-synth-'));
const node = (args) => { const r = spawnSync(process.execPath, args, { encoding: 'utf8' }); if (r.status !== 0) { console.error(r.stderr); process.exit(1); } };
const json = (o) => `${JSON.stringify(o, null, 2)}\n`;
function emit(run, l1, id, dir, extra = []) {
  mkdirSync(dir, { recursive: true });
  const raw = join(tmp, `${id}.jsonl`);
  writeFileSync(raw, run.rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(dir, 'layer1.json'), json(l1));
  node([join(TOOLS, 'shape-list.mjs'), '--layer1', join(dir, 'layer1.json'), '--out', join(dir, 'shapes.json')]);
  node([join(TOOLS, 'condensed-view.mjs'), '--jsonl', raw, '--layer1', join(dir, 'layer1.json'), '--item-id', id, '--kind', run.kind, ...extra,
    '--out', join(dir, 'item.txt'), '--stats', join(tmp, `${id}.stats.json`)]);
  const st = JSON.parse(readFileSync(join(tmp, `${id}.stats.json`), 'utf8'));
  if (!st.layer1_aligned) { console.error(`${id}: layer-1 spans do not align with the transcript`); process.exit(1); }
}
try {
  emit(main, L1main, MAIN, join(ROOT, 'environment'));
  const subDir = join(ROOT, 'fixtures/synthetic', SUB);
  emit(sub, L1sub, SUB, subDir, ['--parent', MAIN]);
  writeFileSync(join(ROOT, 'tests/hidden/reference.json'), json(refMain));
  writeFileSync(join(subDir, 'reference.json'), json(refSub));
  const sol = json(refMain);
  writeFileSync(join(ROOT, 'solution/judgment.json'), sol);
  const lines = sol.slice(0, -1).split('\n');
  writeFileSync(join(ROOT, 'solution/solution.patch'), ['diff --git a/out/judgment.json b/out/judgment.json', 'new file mode 100644', '--- /dev/null', '+++ b/out/judgment.json', `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ''].join('\n'));
  console.log(`make-synthetic: wrote the open variant ${MAIN} and the subagent fixture ${SUB}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

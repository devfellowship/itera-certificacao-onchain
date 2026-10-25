# Taxonomy v2 — classification (closed lists; a value outside them fails the gate)

type → subtype (pick the pair that describes the MAIN work of this unit):
- fix → red-ci | prod-bug | test | build | config
- build → feature | skill | mcp-tool | service | refactor | schema-migration
- ops → deploy | merge-pr | merge-round | credential | vps-config | watch-monitor | data-repair | batch-job
- plan → write-plan | revise-plan | questions | adr
- research → codebase | web | measure-audit | prod-investigation | bakeoff-eval
- verify → prod-verify | ci-check | pr-review
- content → report-html | doc-deck | media | lesson | campaign | book
- talk → conversation | status-report | dispatch

Notes: ops/merge-round = an orchestrator that fans out children (one PR each) and checks their merges. research/prod-investigation = a read-only diagnosis of a production fault. talk/dispatch = a main-thread chunk that answers Tainan and spawns subagents.

tags (judged; 0–7, only these): rework (the work redid earlier work) | urgent (the human or brief says urgent / prod is down) | exploratory (the goal was unclear at the start) | handoff (the unit ends by passing open work to another agent or human) | multi-repo (writes in 2+ repos) | user-facing (end users see the change) | cost-sensitive (tokens, quota or money drove a choice). Layer 1 adds the deterministic tags; do not repeat them.

outcome: landed (a merge, deploy, publish or a write to main/prod happened — needs a merge, publish or deploy signal in LAYER1) | partial (some of the asked work landed, the rest did not) | blocked (stopped on a human, a decision, a failure, CI) | abandoned (dropped) | talk_only (nothing was built or changed). LAYER1 outcome signals win: a unit with a merge signal is never talk_only.

domain (closed): financing | itera | amb-hq | infra | book | dfl-app | harness | other. harness = skills, hooks, CLAUDE.md, agent plumbing, transcript mining. infra = VPS, Docker, CI runners, Traefik, deploys. dfl-app = DFL product surfaces (learn, work, payments, quiz, events, studio, plans app).

task_intent.capability (closed): code-fix | code-feature | ci-repair | planning | research | ops-deploy | data-repair | writing | review-verify | orchestration. difficulty 1–5: 1 = a lookup or one command; 2 = a small change on a clear path; 3 = several steps or files, some judgment; 4 = cross-module or unclear spec, real debugging; 5 = novel design or a hard production fault. cheaper_model_could_do: yes | partly | no, and cheaper_model_why says which steps need the stronger model (or why none do).
